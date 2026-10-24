// Token budget interrupt helpers.
//
// The agent loop accumulates `tokensIn` / `tokensOut` from every model
// step's `usage` event. Without an enforced cap, a long-running agent
// can blow past a tier's spend and silently rack up charges.
//
// Default cap: 200_000 tokens (input + output combined). This is a
// sensible cap for an OpenAI-compatible tier and matches the guard
// documented in the audit. The cap is configurable per project via
// `pm_projects.config_json` (`{ "token_budget": <number> }`). A budget
// of 0 (the default if `config_json` is missing the field) means
// "no limit" — the interrupt is a no-op.
//
// The interrupt itself is a HARD transition: any over-budget state
// immediately becomes FAILED with reason `budget-exceeded`. There is
// no soft warning and no grace step.

export const DEFAULT_TOKEN_BUDGET = 200_000;
export const DEFAULT_MAX_STEPS = 50;

/**
 * Parse a project's `config_json` (or a raw string) and return a
 * normalized object. Missing / malformed JSON yields `{}` so the
 * caller can fall back to defaults.
 */
export function parseProjectConfig(s) {
  if (s && typeof s === "object") return s;
  try {
    return JSON.parse(s || "{}") || {};
  } catch {
    return {};
  }
}

/**
 * Resolve the effective token budget for a project. Reads
 * `token_budget` from the parsed config; falls back to
 * DEFAULT_TOKEN_BUDGET. `0` is preserved (means "no limit") and is
 * never replaced with the default.
 */
export function resolveTokenBudget(config) {
  const cfg = parseProjectConfig(config);
  const raw = cfg && cfg.token_budget;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TOKEN_BUDGET;
  return n;
}

/**
 * Resolve the effective max-steps limit for an agent run. Reads
 * `maxSteps` from the parsed project config; an admin-level
 * `profileConfig.max_steps` overrides it if set. Falls back to
 * DEFAULT_MAX_STEPS (50) when the value is missing, non-numeric,
 * zero, or negative. A value of 0 in project config is NOT preserved
 * (unlike token_budget) — 0 would make the step guard a no-op and
 * could let a runaway agent consume unlimited turns.
 */
export function resolveMaxSteps(projectConfig, profileConfig) {
  const projectCfg = parseProjectConfig(projectConfig);
  let raw = profileConfig && profileConfig.max_steps;
  if (raw === undefined || raw === null) {
    raw = projectCfg && projectCfg.maxSteps;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_STEPS;
  return Math.round(n);
}

/**
 * Pure decision function: should the agent interrupt right now?
 *
 *   tokensIn + tokensOut > budget   -> true   (over budget)
 *   tokensIn + tokensOut === budget -> true   (at budget is over)
 *   tokensIn + tokensOut <  budget  -> false
 *   budget === 0                    -> false  (0 = no limit)
 *   tokensIn + tokensOut === 0      -> false  (nothing spent)
 *
 * Exported as `shouldInterrupt` for tests and the loop alike.
 */
export function shouldInterrupt(tokensIn, tokensOut, budget) {
  const b = Number(budget);
  const ti = Number(tokensIn) || 0;
  const to = Number(tokensOut) || 0;
  // 0 means "no limit". Negative / NaN also treated as no limit so
  // a misconfigured project never gets stuck in a hard FAILED state.
  if (!Number.isFinite(b) || b <= 0) return false;
  return ti + to >= b;
}

/**
 * Build the `status` message that gets appended to the transcript
 * when the interrupt fires. Shape mirrors `appendStatusMessage`'s
 * `(name, payload)` signature in `verify.js` so the loop can call
 * `appendStatusMessage(core, ..., buildBudgetStatusMessage(...))`.
 */
export function buildBudgetStatusMessage(tokensIn, tokensOut, budget) {
  return {
    name: "budget-exceeded",
    payload: {
      tokensIn: Number(tokensIn) || 0,
      tokensOut: Number(tokensOut) || 0,
      budget: Number(budget) || 0,
    },
  };
}
