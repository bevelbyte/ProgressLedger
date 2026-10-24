// Managed downloads for the CareerFlow-owned embedded browser.
// Approved decision D: downloads land in `<workspace>/downloads`.
//
// WHAT THIS IS. One manager instance watches the session(s) a CareerFlow browser
// view actually uses and decides, for every incoming download, (a) whether it may
// happen at all, (b) what safe NAME it gets, (c) which absolute path inside the
// managed directory it is written to, and (d) when it stops. It is the only place
// in the browser surface that names a file.
//
// SECURITY POSTURE (each line is a decision, not an inherited default):
//
//   * The PAGE chooses a name, never a directory. `sanitizeDownloadFilename`
//     reduces whatever the site suggests to a single path segment and
//     `resolveDownloadTarget` re-checks containment on the RESOLVED path, so a
//     sanitizer bug cannot become a write outside the directory.
//   * FAIL CLOSED. No managed directory, an unsafe name, a path that leaves the
//     directory, or too many concurrent downloads all mean the download is
//     CANCELLED with a stated reason. There is no "fall back to the OS download
//     folder" path, because that would be an uncontrolled write.
//   * NOTHING IS EVER OPENED. `setOpenWhenDone` is never called and this module
//     does not import `shell` at all: a downloaded file is inert until the user
//     chooses to open it somewhere that is not a web page's decision.
//     (Asserted by a source-scan test; see shell/tests/browser-downloads.test.js.)
//   * The renderer gets an OPAQUE id (`dl-N`), the safe base name, byte counts and
//     a sanitized source URL. It never gets an absolute path, so a compromised
//     renderer cannot use the download list as a filesystem oracle.
//   * Concurrency is bounded (`MAX_CONCURRENT_DOWNLOADS`) and the record list is
//     bounded too, so neither the disk nor memory can be flooded by a page that
//     loops `location = "..."`.
//   * The session watched is the browser partition's own session. Web content
//     never runs in `session.defaultSession` (it carries the app CSP injection
//     and the privileged `careerflow://` origin), so this can never observe or
//     redirect an application download.
//
// SCOPE. This is the runtime/security foundation only. There is deliberately no
// download-manager UI here: the renderer chrome for downloads is a later phase.

import {
  MAX_CONCURRENT_DOWNLOADS,
  resolveDownloadTarget,
  sanitizeDisplayUrl,
} from "./policy.js";

/** Terminal and non-terminal states a managed download may be in. */
export const DOWNLOAD_STATES = Object.freeze({
  PROGRESSING: "progressing",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
  REFUSED: "refused",
});

/** Reasons a download never starts. Mirrors policy.js where it can. */
export const DOWNLOAD_REASONS = Object.freeze({
  NO_DIR: "no-downloads-dir",
  UNSAFE_NAME: "unsafe-filename",
  NOT_CONTAINED: "not-contained",
  TOO_MANY: "too-many-downloads",
  NO_ROOM: "too-many-collisions",
  SAVE_PATH_FAILED: "save-path-failed",
});

/** How many records are retained. A page cannot grow this without bound. */
const MAX_RECORDS = 50;

/**
 * @param {object} deps
 * @param {() => string|null} deps.getDir  the managed downloads directory
 * @param {(dir: string) => void} [deps.ensureDir]  create it if missing
 * @param {(path: string) => boolean} [deps.exists]  collision predicate
 * @param {(event: object) => void} [deps.emit]  sanitized push to the renderer
 * @param {number} [deps.maxConcurrent]
 * @param {() => number} [deps.now]
 */
export function createDownloadManager(deps = {}) {
  const {
    getDir,
    ensureDir = () => {},
    exists = () => false,
    emit = () => {},
    maxConcurrent = MAX_CONCURRENT_DOWNLOADS,
    maxRecords = MAX_RECORDS,
    now = () => Date.now(),
  } = deps;

  /** Internal records; they hold the live item and the real path. NEVER exposed. */
  const records = new Map();
  /** Sessions already wired, so one session cannot produce two handlers. */
  const sessions = new Set();
  let sequence = 0;

  function activeCount() {
    let n = 0;
    for (const record of records.values()) {
      if (record.state === DOWNLOAD_STATES.PROGRESSING) n += 1;
    }
    return n;
  }

  /** Drop the oldest finished records once the bound is reached. */
  function prune() {
    if (records.size <= maxRecords) return;
    const finished = [...records.values()]
      .filter((r) => r.state !== DOWNLOAD_STATES.PROGRESSING)
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    for (const record of finished) {
      if (records.size <= maxRecords) break;
      records.delete(record.id);
    }
  }

  function push(event) {
    try {
      emit(event);
    } catch {
      // A push must never break a download: the renderer mirror is disposable.
    }
  }

  /** The renderer-safe projection. No path, no item, no session. */
  function project(record) {
    return {
      id: record.id,
      filename: record.filename,
      state: record.state,
      receivedBytes: record.receivedBytes,
      totalBytes: record.totalBytes,
      url: record.url,
      reason: record.reason ?? null,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? null,
    };
  }

  function finish(record, state) {
    record.state = state;
    record.finishedAt = now();
    record.receivedBytes = readBytes(record.item, "getReceivedBytes", record.receivedBytes);
    record.totalBytes = readBytes(record.item, "getTotalBytes", record.totalBytes);
    push({
      kind: "download-done",
      downloadId: record.id,
      filename: record.filename,
      state,
    });
    prune();
  }

  function readBytes(item, method, fallback) {
    try {
      const value = item?.[method]?.();
      return Number.isFinite(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Refuse a download. The item is cancelled, so nothing is written anywhere:
   * a refusal is a cancellation, never an "accept somewhere else".
   */
  function refuse(item, id, filename, reason, url) {
    try {
      item?.cancel?.();
    } catch {
      // A refusal that cannot cancel still must not proceed to a save path.
    }
    const record = {
      id,
      item: null,
      filename,
      state: DOWNLOAD_STATES.REFUSED,
      receivedBytes: 0,
      totalBytes: 0,
      url,
      reason,
      startedAt: now(),
      finishedAt: now(),
    };
    records.set(id, record);
    push({ kind: "download-refused", downloadId: id, filename, reason });
    prune();
    return { ok: false, reason, downloadId: id };
  }

  function begin(item) {
    sequence += 1;
    const id = `dl-${sequence}`;
    const requested = typeof item?.getFilename === "function" ? item.getFilename() : "";
    const url = typeof item?.getURL === "function" ? item.getURL() : "";
    const safeUrl = sanitizeDisplayUrl(url);

    // (a) Is there a managed directory at all? No directory means no download.
    let dir = null;
    try {
      dir = typeof getDir === "function" ? getDir() : null;
    } catch {
      dir = null;
    }
    if (!dir) {
      return refuse(item, id, plannableName(requested), DOWNLOAD_REASONS.NO_DIR, safeUrl);
    }

    // (b) Is the page under its concurrency budget?
    if (activeCount() >= maxConcurrent) {
      return refuse(item, id, plannableName(requested), DOWNLOAD_REASONS.TOO_MANY, safeUrl);
    }

    // (c) Sanitize, resolve, and re-check containment.
    const target = resolveDownloadTarget({ dir, filename: requested, exists });
    if (!target.ok) {
      return refuse(item, id, plannableName(requested), target.reason, safeUrl);
    }

    try {
      ensureDir(dir);
    } catch {
      // A directory that cannot be created is a refusal, not a silent retry.
      return refuse(item, id, target.filename, DOWNLOAD_REASONS.NO_DIR, safeUrl);
    }

    // (d) Commit the destination. This is the ONLY write authority in the
    //     browser surface, and it is always inside the managed directory.
    try {
      item.setSavePath(target.path);
    } catch {
      return refuse(item, id, target.filename, DOWNLOAD_REASONS.SAVE_PATH_FAILED, safeUrl);
    }

    const record = {
      id,
      item,
      filename: target.filename,
      state: DOWNLOAD_STATES.PROGRESSING,
      receivedBytes: 0,
      totalBytes: Number.isFinite(item?.getTotalBytes?.()) ? item.getTotalBytes() : 0,
      url: safeUrl,
      reason: null,
      startedAt: now(),
      finishedAt: null,
    };
    records.set(id, record);

    item?.on?.("updated", () => {
      record.receivedBytes = readBytes(item, "getReceivedBytes", record.receivedBytes);
      record.totalBytes = readBytes(item, "getTotalBytes", record.totalBytes);
      push({
        kind: "download-updated",
        downloadId: id,
        filename: record.filename,
        receivedBytes: record.receivedBytes,
        totalBytes: record.totalBytes,
      });
    });

    item?.on?.("done", (_event, state) => {
      if (state === "completed") finish(record, DOWNLOAD_STATES.COMPLETED);
      else if (state === "cancelled") finish(record, DOWNLOAD_STATES.CANCELLED);
      else finish(record, DOWNLOAD_STATES.INTERRUPTED);
      record.item = null;
    });

    push({
      kind: "download-started",
      downloadId: id,
      filename: record.filename,
      totalBytes: record.totalBytes,
    });
    prune();
    return { ok: true, downloadId: id, filename: record.filename };
  }

  /** The name a refusal is reported under. Best-effort, sanitized either way. */
  function plannableName(requested) {
    const target = resolveDownloadTarget({ dir: ".", filename: requested });
    return target.ok ? target.filename : "";
  }

  /**
   * Watch one session. Idempotent per session, so repeated page creation cannot
   * install the handler twice.
   *
   * @returns {(() => void) | null} a detach function, or NULL when the session
   *   could not be watched at all. Null is a real failure the caller must surface:
   *   an unwatched session would let a download bypass the managed directory, so
   *   "returned a function" is the only success shape.
   */
  function attach(session) {
    if (!session || typeof session.on !== "function") return null;
    if (sessions.has(session)) return () => detach(session);
    const onWillDownload = (_event, item) => begin(item);
    try {
      session.on("will-download", onWillDownload);
    } catch {
      return null;
    }
    sessions.add(session);
    return () => {
      try {
        session.removeListener?.("will-download", onWillDownload);
      } catch {
        // A session that is already gone needs no listener removed.
      }
      sessions.delete(session);
    };
  }

  function detach(session) {
    try {
      session?.removeListener?.("will-download");
    } catch {
      // best effort
    }
    sessions.delete(session);
  }

  return {
    states: DOWNLOAD_STATES,
    reasons: DOWNLOAD_REASONS,
    attach,
    /** Sanitized list for the renderer, newest last. */
    list() {
      return [...records.values()].map(project);
    },
    /** Cancel one managed download by its opaque id. */
    cancel(downloadId) {
      const record = records.get(String(downloadId));
      if (!record) return { ok: false, reason: "unknown-download" };
      if (record.state !== DOWNLOAD_STATES.PROGRESSING) {
        return { ok: false, reason: "not-active", state: record.state };
      }
      try {
        record.item?.cancel?.();
      } catch {
        return { ok: false, reason: "cancel-failed" };
      }
      return { ok: true };
    },
    activeCount,
    /** Cancel everything in flight and stop watching. Used on quit. */
    dispose() {
      for (const record of records.values()) {
        if (record.state !== DOWNLOAD_STATES.PROGRESSING) continue;
        try {
          record.item?.cancel?.();
        } catch {
          // best effort during teardown
        }
        record.state = DOWNLOAD_STATES.CANCELLED;
        record.finishedAt = now();
        record.item = null;
      }
      for (const session of [...sessions]) detach(session);
      sessions.clear();
      return { ok: true };
    },
  };
}
