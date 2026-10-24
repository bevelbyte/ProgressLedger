# GATES-PHASE13 — Production Autonomous Agent Hardening & Sub-Agent Acceptance

Phase 13: prove the autonomous production architecture end-to-end. Honest
classifications only. Environment for all gates: Windows, repo HEAD (see
REPORT-V13.md), live provider `https://api.b.ai/v1` + `deepseek-v4-flash`
(env-gated credential store; key never logged), mock gates run under plain
`node --test` with the faithful real-NAPI-shape core double or the real NAPI
core as noted.

| # | Test | Environment | Expected | Actual | Result | Evidence / File |
|---|------|-------------|----------|--------|--------|-----------------|
| G1 | Phase 12 fixes present at HEAD | repo | all 4 fixes in tree | verify.js real-`code` shape; delegate number-id + startSubAgent; final-round tools; fix-signal — all confirmed by grep | PASS | `shell/src/services/agent/verify.js`, `delegate_research.js`, `loop.js` |
| G2 | Loop termination caps | repo | explicit max-steps termination | `safetySteps >= maxSteps -> FAILED max-steps-exceeded(limit=…)`; fix-retry ≤ 2; budget caps; MAX_CONCURRENT_SUBAGENTS=3 | PASS | `shell/src/services/agent/loop.js:716-739` |
| G3 | Provider resilience: empty-body 400 bounded retry | mock fetch | one identical-request retry, then success | retried exactly once, byte-identical body, stream recovered | PASS | `shell/tests/provider-streaming.test.js` (3 new tests) |
| G4 | Provider resilience: 400 WITH body is terminal (no retry) | mock fetch | immediate http-error with body snippet | exactly 1 fetch, error carries `invalid model` body — **caught the transient-retry implementation misclassifying consumed bodies; fixed via read-once `text400`** | PASS (fixed) | same file |
| G5 | Sub-agent failure matrix (A–J) | mock (existing suites) | deterministic terminal states | A success: real-core-shape T2 + gate2; B fail / C cancel: gate2 three-children stress; D parent-cancel→child: gate10-1/2/3/5; E parent-finishes-while-child-active: architecturally impossible (delegate_* blocks until child terminal); F tool fail: agent-failure-injection; G child provider fail: subagent-lifecycle T1 (NEW); H limits: gate5 checkLimits; I multi-child: gate2 + LIVE-2; J nested delegation refused: agent-delegation recursion guard | PASS | files listed |
| G6 | Child provider failure -> parent informed | mock, real-shape core | child row FAILED, parent completes with failed state | child state=FAILED persisted; delegate envelope ok with result.state=failed; no zombie run | PASS | `shell/tests/subagent-lifecycle.test.js` T1 |
| G7 | Fix-retry signal reaches the MODEL | mock + REAL test_run subprocess | user fix-signal persisted AND in next round's context | transcript user msg after fix-retrying; round-2 context contains it; disk outcome correct; verified | PASS | same file T2 |
| G8 | Verification lifecycle extras | mock + REAL subprocess | stderr+exit0 passes; hanging test errors; whitespace-only test_command errors; empty = no-test-command | all four as expected | PASS | `shell/tests/verify-gate-shape.test.js` (3 new tests) |
| G9 | D5 (P0) — orphan tool messages in model context | LIVE dump | every tool message preceded by assistant(tool_calls) | b.ai 400 body: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"; dumps show [system,user,tool,tool] with NO anchor. **Root cause: the loop only pushed the assistant round when it had text; pure-tool-call rounds produced orphan tool messages. Retroactively explains ALL Phase 12 empty-body 400s.** | PASS (fixed) | dumps run 1; fix `loop.js` (assistant tool_calls anchor); regression `subagent-lifecycle.test.js` T3 |
| G10 | LIVE-1 delegation (parent→child→tools→result→parent final) | REAL core + SQLite + live provider | child persisted w/ parentAgentId, tools ok, result reaches parent, no orphan | **PASS (live, isolated run)**: parent→delegate_research→child row persisted (id=2, parentAgentId correct, COMPLETED)→child fs_read ok→delegate envelope ok with child_agent_id matching the persisted row→parent final answer carries ORBIT-7741→no zombie child run. Earlier runs ✖ were 429 (provider quota) + a harness mkdir bug (fixed) | PASS | `shell/tests/live-production-stack.test.js` LIVE-1; run-5 DB transcript |
| G11 | LIVE-2 three children | REAL core + live | 3 unique completed children, results incorporated | **PASS (live, isolated run after cooldown)**: 3 unique child rows persisted, all COMPLETED with ok tool results, parent final answer carries ALPHA-CODE-11 + BETA-CODE-22 + GAMMA-CODE-33, no cross-contamination, no zombies. Earlier ✖ were purely b.ai 429 quota windows | PASS | `shell/tests/live-production-stack.test.js` LIVE-2; isolated-run DB transcript |
| G12 | LIVE-3 multi-step modify→verify→(correct)→verify | REAL core + live | disk-correct outcome, verified, test untouched | PASS (live, run 3): model fixed both functions, gate `verified`, disk correct, calc.test.js untouched, COMPLETED. Run 2 demonstrated the full fix-retry→signal→correction→re-verify cycle live, ending in honest `verify-exhausted:2` caused by an unpassable HARNESS fixture (asserted add(2,3)==6 for a SUM spec) — harness fixed, production code correct | PASS | same file LIVE-3; run-2/3 DB transcripts |
| G13 | LIVE-4 cancellation | REAL core + live | CANCELLED persisted, no zombie | PASS (live, runs 2+3+4): cancelled cleanly on the real stack every time | PASS | same file LIVE-4 |
| G14 | LIVE-5 final summary after tool messages | REAL core + live | non-empty final summary naming the marker | PASS (live, runs 2+3); run 4 ✖ was model-side shallow summary content (parent row COMPLETED, no HTTP error) | PASS | same file LIVE-5 |
| G15 | Full shell regression | repo root | 0 fails (pre-existing flake isolated) | post-D5: 942 tests / 924 pass / 18 skip / 0 fail (incl. previously flaky Marketplace.installGit passing both post-D5 runs) | PASS | `node --test shell/tests/*.test.js` |
| G16 | UI + Rust regression | repo root | all green | 454/454 UI; cargo suites green | PASS | `npm run test:ui`, `npm run test:core` |
| G17 | Provider incidents classified separately | live | provider errors not blamed on CareerFlow | run-1 401 = b.ai internal auth service timeout (`ainft-chat-service…context deadline exceeded`) — provider-side; recorded, not acted on | PASS | run-1 dump `provider-http-401-*.json` |

## Defects found and fixed this phase

- **D5 (P0)** — loop never pushed the assistant `tool_calls` anchor into the
  model context before tool results; pure-tool-call rounds sent orphan
  `role:'tool'` messages that tools-validating providers reject. Explains every
  Phase 12 "empty-body 400". Fixed in `loop.js`; regression T3.
- **Transient-400 retry** — bounded single retry for empty-body 400s
  (evidence-backed in Phase 12); implementation initially misclassified a
  genuine 400 whose body had already been consumed by the stream_options
  check; fixed with a read-once `text400` capture. Regressions G3/G4.
- **Harness** — LIVE-1/5 fixture missing `docs/` dir (ENOENT); fixed.
