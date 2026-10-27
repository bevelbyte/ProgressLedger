// Address-bar input resolution — PURE and SELF-CONTAINED: no Electron,
// no Svelte, and no import from the shell tree (the UI bundle cannot
// import outside its own root, so the two URL rules below mirror
// shell/src/services/browser/policy.js's isAllowedUrl by construction:
// parse, http(s) only, hostname present).
//
// The address bar used to accept only a full http(s) URL: plain text was
// refused as invalid-url, so there was no search engine at all. This
// module turns typed input into exactly one of:
//   - a URL the user typed (full http(s) URL, or a bare host inferred
//     as https, the same inference the old normalizeTarget did), or
//   - a search URL for the chosen engine (the default is DuckDuckGo).
//
// Security shape, kept deliberately narrow:
//   - Only http(s) URLs are ever produced. A `javascript:` or `data:` or
//     credentialed (`user:pass@host`) input never becomes a navigation: it
//     falls through to a search query, which is inert text inside an https
//     search URL. A local file reference is refused outright with a message
//     (see isLocalFileInput): it is neither searched nor loaded as file:.
//     Only the Open file dialog opens local files.
//   - Input is bounded (4096 chars, the same cap as the navigation
//     policy) and trimmed. An empty input is refused, never searched.
//   - No fingerprint spoofing and no evasion of bot checks: choosing a
//     search engine is a user preference, and the engine URLs below are
//     the engines' ordinary public search endpoints.

export const SEARCH_ENGINES = Object.freeze({
  duckduckgo: Object.freeze({ label: "DuckDuckGo", searchUrl: "https://duckduckgo.com/?q=" }),
  bing: Object.freeze({ label: "Bing", searchUrl: "https://www.bing.com/search?q=" }),
  google: Object.freeze({ label: "Google", searchUrl: "https://www.google.com/search?q=" }),
});

export const DEFAULT_SEARCH_ENGINE = "duckduckgo";

export const ADDRESS_BAR_REASONS = Object.freeze({
  EMPTY: "empty-url",
  INVALID: "invalid-url",
  // A local file path, not a web address: refused with a message that
  // points at Open file, never searched and never loaded as file:.
  LOCAL_FILE: "local-file",
});

/**
 * Where the chosen engine lives. A plain localStorage key, the same
 * mechanism the diagnostics toggles and the active profile already use
 * for UI preferences: the setting is read fresh on every address-bar
 * submit, so changing it in Settings takes effect without a reload,
 * and it never reaches main or the database.
 */
export const SEARCH_ENGINE_STORAGE_KEY = "progressledger_v2_search_engine";

/**
 * Read the stored engine id, falling back to the default for a missing,
 * unknown, or unreadable value. `storage` is injected so tests can pass
 * a fake; the app passes localStorage.
 */
export function readSearchEngineId(storage) {
  try {
    const raw = storage?.getItem?.(SEARCH_ENGINE_STORAGE_KEY);
    if (typeof raw === "string" && SEARCH_ENGINES[raw]) return raw;
  } catch {
    // Storage unavailable (or hostile): the default is the safe answer.
  }
  return DEFAULT_SEARCH_ENGINE;
}

/** The navigation gate's rule, mirrored from policy.js's isAllowedUrl. */
function isDirectUrl(trimmed) {
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  return url.toString();
}
function looksLikeHost(trimmed) {
  if (/\s/.test(trimmed)) return false;
  if (trimmed.startsWith("localhost")) {
    const rest = trimmed.slice("localhost".length);
    return rest === "" || rest.startsWith(":") || rest.startsWith("/");
  }
  // A dot with something on both sides: example.com, sub.example.co.uk.
  // A single word with no dot ("cats") is a search, never a host.
  const dot = trimmed.indexOf(".");
  return dot > 0 && dot < trimmed.length - 1;
}

/**
 * Is this a local file reference rather than a web address or a question?
 * A file: scheme in any form, a file/ prefix, a Windows drive path, or a
 * UNC path. A bare dotted word ("file.pdf") is NOT one: with no scheme,
 * drive, or slash it is a host inference like any other, and the bare-host
 * rule below still owns it.
 */
function isLocalFileInput(trimmed) {
  if (/^file:/i.test(trimmed)) return true;
  if (/^file\//i.test(trimmed)) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith("\\\\")) return true;
  return false;
}
/**
 * @param {unknown} raw what the user typed
 * @param {unknown} engineId "duckduckgo" | "bing" | "google" (anything else falls back to the default)
 * @returns {{ok: true, kind: "url", url: string} | {ok: true, kind: "search", url: string, query: string} | {ok: false, reason: string, message?: string}}
 */
export function resolveAddressBarInput(raw, engineId = DEFAULT_SEARCH_ENGINE) {
  if (typeof raw !== "string") return { ok: false, reason: ADDRESS_BAR_REASONS.INVALID };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: ADDRESS_BAR_REASONS.EMPTY };
  if (trimmed.length > 4096) return { ok: false, reason: ADDRESS_BAR_REASONS.INVALID };
  if (trimmed === "about:blank") return { ok: true, kind: "url", url: trimmed };

  // A full URL the user typed, exactly as the navigation gate allows it.
  const direct = isDirectUrl(trimmed);
  if (direct) return { ok: true, kind: "url", url: direct };

  // A local file path is NOT a web address, and it must never reach the
  // host inference below: "file///C:/.../report.pdf" looks like a host
  // to looksLikeHost (the ".pdf" dot satisfies it) and used to come out
  // as the bogus https://file///C:/... navigation. Refuse it with a
  // message that points at Open file. Typed file: addresses stay
  // refused by the same rule; only the dialog opens local files.
  if (isLocalFileInput(trimmed)) {
    return {
      ok: false,
      reason: ADDRESS_BAR_REASONS.LOCAL_FILE,
      message: "Local files cannot be typed here. Use Open file to choose a file from your computer.",
    };
  }

  // A bare host, inferred as https (never http), with no credentials.
  if (looksLikeHost(trimmed)) {
    try {
      const url = new URL(`https://${trimmed}`);
      if (url.hostname && !url.username && !url.password) {
        return { ok: true, kind: "url", url: url.toString() };
      }
    } catch {
      // Not a host after all: fall through to search.
    }
  }

  // Everything else is a question for the search engine.
  const engine = SEARCH_ENGINES[engineId] ?? SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE];
  return { ok: true, kind: "search", url: engine.searchUrl + encodeURIComponent(trimmed), query: trimmed };
}
