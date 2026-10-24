// Browser permission policy — PURE decision, no electron import.
//
// R2 of the browser security plan. This module answers the ONE question the
// permission handlers must never delegate to a page: "may this CareerFlow
// browser page hold this capability?" Keeping it pure (no electron import)
// follows the repo convention (`browser/policy.js`, `ui/.../workspace/model.js`)
// so a reviewer can assert the deny-by-default table in plain Node, and so the
// installer in `browser/host.js` has exactly one source of truth to consult.
//
// POLICY (approved decision D3-5): DENY BY DEFAULT. A browser page may hold
// only the capabilities on the allow-list below; every hardware/media/device
// permission, every external-handler permission, and any name not explicitly
// listed — including an invented one — is denied. There is deliberately NO
// allow-all path and NO persisted grant: the decision is recomputed on every
// request from the current, main-process-owned context.

/** The capabilities a browser page may always hold. Bounded by design. */
const ALLOWED_EXACT = Object.freeze([
  // The "copy" affordance every page has. It cannot read the clipboard, so it
  // leaks nothing CareerFlow's user did not explicitly copy out of the page.
  "clipboard-sanitized-write",
]);

/**
 * Capabilities allowed ONLY for the active (visible, focused) page of the pane.
 * A background page must never be able to seize the screen, so `fullscreen` is
 * scoped rather than blanket-allowed.
 */
const FOCUSED_ONLY = Object.freeze(["fullscreen"]);

export const PERMISSION_DECISIONS = Object.freeze({
  allow: ALLOWED_EXACT,
  focusedOnly: FOCUSED_ONLY,
});

/**
 * Decide whether `permission` may be granted. Returns a boolean and NEVER
 * throws: an unruly input — including a context object whose property getter
 * throws — degrades to deny, which is the safe direction.
 *
 * The name is compared EXACTLY against the allow-list after trimming surrounding
 * whitespace. Trimming is defensive normalisation of a platform-supplied string
 * (Electron passes its own permission constants, never a page's text), so it can
 * only ever reconcile whitespace — it cannot turn a different capability into an
 * allowed one.
 *
 * @param {unknown} permission  the permission name Chromium asked about
 * @param {{isActiveFocusedPage?: boolean}} [context]
 *   Main-process-owned context. `isActiveFocusedPage` is required for the
 *   focused-only capabilities; anything falsy denies them.
 * @returns {boolean} true = grant, false = deny
 */
export function decidePermission(permission, context = {}) {
  try {
    return decide(permission, context);
  } catch {
    // A context object whose property getter throws is not a reason to grant
    // anything: the documented contract of this function is "never throws",
    // and the only safe answer when a question cannot even be asked is no.
    return false;
  }
}

/** The table itself. Kept separate so the fail-closed wrapper stays honest. */
function decide(permission, context) {
  if (typeof permission !== "string") return false;
  const name = permission.trim();
  if (!name) return false;
  if (ALLOWED_EXACT.includes(name)) return true;
  if (FOCUSED_ONLY.includes(name)) return context.isActiveFocusedPage === true;
  // Default deny: named denials (media, devices, notifications, openExternal,
  // pointerLock, idle-detection, speaker-selection, …) and UNKNOWN names alike.
  return false;
}

/**
 * Install the permission handlers on a browser session. BOTH handlers are
 * installed: `check` is what some APIs consult WITHOUT prompting, so a request
 * handler alone is a half-guard.
 *
 * The installer never lets a handler throw out of main: every decision is
 * wrapped so an exception fails closed to deny.
 *
 * `deps.onDecision` is OPTIONAL and is called with every decision the handlers
 * make. The embedded browser passes one so the shell is told about a denial
 * (`permission-denied` in the event contract) instead of the request simply
 * vanishing: a refusal a person cannot see is indistinguishable from a hang.
 * It is advisory only — nothing in the decision path depends on it.
 *
 * @param {any} session  an Electron `session` (or a fake in tests)
 * @param {{isActiveFocusedPage?: (webContents: any) => boolean,
 *          onDecision?: (d: {permission: string, allowed: boolean}) => void}} [deps]
 * @returns {{requestHandler: Function, checkHandler: Function} | null}
 *   null when the session is missing or cannot take a request handler (so the
 *   caller can REPORT an unwatched session rather than assume it is governed).
 */
export function attachPermissionHandlers(session, deps = {}) {
  if (!session) return null;
  const isActiveFocusedPage = deps.isActiveFocusedPage;
  const onDecision = deps.onDecision;

  const activeFor = (webContents) =>
    typeof isActiveFocusedPage === "function"
      ? isActiveFocusedPage(webContents) === true
      : false;

  const announce = (webContents, permission, allow) => {
    if (typeof onDecision !== "function") return;
    try {
      onDecision({ permission, allowed: allow, webContents });
    } catch {
      /* advisory only */
    }
  };

  const requestHandler = (_webContents, permission, callback) => {
    let allow = false;
    try {
      allow = decidePermission(permission, { isActiveFocusedPage: activeFor(_webContents) });
    } catch {
      allow = false;
    }
    announce(_webContents, permission, allow);
    // Exactly one callback, always. An unruly session must not crash main.
    try {
      callback(allow);
    } catch {
      /* a session that refuses the answer is already not going to get it */
    }
  };

  const checkHandler = (_webContents, permission) => {
    let allow = false;
    try {
      allow = decidePermission(permission, { isActiveFocusedPage: activeFor(_webContents) });
    } catch {
      allow = false;
    }
    announce(_webContents, permission, allow);
    return allow;
  };

  let installed = false;
  try {
    if (typeof session.setPermissionRequestHandler === "function") {
      session.setPermissionRequestHandler(requestHandler);
      installed = true;
    }
  } catch {
    installed = false;
  }
  try {
    session.setPermissionCheckHandler?.(checkHandler);
  } catch {
    /* check is best-effort; the request handler is the load-bearing one */
  }

  return installed ? { requestHandler, checkHandler } : null;
}
