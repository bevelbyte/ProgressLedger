// Sub-agent output contract.
//
// This module is the SINGLE point that defines how a parent agent
// extracts a structured result from a finished child agent's transcript.
// Every delegate_* tool ultimately funnels through `parseSubAgentResult`
// so the parent can rely on a stable shape regardless of which role
// produced the result.
//
// PURE: no IO, no globals. Tested in isolation in
// tests/agent-subagent-handoff.test.js.
//
// The contract:
//   - transcript is an array of pm_messages (any object with at least
//     `{ role, content, payload_json }`).
//   - we walk BACKWARDS looking for the last `assistant` message whose
//     `content` parses as a JSON object matching the role's expected
//     output shape.
//   - if none matches, we return a fallback object that preserves the
//     raw text so the parent still has something to consume.
//
// Role-specific field sets are intentionally minimal — we accept any
// keys the model produced and pass them through. The delegate_*
// definitions in `project-tools/_roles.js` document the canonical shapes.

const ROLES = Object.freeze(["researcher", "coder", "tester", "reviewer"]);

// Default structured shape per role. Used both for the well-formed
// return value (when the model produced matching JSON) and as a hint
// when the fallback kicks in.
const DEFAULT_SHAPES = Object.freeze({
  researcher: { summary: "", findings: [], cited_files: [] },
  coder: { files_changed: [], summary: "", notes: "" },
  tester: { exit_code: 0, stdout_tail: "", stderr_tail: "", passed: false },
  reviewer: { files_changed: [], findings: "", recommendations: [] },
});

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeJsonParse(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Return the last `assistant` row in the transcript, or null if none
 * exists. The parser only consults the LAST assistant message — an
 * earlier assistant message with valid JSON is NOT used as the
 * structured result. This matches the documented contract: if the
 * child's final reply was prose, the fallback path engages.
 */
function lastAssistantMessage(transcript) {
  if (!Array.isArray(transcript)) return null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m && m.role === "assistant") return m;
  }
  return null;
}

/**
 * Walk the transcript backwards and return the raw content of the
 * last `assistant` row (whether or not it parses as JSON). Returns
 * an empty string if no assistant message exists.
 */
function lastAssistantText(transcript) {
  if (!Array.isArray(transcript)) return "";
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (!m || m.role !== "assistant") continue;
    return typeof m.content === "string" ? m.content : "";
  }
  return "";
}

/**
 * Return the raw text content of the last message in the transcript,
 * regardless of role. Used as the ultimate fallback.
 */
function lastAnyText(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return "";
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m && typeof m.content === "string" && m.content.length > 0) return m.content;
  }
  return "";
}

/**
 * Parse a child's transcript into a structured result.
 *
 * @param {Array} transcript  the child's pm_messages array (or any
 *                            array of { role, content, payload_json })
 * @param {string} role       one of "researcher" | "coder" | "tester"
 *                            | "reviewer". Unknown roles fall back to
 *                            the generic shape.
 * @returns {{
 *   summary: string,
 *   role: string,
 *   structured: boolean,
 *   files_changed?: string[],
 *   findings?: any[],
 *   recommendations?: string[],
 *   cited_files?: string[],
 *   notes?: string,
 *   exit_code?: number,
 *   stdout_tail?: string,
 *   stderr_tail?: string,
 *   passed?: boolean,
 *   raw?: string,
 *   defaultShape?: object,
 * }}
 *
 * Resolution order:
 *   1. If the last `assistant` message parses as a JSON object, return
 *      it merged on top of the role's default shape, with `structured:
 *      true` and `summary` lifted from the most common summary-like
 *      field if present.
 *   2. Otherwise fall back to `{ summary: <raw text>, files_changed:
 *      [], structured: false }` so the parent still has something to
 *      consume.
 */
export function parseSubAgentResult(transcript, role) {
  const safeRole = typeof role === "string" && ROLES.includes(role) ? role : null;
  const defaults = safeRole ? DEFAULT_SHAPES[safeRole] : { summary: "" };
  const lastAssistant = lastAssistantMessage(transcript);
  const lastText = typeof lastAssistant?.content === "string" ? lastAssistant.content : "";
  const lastAny = lastAnyText(transcript);

  // Only the LAST assistant message is consulted. If it does not parse
  // as a JSON object, we fall back to the raw text — even if an earlier
  // assistant message had valid JSON. This matches the documented
  // contract: the child's FINAL reply is what the parent consumes.
  const parsed = lastAssistant ? safeJsonParse(lastAssistant.content) : null;
  if (isObject(parsed)) {
    const merged = Object.assign({}, defaults, parsed);
    // Ensure `summary` always exists; lift from common aliases if the
    // model used a synonym (notes, message, etc.) so the parent's
    // renderer does not have to special-case.
    if (typeof merged.summary !== "string" || merged.summary.length === 0) {
      const lifted = parsed.summary || parsed.notes || parsed.message || parsed.text || "";
      if (typeof lifted === "string") merged.summary = lifted;
    }
    // Always normalise `files_changed` to an array of strings so the
    // parent's tool_result view does not have to defensively check.
    if ("files_changed" in merged && !Array.isArray(merged.files_changed)) {
      merged.files_changed = [];
    }
    merged.role = safeRole || "";
    merged.structured = true;
    if (!("defaultShape" in merged)) merged.defaultShape = defaults;
    return merged;
  }

  // Fallback. We prefer the last assistant text, falling back to the
    // last message of any role, so the parent never gets an empty
    // summary when SOMETHING was returned.
  const fallbackText = lastText || lastAny || "";
  const out = Object.assign({}, defaults, {
    summary: fallbackText,
    files_changed: [],
    role: safeRole || "",
    structured: false,
    raw: fallbackText,
    defaultShape: defaults,
  });
  return out;
}

/**
 * Re-export the role list + default shapes for tests and callers that
 * want to inspect the contract without re-deriving it.
 */
export const SUBAGENT_ROLES = ROLES;
export const SUBAGENT_DEFAULT_SHAPES = DEFAULT_SHAPES;