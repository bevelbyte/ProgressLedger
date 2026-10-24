// Project-Intelligence-augmented context block.
//
// The agent loop builds a small "context packet" that gets prepended
// to the first user message. This module produces the *project-file*
// slice of that packet: the top-N files that ProjectIntel
// `relevantFiles` ranks against the user's objective, plus a 1-line
// header per file so the model can orient without seeing the full
// file body.
//
// Contract:
//   - Returns `{ packet, fileCount }` where `packet` is the formatted
//     block (already including the "## Project files (relevant)"
//     heading) and `fileCount` is the number of files actually
//     represented in the block.
//   - Returns an empty packet when:
//       * The project has no Project Intelligence index on disk, or the index
//         was built for a different root. `relevantFiles` goes through
//         `getDbForRoot`, which now REOPENS the durable per-project sidecar on
//         a cold read and then compares the index's recorded `meta.rootPath`
//         against the authorized root; a mismatch (or a project that was never
//         indexed) answers `{ ok: false, error: { code: "root-mismatch" } }`.
//       * `maxTokens <= 0`.
//       * No files match the objective.
//       * Every matched file is unreadable / binary.
//   - The header for each file is either:
//       * The first ~10 non-blank lines (for general text files), OR
//       * The export list (regex-driven; JS/TS and Rust), when one is
//         found.
//   - Path safety: each header is gated by an `assertInsideProjectRoot`
//     check so a corrupted index row cannot leak content from outside
//     the project root.

import path from "node:path";
import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { ProjectIntel } from "../project-intel/index.js";
import { assertInsideProjectRoot } from "../project-tools/security.js";

// Maximum bytes we read per file when extracting the header. 1 KiB is
// enough for the first 10 lines of any reasonable source file.
const HEADER_READ_BYTES = 1024;

// Files whose first 1024 bytes start with these byte values are
// treated as binary and skipped silently. We deliberately keep the
// check minimal — better to drop a few headers than read a 50 MB log
// into the agent's first message.
const BINARY_FIRST_BYTES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x0f, 0x1a]);

/**
 * Whitespace-split token approximation. Mirrors the one used by the
 * memory block so the UI sees consistent budgets.
 */
export function tokenEstimate(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Read up to 1024 bytes of `absPath` as utf8. Returns the decoded
 * string, or `null` if the file is unreadable / binary.
 */
function readHeaderBytes(absPath) {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return null;
  }
  if (st.size > 256 * 1024) return null; // anything > 256 KiB is too big to be a normal source file
  let buf;
  try {
    const fd = openSync(absPath, "r");
    try {
      const len = Math.min(HEADER_READ_BYTES, st.size);
      buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (buf.length === 0) return "";
  if (BINARY_FIRST_BYTES.has(buf[0])) return null;
  // Crude binary sniff: any NUL byte in the first 64 bytes → binary.
  for (let i = 0; i < Math.min(64, buf.length); i++) {
    if (buf[i] === 0x00) return null;
  }
  try {
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Extract a 1-line header for the file body. Returns either the
 * first 10 non-blank lines (general text files) or a compact export
 * list (JS/TS/Rust).
 */
function extractHeader(text, ext) {
  if (typeof text !== "string" || text.length === 0) return "(empty file)";
  const e = (ext || "").toLowerCase();

  // Export-style headers (JS/TS and Rust). When a file's primary
  // purpose is to declare symbols, an export list is more useful
  // than the first 10 lines.
  if (e === ".js" || e === ".mjs" || e === ".cjs" || e === ".ts" || e === ".tsx" || e === ".jsx") {
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(/^\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([A-Za-z0-9_$]+)|\s*export\s*\{[^}]+\})/);
      if (m) {
        lines.push(raw.trim());
        if (lines.length >= 6) break;
      }
    }
    if (lines.length > 0) return lines.join(" | ");
  } else if (e === ".rs") {
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(/^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|const|static|type)\s+([A-Za-z0-9_]+)/);
      if (m) {
        lines.push(raw.trim());
        if (lines.length >= 6) break;
      }
    }
    if (lines.length > 0) return lines.join(" | ");
  }

  // Default: first 10 non-blank lines, truncated to 240 chars total.
  const nonBlank = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t.length === 0) continue;
    nonBlank.push(t);
    if (nonBlank.length >= 10) break;
  }
  if (nonBlank.length === 0) return "(empty file)";
  let out = nonBlank.join(" | ");
  if (out.length > 240) out = out.slice(0, 237) + "...";
  return out;
}

/**
 * Build the project-intel context block.
 *
 * @param {object} args
 * @param {number|string} args.projectId
 * @param {string} args.objective
 * @param {string} args.projectRoot    absolute path to the project root
 * @param {number} [args.maxTokens=1500]   cap; 0 disables the block entirely
 * @returns {Promise<{ packet: string, fileCount: number, tokenCount: number }>}
 */
export async function buildProjectIntelBlock({ projectId, objective, projectRoot, maxTokens = 1500 }) {
  const empty = { packet: "", fileCount: 0, tokenCount: 0 };
  if (!projectId || !projectRoot || typeof projectRoot !== "string") return empty;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return empty;
  if (typeof objective !== "string" || objective.trim().length === 0) return empty;

  // Query ProjectIntel. If the cache hasn't been built for this
  // project yet, this returns { ok: false, error: { code:
  // "not-initialized" } } and we degrade gracefully.
  const rel = await ProjectIntel.relevantFiles(0, projectId, objective, 10, projectRoot);
  if (!rel || !rel.ok || !rel.result || !Array.isArray(rel.result.matches)) return empty;
  const matches = rel.result.matches;
  if (matches.length === 0) return empty;

  // Path safety: every candidate's resolved abs path must stay
  // inside projectRoot. We compute absRoot once up front.
  const absRoot = path.resolve(projectRoot);
  const candidates = [];
  for (const m of matches) {
    if (!m || typeof m.path !== "string") continue;
    const absCandidate = path.isAbsolute(m.path) ? path.resolve(m.path) : path.resolve(absRoot, m.path);
    const gate = assertInsideProjectRoot(absCandidate, absRoot);
    if (!gate || !gate.ok) continue;
    candidates.push({ rel: m.path, abs: gate.path, ext: path.extname(m.path).toLowerCase() });
  }
  if (candidates.length === 0) return empty;

  // Build the per-file lines. Each entry: "<rel-path> — <header>".
  const lines = [];
  for (const c of candidates) {
    const text = readHeaderBytes(c.abs);
    if (text == null) continue; // unreadable / binary — skip silently
    const header = extractHeader(text, c.ext);
    lines.push(`- ${c.rel} — ${header}`);
  }
  if (lines.length === 0) return empty;

  // Assemble the packet and trim it to maxTokens. We allow a single
  // pass of whitespace-split truncation that may leave the result
  // up to ~1.1× the cap — acceptable per spec.
  const header = "## Project files (relevant)";
  let kept = lines.slice();
  let packet = `${header}\n${kept.join("\n")}`;
  let tokens = tokenEstimate(packet);
  if (tokens > maxTokens) {
    // Truncate by re-joining the first N lines whose cumulative token
    // count fits. We always keep the heading.
    kept = [];
    let running = tokenEstimate(header);
    for (const ln of lines) {
      const t = tokenEstimate(ln);
      if (running + t > maxTokens * 1.1) break;
      kept.push(ln);
      running += t;
    }
    if (kept.length === 0) {
      // The cap is so tight that even one line doesn't fit — give up
      // on the block rather than corrupt the message.
      return empty;
    }
    packet = `${header}\n${kept.join("\n")}`;
    tokens = tokenEstimate(packet);
  }

  return { packet, fileCount: kept.length, tokenCount: tokens };
}

export const _internals = { readHeaderBytes, extractHeader };