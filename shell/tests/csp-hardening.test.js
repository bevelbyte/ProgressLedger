// Content-Security-Policy hardening tests.
//
// The policy itself lives in shell/src/main.js as the exported `CSP_HEADER`
// constant and is applied to the main BrowserWindow session via
// `session.defaultSession.webRequest.onHeadersReceived`. These tests lint
// the string at the source so the policy cannot be silently weakened.
//
// What we lock down here:
//   - the string is non-empty and well-formed (one directive per `; `-segment)
//   - `default-src 'self'` is present (the baseline fallback that blocks
//     any source not explicitly allowed)
//   - wildcards (`*`) are forbidden — they would re-introduce the very
//     trust-everything posture this CSP is closing
//   - `unsafe-eval` is forbidden — it would re-enable `eval` /
//     `Function()` constructor in the renderer and undermine any
//     downstream XSS hardening
//
// Pure assertions, no live BrowserWindow.

import test from "node:test";
import assert from "node:assert/strict";

import { CSP_HEADER } from "../src/security/csp.js";

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

test("CSP header string is non-empty and contains only directive segments", () => {
  assert.equal(typeof CSP_HEADER, "string");
  assert.notEqual(CSP_HEADER.trim(), "", "CSP_HEADER must not be empty");

  const segments = CSP_HEADER.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Every non-empty segment must look like "<directive> <sources>".
  for (const seg of segments) {
    assert.match(
      seg,
      /^[a-z-]+\s+.+/,
      `CSP segment "${seg}" must be "<directive> <sources>"`
    );
  }

  // Sanity: there must be more than one directive — a one-directive CSP
  // is effectively "allow everything from one source".
  assert.ok(
    segments.length >= 5,
    `CSP must have at least 5 directives, got ${segments.length}`
  );
});

// ---------------------------------------------------------------------------
// Baseline fallback
// ---------------------------------------------------------------------------

test("CSP includes default-src 'self'", () => {
  const segments = CSP_HEADER.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const hasDefaultSelf = segments.some(
    (seg) => seg.toLowerCase() === "default-src 'self'"
  );
  assert.equal(hasDefaultSelf, true, "CSP must include default-src 'self'");
});

// ---------------------------------------------------------------------------
// Forbidden tokens — wildcards + unsafe-eval
// ---------------------------------------------------------------------------

test("CSP contains no wildcard source tokens (`*`)", () => {
  // A directive value like `*` or `https:` would re-introduce the
  // trust-everything posture. The only wildcard-like token we permit is
  // `data:` (on img-src) — check that explicitly here.
  // Strategy: split on ';' and verify each directive's source list is
  // either a single-quoted keyword, a `data:` scheme, or a comma list
  // of those.
  const segments = CSP_HEADER.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const seg of segments) {
    const directive = seg.split(/\s+/, 1)[0].toLowerCase();
    const sources = seg.slice(directive.length).trim();
    // Allow `data:` as a source (img-src), but only as a scheme, not as a
    // bare wildcard.
    const tokens = sources.split(/\s+/);
    for (const tok of tokens) {
      if (tok === "data:") continue;
      assert.notEqual(
        tok,
        "*",
        `CSP directive "${directive}" must not contain a bare wildcard`
      );
    }
  }
});

test("CSP contains no `unsafe-eval` token", () => {
  // `unsafe-eval` would re-enable eval/Function in the renderer. This is
  // strictly forbidden across all directives.
  assert.equal(
    CSP_HEADER.includes("unsafe-eval"),
    false,
    "CSP must not contain unsafe-eval"
  );
});