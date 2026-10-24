// Phase — token budget interrupt helpers (pure-function unit tests).
//
// Covers `shouldInterrupt` boundary conditions and the status-message
// builder. The interrupt decision is a HARD transition: any over-budget
// state becomes FAILED with reason `budget-exceeded`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldInterrupt,
  buildBudgetStatusMessage,
  resolveTokenBudget,
  parseProjectConfig,
  DEFAULT_TOKEN_BUDGET,
} from "../src/services/agent/budget.js";

// ----------------------------------------------------------------------------
// shouldInterrupt
// ----------------------------------------------------------------------------

test("budget: below budget returns false", () => {
  assert.equal(shouldInterrupt(100, 99, 200_000), false);
  assert.equal(shouldInterrupt(0, 199_999, 200_000), false);
});

test("budget: at budget returns true (>=)", () => {
  assert.equal(shouldInterrupt(100_000, 100_000, 200_000), true);
  assert.equal(shouldInterrupt(200_000, 0, 200_000), true);
});

test("budget: above budget returns true", () => {
  assert.equal(shouldInterrupt(150_000, 100_000, 200_000), true);
  assert.equal(shouldInterrupt(1, 999_999, 200_000), true);
});

test("budget: budget=0 means no limit (always false)", () => {
  assert.equal(shouldInterrupt(0, 0, 0), false);
  assert.equal(shouldInterrupt(1_000_000, 1_000_000, 0), false);
  assert.equal(shouldInterrupt(99_999_999, 0, 0), false);
});

test("budget: zero tokens + zero budget returns false", () => {
  assert.equal(shouldInterrupt(0, 0, 0), false);
});

test("budget: negative or non-finite budget is treated as no limit", () => {
  assert.equal(shouldInterrupt(1000, 1000, -1), false);
  assert.equal(shouldInterrupt(1000, 1000, NaN), false);
  assert.equal(shouldInterrupt(1000, 1000, Infinity), false);
});

test("budget: non-numeric tokens are coerced to 0", () => {
  assert.equal(shouldInterrupt("0", "0", 200_000), false);
  assert.equal(shouldInterrupt(null, undefined, 200_000), false);
  assert.equal(shouldInterrupt("100", "100", 200), true);
});

// ----------------------------------------------------------------------------
// buildBudgetStatusMessage
// ----------------------------------------------------------------------------

test("budget: status message has expected name and payload", () => {
  const m = buildBudgetStatusMessage(150_000, 75_000, 200_000);
  assert.equal(m.name, "budget-exceeded");
  assert.deepEqual(m.payload, {
    tokensIn: 150_000,
    tokensOut: 75_000,
    budget: 200_000,
  });
});

test("budget: status message coerces non-numeric values to 0", () => {
  const m = buildBudgetStatusMessage(null, undefined, "0");
  assert.equal(m.name, "budget-exceeded");
  assert.equal(m.payload.tokensIn, 0);
  assert.equal(m.payload.tokensOut, 0);
  assert.equal(m.payload.budget, 0);
});

// ----------------------------------------------------------------------------
// parseProjectConfig / resolveTokenBudget
// ----------------------------------------------------------------------------

test("budget: parseProjectConfig handles missing / malformed input", () => {
  assert.deepEqual(parseProjectConfig(""), {});
  assert.deepEqual(parseProjectConfig(null), {});
  assert.deepEqual(parseProjectConfig(undefined), {});
  assert.deepEqual(parseProjectConfig("not json"), {});
  assert.deepEqual(parseProjectConfig({ already: "object" }), { already: "object" });
});

test("budget: resolveTokenBudget defaults to 200_000 when unset / invalid", () => {
  assert.equal(resolveTokenBudget({}), DEFAULT_TOKEN_BUDGET);
  assert.equal(resolveTokenBudget("{}"), DEFAULT_TOKEN_BUDGET);
  assert.equal(resolveTokenBudget({ token_budget: -1 }), DEFAULT_TOKEN_BUDGET);
  assert.equal(resolveTokenBudget({ token_budget: "abc" }), DEFAULT_TOKEN_BUDGET);
  // 0 is preserved (means "no limit")
  assert.equal(resolveTokenBudget({ token_budget: 0 }), 0);
  assert.equal(resolveTokenBudget({ token_budget: 500_000 }), 500_000);
});

test("budget: default cap is 200_000", () => {
  assert.equal(DEFAULT_TOKEN_BUDGET, 200_000);
});
