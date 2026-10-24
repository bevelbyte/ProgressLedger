// IPC sender origin allow-list (pure primitive).
//
// Every ipcMain invoke carries an IpcMainInvokeEvent whose senderFrame.url
// identifies the frame that issued the message. This module deliberately
// compares parsed protocol/host/port values rather than URL prefixes: a
// prefix check such as `http://localhost:5173` would also accept an attacker
// controlled URL such as `http://localhost:51730`.

export const DEFAULT_IPC_ALLOW_LIST = Object.freeze([
  "progressledger-v2://app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function matchesAllowedOrigin(url, allowed) {
  if (typeof allowed !== "string") return false;

  const expected = parseUrl(allowed);
  if (!expected) return false;

  return url.protocol === expected.protocol
    && url.hostname === expected.hostname
    && url.port === expected.port;
}

/**
 * Verify that event.senderFrame.url belongs to a trusted renderer origin.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {object} [opts]
 * @param {string[]} [opts.allowList]
 * @param {boolean} [opts.skipForTests=false]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyIpcSender(event, opts = {}) {
  if (opts.skipForTests === true) return { ok: true };

  const allowList = Array.isArray(opts.allowList) && opts.allowList.length > 0
    ? opts.allowList
    : DEFAULT_IPC_ALLOW_LIST;

  const frame = event && event.senderFrame;
  if (!frame) return { ok: false, reason: "unknown-origin" };
  if (frame.parent != null || frame.top != null && frame.top !== frame) {
    return { ok: false, reason: "untrusted-frame" };
  }
  const url = typeof frame.url === "string" ? parseUrl(frame.url) : null;
  if (!url) return { ok: false, reason: "unknown-origin" };

  if (allowList.some((allowed) => matchesAllowedOrigin(url, allowed))) {
    return { ok: true };
  }

  return { ok: false, reason: "unknown-origin" };
}
