// Project Mode — provider credentials store.
//
// The API key + endpoint + model for each (profileId, projectId) pair
// is kept in a JSON file inside the userData directory. The file lives
// on the same machine as the user and is protected by Electron's
// process boundary; it is NEVER returned to the renderer (the IPC
// layer strips the key before sending `get-provider-config` back).
//
// Storage shape:
//   {
//     "<profileId>:<projectId>": {
//       endpoint: "https://api.openai.com",
//       apiKey:   "<plaintext>",
//       model:    "gpt-4o-mini",
//       updatedAt: 1700000000000
//     },
//     ...
//   }
//
// SECURITY
// --------
// - The credential is stored in plaintext on disk (encrypted-at-rest is
//   out of scope per the brief). The file lives under the Electron
//   `userData` path which is OS-protected.
// - readProviderConfig() is the only way the agent loop / IPC layer
//   sees the key. It is never logged, never returned to a renderer
//   boundary, and never serialised into an error message.
// - The IPC handler `project:get-provider-config` MUST call
//   readProviderConfig(...) and strip `apiKey` before sending back the
//   response. The IPC layer also reports `hasKey: boolean`.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const MAX_API_KEY_LEN = 200;
export const MAX_ENDPOINT_LEN = 200;
export const MAX_MODEL_LEN = 200;

// Tiny URL scheme validator: http/https only. Rejects `javascript:`,
// `file:`, and friends. We do not require DNS to resolve; we only
// require the prefix to be one of the two allowed schemes.
export function validateEndpoint(endpoint) {
  if (typeof endpoint !== "string") return null;
  const trimmed = endpoint.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ENDPOINT_LEN) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  // Reject control characters / whitespace inside the URL.
  if (/[\s\r\n\t]/.test(trimmed)) return null;
  return trimmed;
}

export function validateApiKey(key) {
  if (typeof key !== "string") return null;
  if (key.length === 0 || key.length > MAX_API_KEY_LEN) return null;
  // Reject control characters.
  if (/[\r\n\t]/.test(key)) return null;
  return key;
}

export function validateModel(model) {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MODEL_LEN) return null;
  return trimmed;
}

/**
 * Construct a credentials store bound to a particular `userData` dir.
 *
 * @param {string} userDataDir  absolute path (e.g. the Electron `userData` path)
 */
export function createCredentialsStore({ userDataDir }) {
  if (typeof userDataDir !== "string" || !userDataDir) {
    throw new Error("credentials: userDataDir required");
  }
  const file = join(userDataDir, "pm-secrets.json");

  function readAll() {
    if (!existsSync(file)) {
      lastReadDiagnostic = null;
      return {};
    }
    try {
      const raw = readFileSync(file, "utf8");
      if (!raw.trim()) {
        // Genuinely empty store — not malformed. Keep the historical
        // "nothing stored" semantics with no diagnostic.
        lastReadDiagnostic = null;
        return {};
      }
      // Strip a UTF-8 BOM if present: editors on Windows (Notepad,
      // PowerShell `Out-File`) commonly write one, and JSON.parse
      // rejects it. This makes BOM'd valid stores load normally.
      const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        lastReadDiagnostic = null;
        return parsed;
      }
      // Parses but wrong shape (array/primitive) — classify malformed.
      // Sanitized: contains the reason only, never file content.
      lastReadDiagnostic = { code: "credential-store-malformed", reason: "not-an-object" };
      return {};
    } catch (_e) {
      // Corrupted/unparseable store. Historical behavior returned {}
      // silently, which is indistinguishable from "no credential" and
      // made the agent silently fall back to the mock provider with no
      // operator-visible cause. Now: empty view + structured sanitized
      // diagnostic (reason only — NEVER file content or field values).
      lastReadDiagnostic = { code: "credential-store-malformed", reason: "unparseable-json" };
      return {};
    }
  }

  /**
   * Sanitized diagnostic for the LAST readAll():
   *   null                          — store is fine (or absent/empty)
   *   { code, reason }              — malformed store; no content, no
   *                                   field values, no file bytes.
   * Main-process-only introspection for the IPC layer / audit trail.
   */
  function diagnostic() {
    return lastReadDiagnostic;
  }

  let lastReadDiagnostic = null;

  function writeAll(obj) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  }

  function key(profileId, projectId) {
    return `${profileId}:${projectId}`;
  }

  return {
    filePath() {
      return file;
    },
    /** Sanitized last-read diagnostic (see `diagnostic`). */
    diagnostic,
    /**
     * Read the stored config. Returns null if the (profile, project)
     * has nothing stored. The returned object includes the plaintext
     * `apiKey` — this is the main-process-only view; the IPC layer
     * must strip it before sending to the renderer.
     */
    readProviderConfig(profileId, projectId) {
      const all = readAll();
      return all[key(profileId, projectId)] || null;
    },
    /**
     * Persist a new config. Validates every field and refuses to write
     * if any field is invalid.
     *
     * Special case: if `input.apiKey` is the sentinel string "UNCHANGED",
     * the existing key (if any) is preserved. This lets the UI update
     * endpoint + model without forcing the user to retype the key.
     * Returns { ok: true, config } on success or { ok: false, error } on
     * validation failure.
     */
    writeProviderConfig(profileId, projectId, input) {
      const endpoint = validateEndpoint(input && input.endpoint);
      if (!endpoint) return { ok: false, error: "invalid-endpoint" };
      const model = validateModel(input && input.model);
      if (!model) return { ok: false, error: "invalid-model" };

      const all = readAll();
      const existing = all[key(profileId, projectId)] || null;

      let apiKey;
      if (typeof input.apiKey === "string" && input.apiKey === "UNCHANGED" && existing) {
        apiKey = existing.apiKey;
      } else {
        apiKey = validateApiKey(input && input.apiKey);
        if (!apiKey) return { ok: false, error: "invalid-api-key" };
      }

      all[key(profileId, projectId)] = {
        endpoint,
        apiKey,
        model,
        updatedAt: Date.now(),
      };
      writeAll(all);
      return {
        ok: true,
        config: { endpoint, model, hasKey: true },
      };
    },
    /**
     * Remove a (profileId, projectId)'s stored config.
     */
    clearProviderConfig(profileId, projectId) {
      const all = readAll();
      const k = key(profileId, projectId);
      if (k in all) {
        delete all[k];
        writeAll(all);
      }
      return { ok: true };
    },
    /**
     * Render the stored config with the API key stripped. Safe to hand
     * to the renderer. Returns null when nothing is stored.
     */
    readProviderConfigSafe(profileId, projectId) {
      const cfg = this.readProviderConfig(profileId, projectId);
      const diag = diagnostic();
      if (!cfg) {
        // Malformed store: surface the sanitized diagnostic so the
        // operator/UI can see WHY no credential resolved (instead of
        // the store looking simply empty). No secret material, ever.
        if (diag) {
          return { endpoint: null, model: null, hasKey: false, updatedAt: null, diagnostic: diag };
        }
        return null;
      }
      return {
        endpoint: cfg.endpoint,
        model: cfg.model,
        hasKey: typeof cfg.apiKey === "string" && cfg.apiKey.length > 0,
        updatedAt: cfg.updatedAt || null,
      };
    },
    /** Test helper — wipe the file. Not used at runtime. */
    _reset() {
      if (existsSync(file)) {
        writeAll({});
      }
    },
  };
}