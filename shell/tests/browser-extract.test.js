import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXTRACT_SCRIPT,
  MAX_CAPTURE_TEXT_LENGTH,
  MAX_SELECTION_LENGTH,
  MAX_SNAPSHOT_LENGTH,
  applyExtractionCaps,
} from "../src/browser-ts/dist/extraction.js";

// Unit tests for the ported extraction module (Phase 3, TypeScript
// island). The module is pure — no Electron import — so it runs under
// plain node:test. The host method that calls it (host.extractPage:
// record lookup, URL check, executeJavaScript) cannot run under plain
// Node — host.js imports Electron — so it is covered by the real
// Electron extraction spec in Phase 3 verification, the same split the
// repo already uses for the rest of the host (no host unit tests exist).
describe("browser extraction caps", () => {
  it("keeps the PL caps", () => {
    assert.equal(MAX_CAPTURE_TEXT_LENGTH, 200_000);
    assert.equal(MAX_SNAPSHOT_LENGTH, 10_000_000);
    assert.equal(MAX_SELECTION_LENGTH, 20_000);
  });

  it("passes a normal extraction through unchanged", () => {
    const capped = applyExtractionCaps({
      text: "hello page",
      selection: "hello",
      html: "<html><body>hello page</body></html>",
    });
    assert.equal(capped.text, "hello page");
    assert.equal(capped.textTruncated, false);
    assert.equal(capped.selection, "hello");
    assert.equal(capped.html, "<html><body>hello page</body></html>");
  });

  it("truncates over-long text with the flag and drops over-long HTML", () => {
    const capped = applyExtractionCaps({
      text: "x".repeat(200_001),
      selection: "",
      html: "y".repeat(10_000_001),
    });
    assert.equal(capped.text.length, 200_000);
    assert.equal(capped.textTruncated, true);
    assert.equal(capped.html, null);
  });

  it("treats empty HTML as text-only and non-strings as empty", () => {
    const capped = applyExtractionCaps({ text: 42, selection: null, html: "" });
    assert.equal(capped.text, "");
    assert.equal(capped.textTruncated, false);
    assert.equal(capped.selection, "");
    assert.equal(capped.html, null);
  });

  it("asks the page for text, selection and HTML in one script", () => {
    assert.equal(typeof EXTRACT_SCRIPT, "string");
    assert.ok(EXTRACT_SCRIPT.startsWith("(() =>"));
    assert.ok(EXTRACT_SCRIPT.includes("innerText"));
    assert.ok(EXTRACT_SCRIPT.includes("getSelection"));
    assert.ok(EXTRACT_SCRIPT.includes("outerHTML"));
  });
});
