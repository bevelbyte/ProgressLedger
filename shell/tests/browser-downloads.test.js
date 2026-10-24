// Managed downloads for the Progress Ledger-owned embedded browser — approved
// decision D (`<workspace>/downloads`).
//
// WHAT IS PROVEN HERE. That the download foundation is a SECURITY boundary, not
// a convenience: which names are allowed, where a file may land, when a download
// is refused, how many may run at once, and that nothing in this path can open a
// file. The manager is pure enough to drive from plain Node with a fake session
// and a fake DownloadItem, so every refusal is asserted directly rather than
// inferred from a real browser run.
//
// Negative-first, following the repo's convention for security surfaces: each
// hostile case asserts the REFUSAL and its stated reason.
//
// The real-Electron half (a real `will-download` from a real server, and the file
// actually appearing inside `<workspace>/downloads`) belongs to the browser E2E
// layer; this file never claims to cover it.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { createDownloadManager, DOWNLOAD_STATES } from "../src/services/browser/downloads.js";
import { isContainedIn, MAX_CONCURRENT_DOWNLOADS } from "../src/services/browser/policy.js";

// -------------------------------------------------------------------- helpers

const DIR = path.resolve("ws", "downloads");

/** A DownloadItem stand-in. `setOpenWhenDone` exists so a test can prove it is
 *  NEVER called, rather than merely absent. */
function makeItem({ filename = "file.bin", url = "https://a.test/file.bin", totalBytes = 1000 } = {}) {
  const handlers = new Map();
  return {
    cancelled: false,
    savePath: null,
    openWhenDoneCalls: 0,
    received: 0,
    setSavePath(value) {
      this.savePath = value;
    },
    setOpenWhenDone() {
      this.openWhenDoneCalls += 1;
    },
    getFilename() {
      return filename;
    },
    getURL() {
      return url;
    },
    getTotalBytes() {
      return totalBytes;
    },
    getReceivedBytes() {
      return this.received;
    },
    cancel() {
      this.cancelled = true;
    },
    on(event, cb) {
      handlers.set(event, cb);
    },
    emit(event, ...args) {
      handlers.get(event)?.(...args);
    },
  };
}

function makeSession() {
  const handlers = new Map();
  return {
    on(event, cb) {
      handlers.set(event, cb);
    },
    removeListener(event) {
      handlers.delete(event);
    },
    emit(event, ...args) {
      handlers.get(event)?.(...args);
    },
    handlerCount() {
      return handlers.size;
    },
  };
}

function makeManager(over = {}) {
  const events = [];
  const manager = createDownloadManager({
    getDir: () => DIR,
    ensureDir: () => {},
    exists: () => false,
    emit: (event) => events.push(event),
    ...over,
  });
  return { manager, events };
}

/** Wire a session and hand it one download. */
function start(manager, item, session = makeSession()) {
  manager.attach(session);
  session.emit("will-download", {}, item);
  return session;
}

// ------------------------------------------------------------ 1. normal download

test("a normal download is saved INSIDE the managed directory and completes", async () => {
  const { manager, events } = makeManager();
  const item = makeItem({ filename: "lecture-notes.pdf", totalBytes: 2048 });
  start(manager, item);

  assert.equal(path.dirname(item.savePath), DIR, "the file lands in <workspace>/downloads");
  assert.equal(path.basename(item.savePath), "lecture-notes.pdf");
  assert.equal(isContainedIn(DIR, item.savePath), true);

  const active = manager.list();
  assert.equal(active.length, 1);
  assert.equal(active[0].state, DOWNLOAD_STATES.PROGRESSING);
  assert.match(active[0].id, /^dl-\d+$/, "the renderer sees an opaque id");

  item.received = 2048;
  item.emit("updated", {}, "progressing");
  item.emit("done", {}, "completed");

  const [done] = manager.list();
  assert.equal(done.state, DOWNLOAD_STATES.COMPLETED);
  assert.equal(done.receivedBytes, 2048);
  assert.equal(done.totalBytes, 2048);
  assert.equal(done.reason, null);
  assert.equal(Number.isFinite(done.finishedAt), true);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["download-started", "download-updated", "download-done"],
  );
  assert.equal(manager.activeCount(), 0);
});

// -------------------------------------------------- 2. filenames are sanitized

test("a hostile filename is sanitized before it is ever joined to a path", () => {
  const cases = [
    ["../../../../etc/passwd", "passwd"],
    ["..\\..\\Windows\\System32\\evil.dll", "evil.dll"],
    ["/etc/shadow", "shadow"],
    ["C:\\Temp\\x.exe", "x.exe"],
    ["a/b/../c.txt", "c.txt"],
    ["CON", "_CON"],
    ["lpt9.md", "_lpt9.md"],
    ["report.pdf:payload.exe", "report.pdfpayload.exe"],
    ["evil\u0000\u001f.txt", "evil.txt"],
    ["name.exe. . ", "name.exe"],
  ];
  for (const [requested, expected] of cases) {
    const { manager } = makeManager();
    const item = makeItem({ filename: requested });
    start(manager, item);

    const saved = path.basename(item.savePath);
    assert.equal(saved, expected, `${JSON.stringify(requested)} must save as ${expected}`);
    assert.equal(path.dirname(item.savePath), DIR);
    // The invariant, asserted for every case: still inside the directory.
    assert.equal(isContainedIn(DIR, item.savePath), true);
    // …and the name itself can never carry a separator.
    assert.equal(saved.includes("/"), false);
    assert.equal(saved.includes("\\"), false);
    assert.equal(saved.includes(":"), false, "no alternate-data-stream colon survives");
  }
});

// ------------------------------------------------------ 3. containment + refusal

test("no managed directory is a REFUSAL, not a fallback to the OS download folder", () => {
  const { manager, events } = makeManager({ getDir: () => null });
  const item = makeItem({ filename: "x.pdf" });
  start(manager, item);

  assert.equal(item.cancelled, true, "a refused download must be cancelled");
  assert.equal(item.savePath, null, "no path may be committed when the directory is unknown");
  const [record] = manager.list();
  assert.equal(record.state, DOWNLOAD_STATES.REFUSED);
  assert.equal(record.reason, "no-downloads-dir");
  assert.deepEqual(
    events.map((e) => e.kind),
    ["download-refused"],
  );
});

test("a throwing getDir cannot become an uncontrolled write", () => {
  const { manager } = makeManager({
    getDir: () => {
      throw new Error("no active workspace");
    },
  });
  const item = makeItem({ filename: "x.pdf" });
  start(manager, item);
  assert.equal(item.cancelled, true);
  assert.equal(item.savePath, null);
  assert.equal(manager.list()[0].reason, "no-downloads-dir");
});

test("a directory that cannot be created refuses the download", () => {
  const { manager } = makeManager({
    ensureDir: () => {
      throw new Error("EACCES");
    },
  });
  const item = makeItem({ filename: "x.pdf" });
  start(manager, item);
  assert.equal(item.cancelled, true);
  assert.equal(item.savePath, null);
  assert.equal(manager.list()[0].reason, "no-downloads-dir");
});

test("a refusal never leaves a save path behind, even on an unsafe name", () => {
  const { manager } = makeManager({ getDir: () => null });
  const item = makeItem({ filename: "../../../etc/passwd" });
  start(manager, item);
  assert.equal(item.cancelled, true);
  assert.equal(item.savePath, null);
  // The report still shows a SANITIZED name, so the refusal itself leaks nothing.
  assert.equal(manager.list()[0].filename, "passwd");
});

// ------------------------------------------------------- 4. cancellation, failure

test("cancel() by opaque id stops the item and reports the terminal state", () => {
  const { manager } = makeManager();
  const item = makeItem({ filename: "big.iso" });
  start(manager, item);
  const id = manager.list()[0].id;

  const cancelled = manager.cancel(id);
  assert.equal(cancelled.ok, true);
  assert.equal(item.cancelled, true, "the item itself is cancelled");

  item.emit("done", {}, "cancelled");
  assert.equal(manager.list()[0].state, DOWNLOAD_STATES.CANCELLED);

  // A finished download cannot be cancelled again, and an unknown id is refused.
  assert.equal(manager.cancel(id).reason, "not-active");
  assert.equal(manager.cancel("dl-999").reason, "unknown-download");
});

test("an interrupted download is reported as interrupted, not as a success", () => {
  const { manager, events } = makeManager();
  const item = makeItem({ filename: "flaky.zip" });
  start(manager, item);
  item.emit("done", {}, "interrupted");

  const [record] = manager.list();
  assert.equal(record.state, DOWNLOAD_STATES.INTERRUPTED);
  assert.notEqual(record.state, DOWNLOAD_STATES.COMPLETED);
  assert.equal(events.at(-1).kind, "download-done");
  assert.equal(events.at(-1).state, DOWNLOAD_STATES.INTERRUPTED);
});

test("dispose() cancels everything in flight and stops watching", () => {
  const { manager } = makeManager();
  const session = makeSession();
  const a = makeItem({ filename: "a.bin" });
  const b = makeItem({ filename: "b.bin" });
  start(manager, a, session);
  session.emit("will-download", {}, b);

  assert.equal(manager.activeCount(), 2);
  manager.dispose();
  assert.equal(a.cancelled, true);
  assert.equal(b.cancelled, true);
  assert.equal(manager.activeCount(), 0);
  assert.equal(session.handlerCount(), 0, "the session is no longer watched");
});

// -------------------------------------------------------------- 5. concurrency cap

test("concurrent downloads are bounded; the overflow is refused and cancelled", () => {
  const { manager } = makeManager();
  const session = makeSession();
  manager.attach(session);

  const items = [];
  for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS + 1; i += 1) {
    const item = makeItem({ filename: `f${i}.bin` });
    items.push(item);
    session.emit("will-download", {}, item);
  }

  const allowed = items.slice(0, MAX_CONCURRENT_DOWNLOADS);
  const overflow = items[MAX_CONCURRENT_DOWNLOADS];
  for (const item of allowed) assert.equal(item.cancelled, false, "within budget");
  assert.equal(overflow.cancelled, true, "over budget must be cancelled");
  assert.equal(overflow.savePath, null);

  assert.equal(manager.activeCount(), MAX_CONCURRENT_DOWNLOADS);
  const refused = manager.list().filter((d) => d.state === DOWNLOAD_STATES.REFUSED);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason, "too-many-downloads");

  // A slot freed by a completion lets the next one through.
  allowed[0].emit("done", {}, "completed");
  const next = makeItem({ filename: "after.bin" });
  session.emit("will-download", {}, next);
  assert.equal(next.cancelled, false);
  assert.equal(path.dirname(next.savePath), DIR);
});

test("the record list is bounded, so a page cannot grow it without limit", () => {
  const { manager } = makeManager({ maxRecords: 5 });
  const session = makeSession();
  manager.attach(session);
  for (let i = 0; i < 40; i += 1) {
    const item = makeItem({ filename: `f${i}.bin` });
    session.emit("will-download", {}, item);
    item.emit("done", {}, "completed");
  }
  assert.equal(manager.list().length <= 5, true, `retained ${manager.list().length}`);
});

// ------------------------------------------------------------- 6. attach contract

test("attach is idempotent per session: one handler, one budget", () => {
  const { manager } = makeManager();
  const session = makeSession();
  const first = manager.attach(session);
  const second = manager.attach(session);
  assert.equal(typeof first, "function");
  assert.equal(typeof second, "function");
  assert.equal(session.handlerCount(), 1, "a second page must not install a second handler");

  const item = makeItem({ filename: "a.bin" });
  session.emit("will-download", {}, item);
  assert.equal(manager.list().length, 1, "one session event must produce one download");
});

test("an unwatchable session is reported as null rather than silently ungoverned", () => {
  const { manager } = makeManager();
  assert.equal(manager.attach(null), null);
  assert.equal(manager.attach({}), null, "a session with no .on cannot be watched");
});

// ------------------------------------------- 7. the renderer gets no path, no open

test("the renderer projection carries no path and exactly the intended fields", () => {
  const { manager } = makeManager();
  const item = makeItem({
    filename: "notes.pdf",
    url: "https://a.test/notes.pdf?token=SECRET#frag",
  });
  start(manager, item);

  const [record] = manager.list();
  assert.deepEqual(
    Object.keys(record).sort(),
    ["filename", "finishedAt", "id", "reason", "receivedBytes", "startedAt", "state", "totalBytes", "url"].sort(),
  );
  const flat = JSON.stringify(manager.list());
  assert.equal(flat.includes(DIR), false, "the renderer must never learn the downloads directory");
  assert.equal(flat.includes("token=SECRET"), false, "the source URL is sanitized");
  assert.equal(flat.includes("SECRET"), false);
  assert.equal(record.filename.includes(path.sep), false);
});

test("nothing in the downloads path can open a downloaded file (structural)", async () => {
  // A real capability check would have to run the app; this asserts the
  // structural fact that the module has NO opening primitive at all, so no
  // future edit can make a download self-opening without failing here.
  const source = await readFile(
    new URL("../src/services/browser/downloads.js", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "setOpenWhenDone(",
    "openPath(",
    "showItemInFolder(",
    "openExternal(",
    'from "electron"',
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `downloads.js must not reference ${forbidden}`,
    );
  }
});

test("the item is never told to open itself when it finishes", () => {
  const { manager } = makeManager();
  const item = makeItem({ filename: "a.bin" });
  start(manager, item);
  item.emit("done", {}, "completed");
  assert.equal(item.openWhenDoneCalls, 0, "setOpenWhenDone must never be called");
});
