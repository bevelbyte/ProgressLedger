// Bridge: structured Rust napi errors -> friendly toasts.
//
// Rust fails with a JSON envelope encoded into napi::Error.reason
// (see core/src/errors.rs): {"code","message","detail"}. Over Electron IPC that
// arrives as `error.message`, usually wrapped:
//   "Error invoking remote method 'profiles:add': Error: {"code":"DB_CONSTRAINT",...}"
// parseError() tolerates that wrapper and falls back gracefully for plain errors.

import { toast } from "../stores/toasts.svelte.js";

// Keep codes in sync with core/src/errors.rs `mod codes`.
const CODE_COPY = {
  DB_CONSTRAINT: { title: "Already exists", type: "error" },
  DB_NOT_INITIALIZED: { title: "Database not ready", type: "error" },
  DB_ERROR: { title: "Database error", type: "error" },
  IO_ERROR: { title: "File error", type: "error" },
  INTERNAL: { title: "Unexpected error", type: "error" },
};

/**
 * Normalize any caught value into { code, message, detail }.
 * @returns {{code:string, message:string, detail:any}}
 */
export function parseError(e) {
  const raw = typeof e === "string" ? e : e?.message ?? String(e);

  // Try to extract our JSON envelope even when wrapped by Electron's prefix.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      if (obj && typeof obj.code === "string") {
        return { code: obj.code, message: obj.message ?? raw, detail: obj.detail ?? null };
      }
    } catch {
      /* not our envelope — fall through */
    }
  }

  // Plain error: strip Electron / Rust prefixes for a cleaner message.
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^(Error|Uncaught)\s*:\s*/i, "")
    .trim();
  return { code: "UNKNOWN", message: cleaned || "Something went wrong", detail: null };
}

/**
 * Parse a caught error and surface it as a toast with code-aware copy.
 * @returns {{code:string, message:string}}
 */
export function reportError(e, fallbackTitle = "Something went wrong") {
  const { code, message } = parseError(e);
  const meta = CODE_COPY[code] ?? { title: fallbackTitle, type: "error" };
  (meta.type === "warning" ? toast.warning : toast.error)(message, meta.title);
  // Always log the original for debugging.
  console.error(`[${code}]`, e);
  return { code, message };
}
