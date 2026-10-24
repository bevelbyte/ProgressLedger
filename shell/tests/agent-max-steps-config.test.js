// Project Mode — MAX_STEPS configurability tests.
//
// Covers gap #4 from the capability matrix (commit 75a0cc4):
// `loop.js:582` had `const MAX_STEPS = 50;` as a hard constant.
// Long plans hit `max-steps-exceeded`. The fix reads from
// `project.config_json.maxSteps` (default 50), with an optional
// admin-level `profile_config.max_steps` override.
//
// The error-message change is verified by reading loop.js:
//   await finishAgent(..., `max-steps-exceeded(limit=${maxSteps})`);

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveMaxSteps,
  DEFAULT_MAX_STEPS,
  parseProjectConfig,
} from "../src/services/agent/budget.js";

// ----------------------------------------------------------------------------
// resolveMaxSteps unit tests
// ----------------------------------------------------------------------------

test("resolveMaxSteps: missing config -> DEFAULT_MAX_STEPS (50)", () => {
  assert.equal(resolveMaxSteps(null, null), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps(undefined, null), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps({}, null), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps("{", null), DEFAULT_MAX_STEPS); // malformed JSON
});

test("resolveMaxSteps: project.config_json.maxSteps = 10 -> 10", () => {
  assert.equal(resolveMaxSteps({ maxSteps: 10 }, null), 10);
  assert.equal(resolveMaxSteps(JSON.stringify({ maxSteps: 10 }), null), 10);
});

test("resolveMaxSteps: maxSteps = 0 falls back to 50 (no 'unlimited' for steps)", () => {
  assert.equal(resolveMaxSteps({ maxSteps: 0 }, null), DEFAULT_MAX_STEPS);
});

test("resolveMaxSteps: maxSteps = -5 falls back to 50", () => {
  assert.equal(resolveMaxSteps({ maxSteps: -5 }, null), DEFAULT_MAX_STEPS);
});

test("resolveMaxSteps: non-numeric maxSteps falls back to 50", () => {
  assert.equal(resolveMaxSteps({ maxSteps: "abc" }, null), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps({ maxSteps: NaN }, null), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps({ maxSteps: Infinity }, null), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps({ maxSteps: null }, null), DEFAULT_MAX_STEPS);
});

test("resolveMaxSteps: profile_config.max_steps overrides project config", () => {
  const profileCfg = { max_steps: 200 };
  assert.equal(resolveMaxSteps({ maxSteps: 10 }, profileCfg), 200);
  // Profile override also applies when project config is empty.
  assert.equal(resolveMaxSteps({}, profileCfg), 200);
  // Profile override of 0 still falls back (0 = no limit is dangerous here).
  assert.equal(resolveMaxSteps({ maxSteps: 10 }, { max_steps: 0 }), DEFAULT_MAX_STEPS);
  // Profile override of negative falls back.
  assert.equal(resolveMaxSteps({ maxSteps: 10 }, { max_steps: -1 }), DEFAULT_MAX_STEPS);
  // Profile override of non-numeric falls back.
  assert.equal(resolveMaxSteps({ maxSteps: 10 }, { max_steps: "big" }), DEFAULT_MAX_STEPS);
});

test("resolveMaxSteps: floats are rounded to nearest integer", () => {
  assert.equal(resolveMaxSteps({ maxSteps: 7.8 }, null), 8);
  assert.equal(resolveMaxSteps({ maxSteps: 7.2 }, null), 7);
});

test("resolveMaxSteps: DEFAULT_MAX_STEPS is 50", () => {
  assert.equal(DEFAULT_MAX_STEPS, 50);
});

test("resolveMaxSteps: parseProjectConfig is reused for profile_config parsing", () => {
  // Sanity-check that parseProjectConfig (used internally for both
  // project and profile config) handles the shapes we pass.
  assert.deepEqual(parseProjectConfig(null), {});
  assert.deepEqual(parseProjectConfig({ max_steps: 100 }), { max_steps: 100 });
  assert.deepEqual(parseProjectConfig('{"max_steps": 100}'), { max_steps: 100 });
});
