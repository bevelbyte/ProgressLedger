// Pure URL-validation matrix for the SubjectLinks → Donut open path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateHttpUrl } from "../src/services/donut-open.js";

const ok = (raw, expectedHref) => {
  const out = validateHttpUrl(raw);
  assert.equal(out, expectedHref ?? raw, `expected acceptance: ${raw}`);
};
const bad = (raw) => {
  assert.equal(validateHttpUrl(raw), null, `expected rejection: ${raw}`);
};

test("accepts plain https URLs", () => {
  ok("https://example.com", "https://example.com/");
});

test("accepts plain http URLs", () => {
  ok("http://example.com/page");
});

test("accepts path/query/fragment and IP-with-port forms unchanged in meaning", () => {
  assert.equal(
    validateHttpUrl("https://example.com/path?q=x#fragment"),
    "https://example.com/path?q=x#fragment"
  );
  assert.equal(validateHttpUrl("http://192.168.1.10:8080/"), "http://192.168.1.10:8080/");
  assert.equal(
    validateHttpUrl("  https://example.com/a b?x=1  "),
    "https://example.com/a%20b?x=1"
  );
});

test("rejects javascript: URLs (any case)", () => {
  bad("javascript:alert(1)");
  bad("JavaScript:alert(1)");
  bad("  javascript:void(0)");
});

test("rejects data: URLs", () => {
  bad("data:text/html;base64,PHNjcmlwdD4=");
  bad("data:text/html,<h1>hi</h1>");
});

test("rejects file: URLs", () => {
  bad("file:///C:/Windows/System32/calc.exe");
  bad("file://server/share/doc.pdf");
});

test("rejects vbscript:, about:, chrome:, chrome-extension: and devtools:", () => {
  bad("vbscript:MsgBox(1)");
  bad("about:blank");
  bad("chrome://settings");
  bad("chrome-extension://abcdef/main.js");
  bad("devtools://devtools/bundled/inspector.html");
});

test("rejects non-http schemes like ftp:", () => {
  bad("ftp://example.com/pub");
});

test("rejects empty, whitespace-only and non-string inputs", () => {
  bad("");
  bad("   ");
  bad("\t\n");
  bad(null);
  bad(undefined);
  bad(42);
  bad({});
});

test("rejects malformed URL values", () => {
  bad("not a url");
  bad("http://");
  bad("//example.com/no-scheme");
  bad("example.com/with-scheme-missing");
  bad("ht!tp://weird");
});
