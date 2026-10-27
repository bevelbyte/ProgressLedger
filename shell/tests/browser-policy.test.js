// Browser navigation policy — Phase 1 of the approved D2-D6 plan.
//
// These tests are the ones that must be able to fail WITHOUT launching Electron:
// which URLs a Progress Ledger browser page may load, which partition a profile owns,
// and what a renderer-declared rectangle is allowed to become. The scheme
// allowlist in particular is a security decision, so it is asserted against the
// refusals (negative-first) rather than only against the happy path.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_SCHEMES,
  isAllowedUrl,
  normalizeTarget,
  partitionFor,
  clampRect,
  sanitizeDisplayUrl,
  schemeOf,
  validateProfileId,
  sanitizeDownloadFilename,
  resolveDownloadTarget,
  isContainedIn,
  MAX_CONCURRENT_DOWNLOADS,
  MAX_DOWNLOAD_FILENAME_LENGTH,
} from "../src/services/browser/policy.js";
import path from "node:path";

test("the allowlist is exactly http(s)", () => {
  assert.deepEqual([...ALLOWED_SCHEMES], ["https:", "http:"]);
});

test("normalizeTarget accepts http(s) and infers https for a bare host", () => {
  assert.equal(normalizeTarget("https://example.com/a").ok, true);
  assert.equal(normalizeTarget("http://example.com/a").url, "http://example.com/a");
  assert.equal(normalizeTarget("example.com").url, "https://example.com/");
  assert.equal(normalizeTarget("about:blank").url, "about:blank");
});

test("normalizeTarget refuses every non-web scheme with a stated reason", () => {
  for (const [input, reason] of [
    ["file:///C:/Windows/win.ini", "blocked-scheme"],
    ["javascript:alert(1)", "blocked-scheme"],
    ["data:text/html,<h1>x</h1>", "blocked-scheme"],
    ["progressledger-v2://app/index.html", "blocked-scheme"],
    ["mailto:a@b.c", "blocked-scheme"],
    ["view-source:https://x.test", "blocked-scheme"],
    ["", "empty-url"],
    ["   ", "empty-url"],
  ]) {
    const out = normalizeTarget(input);
    assert.equal(out.ok, false, `${input} must be refused`);
    assert.equal(out.reason, reason, `${input} reason`);
  }
});

test("normalizeTarget refuses embedded credentials and non-strings", () => {
  assert.equal(normalizeTarget("https://user:pass@example.com/").reason, "url-credentials");
  assert.equal(normalizeTarget(null).reason, "invalid-url");
  assert.equal(normalizeTarget(1234).reason, "invalid-url");
  assert.equal(normalizeTarget(`https://${"a".repeat(5000)}.test`).reason, "invalid-url");
});

test("isAllowedUrl is the navigation gate and agrees with normalizeTarget on refusals", () => {
  assert.equal(isAllowedUrl("https://example.com/x").ok, true);
  assert.equal(isAllowedUrl("http://example.com/x").ok, true);
  assert.equal(isAllowedUrl("about:blank").ok, true);
  for (const denied of [
    "file:///etc/passwd",
    "data:text/html,x",
    "javascript:void(0)",
    "progressledger-v2://app/index.html",
    "blob:https://example.com/abc",
    "about:config",
  ]) {
    const out = isAllowedUrl(denied);
    assert.equal(out.ok, false, `${denied} must be refused`);
  }
  assert.equal(schemeOf("file:///x"), "file:");
  assert.equal(schemeOf("nonsense"), "");
});
test("isAllowedUrl admits only main-generated PDF viewer URLs on the app scheme", () => {
  const good = "progressledger-v2://viewer/123e4567-e89b-12d3-a456-426614174000";
  assert.equal(isAllowedUrl(good).ok, true);
  assert.equal(isAllowedUrl(good).url, good);
  for (const denied of [
    "progressledger-v2://viewer/abc",
    "progressledger-v2://viewer/123e4567-e89b-12d3-a456-426614174000/extra",
    "progressledger-v2://viewer/",
    "progressledger-v2://app/index.html",
  ]) {
    assert.equal(isAllowedUrl(denied).ok, false, `${denied} must be refused`);
  }
});

test("validateProfileId accepts only positive integers", () => {
  for (const good of [1, 7, "12", 2147483647]) assert.equal(validateProfileId(good), true);
  for (const bad of [0, -1, 1.5, "abc", "", null, undefined, 2 ** 32, " 3 "]) {
    assert.equal(validateProfileId(bad), false, `${String(bad)} must be refused`);
  }
});

test("partitionFor derives one persistent partition per profile and refuses junk", () => {
  assert.equal(partitionFor(7), "persist:cf-browser-7");
  assert.equal(partitionFor("7"), "persist:cf-browser-7");
  // Session-selection injection: anything that could steer fromPartition is out.
  for (const bad of [0, -3, "cf-browser-1", "1;evil", "1/2", "../1", 3.5, null]) {
    assert.equal(partitionFor(bad), null, `${String(bad)} must not mint a partition`);
  }
  // Never the app's own session: defaultSession carries the app CSP + bridge.
  assert.equal(String(partitionFor(1)).includes("default"), false);
});

test("sanitizeDisplayUrl strips credentials, token-ish params and the fragment", () => {
  assert.equal(sanitizeDisplayUrl("https://a.test/x?token=secret&b=2#frag"), "https://a.test/x?b=2");
  assert.equal(sanitizeDisplayUrl("https://u:p@a.test/x"), "https://a.test/x");
  assert.equal(sanitizeDisplayUrl("https://a.test"), "https://a.test");
  assert.equal(sanitizeDisplayUrl("not a url"), "");
  assert.equal(sanitizeDisplayUrl("").length, 0);
});

test("clampRect pins a declared rectangle inside the window content area", () => {
  const content = { width: 1000, height: 700 };
  const inside = clampRect({ x: 10, y: 20, width: 300, height: 200 }, content);
  assert.deepEqual(inside, { ok: true, x: 10, y: 20, width: 300, height: 200 });

  // A hostile/buggy renderer cannot draw outside the window…
  const over = clampRect({ x: 900, y: 650, width: 400, height: 400 }, content);
  assert.equal(over.x + over.width <= 1000, true);
  assert.equal(over.y + over.height <= 700, true);

  // …nor from outside it, and cannot produce a degenerate native view.
  const negative = clampRect({ x: -50, y: -50, width: 100, height: 100 }, content);
  assert.equal(negative.x, 0);
  assert.equal(negative.y, 0);
  assert.equal(clampRect({ x: 0, y: 0, width: 0, height: 100 }, content).reason, "empty-rect");
  assert.equal(clampRect({ x: 0, y: 0, width: 0.4, height: 100 }, content).reason, "empty-rect");
  assert.equal(clampRect(null, content).reason, "invalid-rect");
  assert.equal(clampRect({ x: 0, y: 0, width: "wide", height: 10 }, content).reason, "invalid-rect");
});

/* ------------------------------------------------------------------
 * Downloads: sanitization and containment (approved decision D)
 * ------------------------------------------------------------------ */

test("sanitizeDownloadFilename always yields ONE safe segment, never a path", () => {
  // A name is a NAME: every traversal shape collapses to its final component.
  assert.equal(sanitizeDownloadFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeDownloadFilename("/tmp/x.exe"), "x.exe");
  assert.equal(sanitizeDownloadFilename("C:\\Temp\\report.pdf"), "report.pdf");
  assert.equal(sanitizeDownloadFilename("a/b/../c.txt"), "c.txt");

  // The invariant that actually matters: no separator can survive the call.
  for (const hostile of ["../x", "..\\x", "a/b", "//x", "\\\\server\\share\\f", ".../x"]) {
    const safe = sanitizeDownloadFilename(hostile);
    assert.equal(safe.includes("/"), false, `${hostile} -> ${safe}`);
    assert.equal(safe.includes("\\"), false, `${hostile} -> ${safe}`);
  }
});

test("sanitizeDownloadFilename kills the ADS colon and the illegal character set", () => {
  // NTFS alternate data streams: a name like this must not be able to create a
  // second stream beside the file the user thinks they downloaded.
  assert.equal(sanitizeDownloadFilename("report.pdf:payload.exe"), "report.pdfpayload.exe");
  assert.equal(sanitizeDownloadFilename("a<b>c|d?e*f.txt"), "abcdef.txt");
  // Control characters can hide a separator from a human reading the name.
  assert.equal(sanitizeDownloadFilename("evil\u0000\u001f\u007fname.txt"), "evilname.txt");
});

test("sanitizeDownloadFilename neutralises Windows reserved device names", () => {
  const cases = [
    ["CON", "_CON"],
    ["con.txt", "_con.txt"],
    ["NUL", "_NUL"],
    ["AUX.log", "_AUX.log"],
    ["COM1.txt", "_COM1.txt"],
    ["LPT9.md", "_LPT9.md"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(sanitizeDownloadFilename(raw), expected, `${raw} is a device name`);
  }
  // A reserved word as a PREFIX is an ordinary name and must be left alone.
  assert.equal(sanitizeDownloadFilename("console.txt"), "console.txt");
  assert.equal(sanitizeDownloadFilename("nullable.json"), "nullable.json");
});

test("sanitizeDownloadFilename strips trailing dots and spaces (the Windows spoof)", () => {
  // Windows SILENTLY drops these, so `malware.exe.` lands as `malware.exe` - a
  // name a check that saw the trailing dot would have decided about differently.
  // What is validated must be what lands.
  assert.equal(sanitizeDownloadFilename("malware.exe."), "malware.exe");
  assert.equal(sanitizeDownloadFilename("malware.exe   "), "malware.exe");
  assert.equal(sanitizeDownloadFilename("malware.exe. . "), "malware.exe");
});

test("sanitizeDownloadFilename always returns a usable name", () => {
  // A page that suggests nothing must still produce a file name the manager can
  // commit, so the fail-closed path is about the DIRECTORY, never about this.
  for (const empty of ["", "   ", "..", ".", "/", "\\", "./", "../", null, undefined, 42, {}]) {
    assert.equal(sanitizeDownloadFilename(empty), "download", `${String(empty)} must fall back`);
  }
});

test("sanitizeDownloadFilename bounds the length but keeps the extension", () => {
  const safe = sanitizeDownloadFilename(`${"x".repeat(400)}.pdf`);
  assert.equal(safe.length, MAX_DOWNLOAD_FILENAME_LENGTH);
  assert.equal(safe.endsWith(".pdf"), true, "the extension is the last thing to lose");
});

test("isContainedIn compares path SEGMENTS, not string prefixes", () => {
  const dir = path.join("ws", "downloads");
  assert.equal(isContainedIn(dir, path.join(dir, "a.txt")), true);
  assert.equal(isContainedIn(dir, path.join(dir, "nested", "a.txt")), true);

  // The sibling-prefix trap: `downloads-evil` is NOT inside `downloads`, though a
  // naive startsWith() would say it is.
  assert.equal(isContainedIn(dir, path.join("ws", "downloads-evil", "a.txt")), false);

  // Escapes, the directory itself and junk are all refused.
  assert.equal(isContainedIn(dir, path.join(dir, "..", "x")), false);
  assert.equal(isContainedIn(dir, path.join(dir, "..", "..", "x")), false);
  assert.equal(isContainedIn(dir, dir), false);
  assert.equal(isContainedIn(dir, ""), false);
  assert.equal(isContainedIn("", path.join(dir, "a.txt")), false);
  assert.equal(isContainedIn(null, path.join(dir, "a.txt")), false);
});

test("resolveDownloadTarget sanitizes, contains and de-duplicates", () => {
  const dir = path.resolve("ws", "downloads");

  // A traversal name is NEUTRALISED, not merely rejected: the result stays in.
  const traversal = resolveDownloadTarget({ dir, filename: "../../evil.exe" });
  assert.equal(traversal.ok, true);
  assert.equal(traversal.filename, "evil.exe");
  assert.equal(isContainedIn(dir, traversal.path), true);

  // An absolute path a page tried to suggest becomes a plain name in the dir.
  const absolute = resolveDownloadTarget({ dir, filename: "C:\\Windows\\System32\\evil.dll" });
  assert.equal(absolute.ok, true);
  assert.equal(path.dirname(absolute.path), dir);
  assert.equal(absolute.filename, "evil.dll");

  // A collision is RENAMED, never overwritten.
  const collision = resolveDownloadTarget({
    dir,
    filename: "notes.pdf",
    exists: (candidate) => candidate.endsWith(`${path.sep}notes.pdf`),
  });
  assert.equal(collision.ok, true);
  assert.equal(collision.filename, "notes (1).pdf");
  assert.equal(isContainedIn(dir, collision.path), true);

  // An exhausted name space is a refusal rather than a silent overwrite.
  const exhausted = resolveDownloadTarget({ dir, filename: "a.pdf", exists: () => true, maxAttempts: 3 });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, "too-many-collisions");

  // No managed directory is a REFUSAL, never a fallback.
  assert.equal(resolveDownloadTarget({ dir: null, filename: "a.pdf" }).reason, "no-downloads-dir");
  assert.equal(resolveDownloadTarget({ dir: "", filename: "a.pdf" }).reason, "no-downloads-dir");
});

test("the concurrency cap is a small positive number, not an accident", () => {
  assert.equal(Number.isInteger(MAX_CONCURRENT_DOWNLOADS), true);
  assert.equal(MAX_CONCURRENT_DOWNLOADS > 0, true);
  assert.equal(MAX_CONCURRENT_DOWNLOADS <= 8, true);
});
