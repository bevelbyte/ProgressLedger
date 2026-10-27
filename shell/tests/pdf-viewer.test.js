import test from "node:test";
import assert from "node:assert/strict";
import {
  isPdfResponse,
  pdfFilename,
  viewerHtml,
  createPdfViewerStore,
  VIEWER_URL_PATTERN,
} from "../src/services/browser/pdf-viewer.js";

function details(overrides = {}) {
  return {
    url: "https://example.com/files/report.pdf",
    method: "GET",
    resourceType: "mainFrame",
    statusCode: 200,
    responseHeaders: { "content-type": ["application/pdf"] },
    ...overrides,
  };
}

test("isPdfResponse accepts a plain main-frame PDF GET", () => {
  assert.equal(isPdfResponse(details()), true);
  assert.equal(isPdfResponse(details({ responseHeaders: { "Content-Type": ["application/pdf; charset=binary"] } })), true);
});

test("isPdfResponse rejects everything that is not that case", () => {
  assert.equal(isPdfResponse(details({ resourceType: "subFrame" })), false);
  assert.equal(isPdfResponse(details({ resourceType: "other" })), false);
  assert.equal(isPdfResponse(details({ method: "POST" })), false);
  assert.equal(isPdfResponse(details({ statusCode: 301 })), false);
  assert.equal(isPdfResponse(details({ url: "progressledger-v2://viewer/abc" })), false);
  assert.equal(isPdfResponse(details({ responseHeaders: { "content-type": ["text/html"] } })), false);
  assert.equal(
    isPdfResponse(details({ responseHeaders: { "content-type": ["application/pdf"], "content-disposition": ['attachment; filename="x.pdf"'] } })),
    false,
  );
  assert.equal(isPdfResponse(null), false);
  assert.equal(isPdfResponse({}), false);
});

test("pdfFilename takes the last segment without the query", () => {
  assert.equal(pdfFilename("https://example.com/files/Annual%20Report.pdf?token=secret&x=1"), "Annual Report.pdf");
  assert.equal(pdfFilename("https://example.com/download?id=5"), "download");
  assert.equal(pdfFilename("https://example.com/"), "document.pdf");
  assert.equal(pdfFilename("not a url"), "document.pdf");
});

test("viewerHtml escapes the URL and title", () => {
  const html = viewerHtml('https://example.com/a.pdf?q=1&x="><script>', 'a"b<c>.pdf');
  assert.ok(html.includes('<embed type="application/pdf"'));
  assert.ok(!html.includes('"><script>'));
  assert.ok(html.includes("q=1&amp;x="));
  assert.ok(html.includes("<title>a&quot;b&lt;c&gt;.pdf</title>"));
});

test("viewer URL pattern admits only UUID nonces", () => {
  assert.equal(VIEWER_URL_PATTERN.test("progressledger-v2://viewer/123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(VIEWER_URL_PATTERN.test("progressledger-v2://viewer/abc"), false);
  assert.equal(VIEWER_URL_PATTERN.test("progressledger-v2://app/index.html"), false);
  assert.equal(VIEWER_URL_PATTERN.test("progressledger-v2://viewer/123e4567-e89b-12d3-a456-426614174000/extra"), false);
});

test("nonce store resolves until expiry, then forgets", () => {
  let t = 0;
  const store = createPdfViewerStore(() => t);
  const { nonce, viewerUrl, title } = store.register("https://example.com/files/report.pdf?token=secret");
  assert.equal(VIEWER_URL_PATTERN.test(viewerUrl), true);
  assert.equal(title, "report.pdf");
  assert.equal(store.resolve(nonce).pdfUrl, "https://example.com/files/report.pdf?token=secret");
  assert.equal(store.resolve("00000000-0000-0000-0000-000000000000"), null);
  t = 11 * 60 * 1000;
  assert.equal(store.resolve(nonce), null);
  assert.equal(store.size(), 0);
});
