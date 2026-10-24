import { join, dirname } from "node:path";
import { existsSync, renameSync } from "node:fs";
import { mkdir, readdir, stat, rm, appendFile } from "node:fs/promises";

const LOG_FILE = "progress-ledger-v2.log";
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Set by initLogger; everything else derives from it.
let logFilePath = null;

export function logPath() {
  return logFilePath;
}

export function initLogger(path) {
  logFilePath = path;
}

export async function writeLog(level, message, detail = null) {
  if (!logFilePath) return;
  try {
    await mkdir(dirname(logFilePath), { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      message: redactSecrets(message),
      detail: sanitizeLogValue(detail),
    });
    await appendFile(logFilePath, `${line}\n`, "utf8");
  } catch {
    // Logging should never break the app path that generated the log.
  }
}

// Debug IPC tracing can contain legitimate credentials (for example the
// provider API key sent through project:set-provider-config). Sanitize both
// object keys and credential-shaped strings before diagnostics reach disk.
// This stays dependency-free because logger is used during early startup.
const SECRET_KEY_RE = /^(?:api[_-]?key|apikey|authorization|password|passwd|pwd|secret|access[_-]?token|token)$/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk_live_[A-Za-z0-9]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /([?&](?:token|api_key|apikey|secret|secret_key|access_token|password)=)[^&\s"']+/gi,
];

function redactSecrets(value) {
  if (typeof value !== "string") return value;
  return SECRET_VALUE_PATTERNS.reduce((out, pattern) => {
    if (pattern.source.startsWith("([?&]")) return out.replace(pattern, "$1<redacted>");
    if (pattern.source.startsWith("\\bBearer")) return out.replace(pattern, "Bearer <redacted>");
    return out.replace(pattern, (match) => {
      const prefix = match.startsWith("sk_live_")
        ? "sk_live_"
        : match.startsWith("sk-")
          ? "sk-"
          : match.startsWith("ghp_")
            ? "ghp_"
            : "AKIA";
      return `${prefix}<redacted>`;
    });
  }, value);
}

function sanitizeLogValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item, seen));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? "<redacted>" : sanitizeLogValue(child, seen);
  }
  return out;
}

/** Mirror console output into the log file so packaged builds keep diagnostics. */
export function installFileLogger() {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const rendered = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");
      writeLog(level, rendered);
    };
  }
}

export async function rotateAndPruneLogs() {
  if (!logFilePath) return;
  try {
    const logsDir = join(logFilePath, "..");
    if (!existsSync(logsDir)) {
      await mkdir(logsDir, { recursive: true });
    }

    if (existsSync(logFilePath)) {
      const info = await stat(logFilePath);
      if (info.size > MAX_LOG_BYTES) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        renameSync(logFilePath, join(logsDir, `progressledger-${stamp}.log`));
      }
    }

    if (existsSync(logsDir)) {
      const files = await readdir(logsDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith("progressledger-") || !file.endsWith(".log")) continue;
        const filePath = join(logsDir, file);
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > LOG_TTL_MS) {
          await rm(filePath, { force: true });
        }
      }
    }
  } catch (e) {
    console.error("Log rotation failed:", e);
  }
}
