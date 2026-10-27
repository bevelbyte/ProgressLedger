import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_FILE_TYPES,
  localFileTypeForPath,
  localFileTitle,
  localViewerHtml,
  validateLocalFilePath,
  createLocalFileStore,
  localFileResponse,
  LOCAL_URL_PATTERN,
} from "../src/services/browser/local-file.js";
import { isAllowedUrl, isEphemeralViewerUrl } from "../src/services/browser/policy.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const VIEWER_URL = `progressledger-v2://local/${UUID}`;
const FILE_URL = `${VIEWER_URL}/file`;

test("allowlist admits only PDF, text, and raster images", () => {
  for (const ext of ["pdf", "txt", "png", "jpg", "jpeg", "gif", "webp"]) {
    assert.ok(localFileTypeForPath(`C:\\Users\\Asus\\Downloads\\file.${ext}`), ext);
  }
  assert.equal(localFileTypeForPath("C:\\x\\UPPER.PDF").mime, "application/pdf");
  assert.equal(localFileTypeForPath("C:\\x\\photo.JPEG").mime, "image/jpeg");
  assert.equal(localFileTypeForPath("C:\\x\\notes.txt").mime, "text/plain");
  for (const ext of ["exe", "bat", "cmd", "ps1", "js", "msi", "com", "scr", "vbs", "html", "htm", "zip", "mp4"]) {
    assert.equal(localFileTypeForPath(`C:\\x\\payload.${ext}`), null, ext);
  }
  assert.equal(localFileTypeForPath("C:\\x\\noextension"), null);
  assert.equal(localFileTypeForPath("C:\\x\\.pdf"), null);
  assert.equal(localFileTypeForPath(""), null);
  assert.equal(localFileTypeForPath(null), null);
  assert.equal(Object.keys(LOCAL_FILE_TYPES).length, 7);
});

test("localFileTitle takes the basename, cleaned", () => {
  assert.equal(localFileTitle("C:\\Users\\Asus\\Downloads\\Annual Report.pdf"), "Annual Report.pdf");
  assert.equal(localFileTitle("/tmp/a<b>c|.txt"), "abc.txt");
  assert.equal(localFileTitle(""), "local file");
});

test("localViewerHtml renders by kind, escapes, and has no script", () => {
  const pdf = localViewerHtml("pdf", 'a"b<c>.pdf', FILE_URL);
  assert.ok(pdf.includes('<embed type="application/pdf"'));
  assert.ok(pdf.includes("<title>a&quot;b&lt;c&gt;.pdf</title>"));
  assert.ok(!pdf.includes("<script"));

  const image = localViewerHtml("image", "photo.png", FILE_URL);
  assert.ok(image.includes("<img src="));
  assert.ok(!image.includes("<script"));

  const text = localViewerHtml("text", "notes.txt", FILE_URL);
  assert.ok(text.includes('<iframe sandbox=""'));
  assert.ok(!text.includes("<script"));

  const escaped = localViewerHtml("pdf", "x.pdf", `${VIEWER_URL}/file?a=1&b="><script>`);
  assert.ok(!escaped.includes('"><script>'));
  assert.ok(escaped.includes("a=1&amp;b="));
});

test("local URL pattern admits only UUID nonces, with optional /file", () => {
  assert.equal(LOCAL_URL_PATTERN.test(VIEWER_URL), true);
  assert.equal(LOCAL_URL_PATTERN.test(FILE_URL), true);
  assert.equal(LOCAL_URL_PATTERN.test("progressledger-v2://local/abc"), false);
  assert.equal(LOCAL_URL_PATTERN.test(`${VIEWER_URL}/extra`), false);
  assert.equal(LOCAL_URL_PATTERN.test(`${FILE_URL}/extra`), false);
  assert.equal(LOCAL_URL_PATTERN.test("progressledger-v2://viewer/123e4567-e89b-12d3-a456-426614174000"), false);
  assert.equal(LOCAL_URL_PATTERN.test("progressledger-v2://app/index.html"), false);
});

test("navigation gate admits local viewer URLs and still refuses file:", () => {
  assert.equal(isAllowedUrl(VIEWER_URL).ok, true);
  assert.equal(isAllowedUrl(FILE_URL).ok, true);
  assert.equal(isAllowedUrl("file:///C:/Users/Asus/Downloads/x.pdf").ok, false);
  assert.equal(isAllowedUrl("progressledger-v2://local/not-a-uuid").ok, false);
  assert.equal(isAllowedUrl("progressledger-v2://app/index.html").ok, false);
});

test("validateLocalFilePath refuses directories, missing files, and blocked types", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-v2-local-"));
  const okFile = join(dir, "notes.txt");
  writeFileSync(okFile, "hello");
  const exeFile = join(dir, "payload.exe");
  writeFileSync(exeFile, "MZ");
  const subdir = join(dir, "sub");
  mkdirSync(subdir);

  const ok = validateLocalFilePath(okFile, statSync);
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.mime, "text/plain");
  assert.equal(ok.entry.kind, "text");
  assert.equal(ok.entry.title, "notes.txt");

  assert.equal(validateLocalFilePath(exeFile, statSync).reason, "blocked-type");
  assert.equal(validateLocalFilePath(subdir, statSync).reason, "not-a-file");
  assert.equal(validateLocalFilePath(join(dir, "missing.pdf"), statSync).reason, "not-a-file");
  assert.equal(validateLocalFilePath("", statSync).reason, "not-a-file");
});

test("nonce store resolves until expiry, then forgets", () => {
  let t = 0;
  const store = createLocalFileStore(() => t);
  const minted = store.register({ path: "C:\\x\\report.pdf", mime: "application/pdf", kind: "pdf", title: "report.pdf" });
  assert.equal(LOCAL_URL_PATTERN.test(minted.viewerUrl), true);
  assert.equal(LOCAL_URL_PATTERN.test(minted.fileUrl), true);
  assert.equal(minted.title, "report.pdf");
  assert.equal(minted.kind, "pdf");
  assert.equal(store.resolve(minted.nonce).path, "C:\\x\\report.pdf");
  assert.equal(store.resolve("00000000-0000-0000-0000-000000000000"), null);
  t = 11 * 60 * 1000;
  assert.equal(store.resolve(minted.nonce), null);
  assert.equal(store.size(), 0);
});

test("localFileResponse serves fixed-mime bytes, and 404s on anything wrong", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-v2-local-resp-"));
  const txt = join(dir, "notes.txt");
  writeFileSync(txt, "hello local");
  const entry = { path: txt, mime: "text/plain", kind: "text", title: "notes.txt" };
  const fetchFile = async (p) => new Response(readFileSync(p), { status: 200 });

  const res = await localFileResponse(entry, { statSync, fetchFile });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-disposition"), "inline");
  assert.equal(await res.text(), "hello local");

  const missing = await localFileResponse({ ...entry, path: join(dir, "gone.txt") }, { statSync, fetchFile });
  assert.equal(missing.status, 404);
  const dirEntry = await localFileResponse({ ...entry, path: dir }, { statSync, fetchFile });
  assert.equal(dirEntry.status, 404);
  const fetchFails = await localFileResponse(entry, {
    statSync,
    fetchFile: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(fetchFails.status, 404);
  const badStatus = await localFileResponse(entry, {
    statSync,
    fetchFile: async () => new Response("nope", { status: 500 }),
  });
  assert.equal(badStatus.status, 404);
});

test("isEphemeralViewerUrl matches only the app's minted viewer URLs", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(isEphemeralViewerUrl(`progressledger-v2://viewer/${uuid}`), true);
  assert.equal(isEphemeralViewerUrl(`progressledger-v2://local/${uuid}`), true);
  assert.equal(isEphemeralViewerUrl(`progressledger-v2://local/${uuid}/file`), true);
  assert.equal(isEphemeralViewerUrl("https://example.com/page"), false);
  assert.equal(isEphemeralViewerUrl("progressledger-v2://app"), false);
  assert.equal(isEphemeralViewerUrl("progressledger-v2://viewer/not-a-uuid"), false);
  assert.equal(isEphemeralViewerUrl("progressledger-v2://local/123e4567-e89b-12d3-a456-426614174000/extra"), false);
  assert.equal(isEphemeralViewerUrl(""), false);
  assert.equal(isEphemeralViewerUrl(null), false);
  assert.equal(isEphemeralViewerUrl(undefined), false);
});
