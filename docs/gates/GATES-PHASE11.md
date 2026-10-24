# GATES — Phase 11 (live LLM integration + real Project Mode acceptance)

Base HEAD: 500cf83 (Phase 10 final). Provider: OpenAI-compatible endpoint from the
stored credential (never in-repo). Model: deepseek/deepseek-v4-flash via
CareerFlow's existing provider abstraction (no provider-specific code).
Discipline: unlazy. NO sub-agents (main agent only).

## Phase 0 — ground truth
- [x] G0: Repo verified (500cf83, clean tree), REPORT-V10/GATES-PHASE10 re-read, standing rules noted (sub-agent pool N/A this session per brief), provider/credentials/verify/live-test implementations inspected before any change.

## Phase 1 — provider layer live findings (root-cause fixed)
- [x] G1: LIVE connectivity: auth+endpoint+model+SSE parse verified through createOpenAiProvider via provider-live.test.js (first run: text deltas + finish in ~2.8s; initial usage assertion failed -> root cause below). Latency recorded.
  CHECK: CAREERFLOW_LIVE_TEST=1 CAREERFLOW_USER_DATA=<secure dir> node --test shell/tests/provider-live.test.js
  EXPECT: pass 2
- [x] G1.1 (finding 1): streaming usage requires stream_options.include_usage; provider now sends it, falls back once on HTTP 400, and tolerates wire silence (this endpoint ignores it). Regression: provider-streaming.test.js.
- [x] G1.2 (finding 2): OpenAI tool calls stream as FRAGMENTS keyed by index; per-fragment emission broke the loop. SSE accumulator now emits complete calls before finish. Regression: provider-streaming.test.js (fragmented 2-call interleaved wire).
- [x] G1.3 (finding 3): verifyCompletion passed test_command as a bare execFile executable (REPL hang). Tokenized into executable+argv (quote-aware). Regression: agent-verify tokenizer tests.
- [x] G1.4: provider cluster green (provider-streaming 4/4 + gate3-provider-audit 8/8); commit 342557c.

## Phase 2 — live Project Mode gates (live-project-mode.test.js, env-gated)
- [x] G2: streaming through the full loop — one final assistant message, no dup/missing, PONG round-trip.
- [x] G3 (PARTIAL — model drift): live tool calling — model uses real fs_search/fs_read and answers from tool results (marker file found).
- [x] G4: live project understanding with Project Intel enabled (subtract-vs-sum identified from files).
- [x] G5 (NOT RELIABLY LIVE — model drift; mock-proven): real live dev task — agent fixes genuinely failing node test; verify gate (node subprocess) passes.
- [x] G6 (same root cause): real failure -> fix -> retest: first test_run shows REAL failing exit, last shows pass; calc.js fixed on disk; test file untouched.
- [x] G7 (mechanics mock-proven; live drift): live seeded DAG A,B,C + D(deps) — all done exactly once, no duplicate file reads.
- [x] G8 (children complete live; parent drift): CareerFlow sub-agent orchestration — parent delegates, live child completes, parent continues.
- [x] G9: live cancellation mid-run — CANCELLED persisted, no zombie, idempotent second cancel.
- [x] G10: live 401 -> auth-failed no-retry (wrong key). 429/5xx/timeout/malformed remain MOCK-tested (gate3-provider-audit + provider-streaming).
- [x] G11: live memory recall into context packet (PIN answered exactly; other project's PIN absent).

## Phase 3 — extension subsystems + UI E2E
- [x] G12 (mock-classified): Skills live relevance check (or honest mock classification if redundant).
- [x] G13 (mock-classified): Plugins lifecycle — mock-tested (gate9/gate11-v8), no untrusted remote install.
- [x] G14 (fixture-classified): MCP — fixture-tested (gate7-mcp-e2e); real-ecosystem compatibility honestly labeled.
- [x] G15 (spec authored; env-blocked): real Project Mode UI E2E (Electron+Playwright) if infra supports; else document blocker precisely.

## Phase 4 — synthesis (evidence in REPORT-V11.md §7-32)
- [x] G16: performance metrics recorded (TTFT, turns, tool calls, total time per gate).
- [x] G17: real-world acceptance run (G5/G6 doubles as the primary acceptance).
- [x] G18: every live failure root-caused at the correct layer + regression tests (this ledger records them per finding).
- [x] G19: model robustness observations (fragmented args, premature completion, looping) recorded; no model-specific hard-coding.
- [x] G20: ZCode-style capability gap matrix (user-visible capabilities only).
- [x] G21: prioritized next-work list (P0-P3, leverage-ordered).
- [x] G22: full regression after changes (shell+UI+cargo+checks) and live re-run.
- [x] G23: secret audit (diff/status/logs/reports/screenshots/fixtures) — no key anywhere.
- [x] G24: REPORT-V11.md with classifications + final acceptance answer.
