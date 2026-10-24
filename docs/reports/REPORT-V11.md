# CareerFlow Project Mode v11 — Final Report (Live LLM Integration + Real Project Mode Acceptance)

## 1. Workspace
`D:\10_Dev_Workspace\Projects\laboratory\CareerFlow` (verified). CareerFlow-Opus NOT used; no new repository created.

## 2. Starting HEAD
`500cf83` (Phase 10 final).

## 3. Ending HEAD
See §4 / §30 (final docs commit).

## 4. Commits created in this run
| SHA | Subject |
|---|---|
| `342557c` | fix(provider): tool-call fragment accumulation + streaming usage + verify command tokenization |
| (mid-run) | fix(provider): generalize text-form tool-call extraction (tagged/bare-JSON/XML-known-tool) |
| (mid-run) | fix(provider): parse OpenAI tool_calls envelope in text + wrapper-less envelope |
| (final) | docs: REPORT-V11.md + GATES-PHASE11.md |

## 5–6. Provider / model
OpenAI-compatible endpoint from the stored credential (`pm-secrets.json` via `CAREERFLOW_USER_DATA` — CareerFlow's existing mechanism; key never in-repo, never logged). Model: `deepseek/deepseek-v4-flash`. No provider-specific code: all fixes are generic to the OpenAI-compatible wire contract plus CareerFlow's declared tool list.

## 7. Live connectivity (GATE 1) — LIVE-TESTED ✔
Auth + endpoint + model + SSE parsing verified through `createOpenAiProvider` via `provider-live.test.js` (text deltas + clean finish in 2.8–3.6 s).

## 8. Streaming (GATE 2) — LIVE-TESTED ✔
`live-project-mode.test.js` G2: full agent-loop round trip (goal → model stream → verify gate → final summary). No duplicated/empty assistant messages; run slot cleared. Elapsed 6.9–12.8 s across runs.

## 9. Tool calling (GATE 3) — LIVE-TESTED: PARTIAL (model-limited)
Tool calls DO execute end-to-end when the model emits them in a recognizable form (G4 read files and answered correctly live; delegate children completed live in G8 runs). However the model is unreliable across a full task — see §22/G19. Provider hardening shipped: native fragment accumulation, tagged `<tool_call>{json}`, bare/fenced JSON, XML-with-declared-tool-name blocks, OpenAI `tool_calls` envelope (with and without `function` wrapper). 18/18 provider regression tests.

## 10. Project Intelligence (GATE 4) — LIVE-TESTED ✔
Intel index built (`indexProject` — the production UI trigger), relevant files ranked into the context packet, and the live model answered a repo-comprehension question correctly using the packet (25–42 s).

## 11. Live Project Mode dev task (GATES 5–6) — NOT RELIABLY ACHIEVED WITH THIS MODEL
The harness fixture (deliberately wrong `add()` + real `node calc.test.js` subprocess) works: the pre-agent run genuinely fails, the verify gate runs the real command (the tokenizer fix was required for that). But the model never sustained tool usage across read→edit→retest in 8 runs — root cause in §22/G19. MOCK-TESTED equivalent (full fail→fix→retest→verify lifecycle): gate12-failure-fix-retest + agent-fix-retry + agent-e2e, all green.

## 12. Live DAG (GATE 7) — MECHANICS MOCK-STRESS-TESTED; LIVE MODEL-DRIVEN: PARTIAL
Seeded A,B,C+D plan completes with exactly-once file reads in mock (50×, gate4/gate5). Live runs repeatedly fail on model protocol drift (§22), not on DAG mechanics.

## 13. CareerFlow sub-agents (GATE 8) — LIVE-TESTED: PARTIAL
Live delegate runs spawned real children that COMPLETED (child lifecycle, telemetry, no zombies — proven live). Parent continuation then hit the same model drift. Mock: agent-subagent-handoff + gate10 propagation suite green.

## 14. Cancellation (GATE 9) — LIVE-TESTED ✔
Mid-run cancel of a live streaming agent: CANCELLED persisted, no zombie run slot, idempotent second cancel. (Phase 10 propagation work re-validated under real execution.)

## 15. Recovery — MOCK-STRESS-TESTED (20×, Phase 10); live restart not separately exercised this phase.

## 16. Memory (GATE 11) — LIVE-TESTED ✔
Project memory fact recalled through the context packet by the live model (exact 4-digit answer); cross-profile isolation held (decoy PIN never surfaced).

## 17. Skills (GATE 12) — MOCK-TESTED (gate8-skills-affect-execution, gate10-11 loop integration). Live skill run skipped for cost; selection logic unchanged this phase.

## 18. Plugins (GATE 13) — MOCK-TESTED (gate9-plugin-lifecycle, gate11-v8-plugin-audit, gate12-plugin-code). No untrusted remote install performed, per brief.

## 19. MCP (GATE 14) — FIXTURE-TESTED (gate7-mcp-e2e with a fake stdio server). REAL ECOSYSTEM COMPATIBILITY NOT YET VERIFIED.

## 20. UI E2E (GATE 15) — SPEC AUTHORED; BLOCKED BY ENVIRONMENT
`e2e/project-mode-lifecycle.spec.js` drives the real app over `window.careerflow.projectMode` (create project → goal → seeded plan → start → poll to COMPLETED → transcript + verified status). Electron launch fails in this environment at main-process load (`SyntaxError: Unexpected token 'export'` under Playwright's Electron loader); the pre-existing `donut-lifecycle.spec.js` control fails identically — the blocker predates this phase.

## 21. Performance (GATE 16) — measured live: ~0.9–3.6 s to first tokens; full trivial task 6.9–12.8 s; comprehension task 25–42 s; delegation task 36–58 s (model latency dominates; no optimization attempted).

## 22. Bugs discovered (all root-caused; layers named)
1. **provider** — fragmented `delta.tool_calls` emitted per-fragment (broken name/args). FIXED + regression.
2. **provider** — streaming usage requires `stream_options.include_usage`; some providers 400 on it. FIXED (send + 400-fallback) + regression.
3. **verify** — `test_command` passed as a bare execFile executable ("node x.js" → REPL hang). FIXED (tokenizer) + regression.
4. **provider** — text-form tool calls invisible to the loop (5+ encodings observed across runs: `<tool_call>{json}`, bare/fenced JSON, XML-with-tool-name tags, OpenAI `tool_calls` envelope with and without `function` wrapper). FIXED: validated extraction of all observed shapes + regression tests for each.
5. **MODEL (not fixed — model limitation)** — deepseek/deepseek-v4-flash does not reliably sustain function calling across a multi-step task: across 8 live runs it alternated between correct native calls, ≥6 different text encodings, and pure narration ("I will search…") with no call. This is the sole remaining blocker for GATES 5–8 live.

## 23. Bugs fixed
See §22 items 1–4 (all shipped with regression tests; 18/18 provider tests, 5/5 verify tests).

## 24. Regression tests added
`shell/tests/provider-streaming.test.js` (8), `shell/tests/agent-verify.test.js` tokenizer block, `shell/tests/live-project-mode.test.js` (9 env-gated live gates), `e2e/project-mode-lifecycle.spec.js`.

## 25. Complete test totals
Final `npm test` (checks + smoke shell + UI + cargo) and the full shell directory were re-run after all changes; results recorded in GATES-PHASE11.md G22 (provider 18/18; verify 5/5; full suite totals as measured at end of run).

## 26. Security
No new trust boundary. Credential handled exclusively via the existing store; key never in repo/logs/reports. Final secret audit: git diff/status/logs/reports/fixtures/screenshots scanned — clean.

## 27. ZCode-style capability gap matrix (user-visible capabilities; no proprietary code referenced)
| Capability | CareerFlow now | Desired experience | Gap | Priority |
|---|---|---|---|---|
| Reliable multi-step live execution | Works with protocol-reliable models; flash-tier drifts | Every-turn tool discipline | Model capability (or loop-level re-prompt on no-op rounds) | P0 |
| Text-form tool-call tolerance | 6 encodings covered | — | Long tail unknown | P2 |
| Loop re-prompt on narration-only round | Absent (text-only round closes the step) | Nudge + bounded retries | Loop change (breaks many mock contracts; design first) | P0 (after evidence) |
| Streaming usage/token accounting | Sent include_usage; tolerant when absent | Accurate budgets | Provider-dependent | P2 |
| Project Mode UI E2E | Spec ready | Green in CI | Electron+Playwright ESM load in this env | P1 |
| MCP real-ecosystem check | Fixture only | One real server | Not attempted | P2 |
| Live sub-agent quality | Children complete; parent drifts | Full parent-child loops | Same model limitation | P0 (same root) |

## 28. Remaining limitations
- GATES 5–8 live: blocked by model function-calling unreliability (evidence above), NOT by loop/tool/persistence layers (mock-proven).
- UI E2E blocked by Electron/Playwright ESM load in this environment.
- MCP real-server check not performed.

## 29. Next priorities
P0: (a) loop-level no-op-round re-prompt (design against mock contracts); (b) validate end-to-end with a function-calling-reliable model on the same endpoint; (c) fix Electron E2E load. P1: real MCP server check; live Skills run. P2: streaming-usage fallback estimation; text-format long-tail.

## 30. Final git state
Clean tree except pre-existing untracked artifacts (`.agents/`, `.ua/`, `GATES-manager*.md`, `target/`, `test-results/`). No credentials anywhere.

## 31. Capability classification (end of Phase 11)
| Capability | Classification |
|---|---|
| Provider connectivity/auth/SSE | IMPLEMENTED / LIVE-TESTED |
| Streaming integrity through the loop | IMPLEMENTED / LIVE-TESTED |
| Tool calling (native + text forms) | IMPLEMENTED / LIVE-TESTED (per-call) / PARTIAL (task-long, model-limited) |
| Project Intelligence live | IMPLEMENTED / LIVE-TESTED |
| Memory live recall + isolation | IMPLEMENTED / LIVE-TESTED |
| Cancellation live | IMPLEMENTED / LIVE-TESTED |
| 401 handling live | IMPLEMENTED / LIVE-TESTED (429/5xx/timeout mock) |
| Real dev task live (fail→fix→retest) | IMPLEMENTED (mock-proven) / NOT RELIABLY LIVE with this model |
| Live DAG / sub-agents | PARTIAL (mechanics proven; task-long drift model-side) |
| Skills / Plugins | IMPLEMENTED / MOCK-TESTED |
| MCP | IMPLEMENTED / FIXTURE-TESTED |
| Project Mode UI E2E | SPEC IMPLEMENTED / BLOCKED (env) |

## 32. Final acceptance answer

**"Can CareerFlow Project Mode perform a real developer task from start to finish using a live LLM?"**

**NOT YET — with the current model.** The exact blocker: deepseek/deepseek-v4-flash via this endpoint does not reliably sustain the tool-calling protocol across a multi-step task — across 8 live runs it alternated between correct native tool calls and (at least) six different invented text encodings, sometimes degenerating to pure narration with no call at all. CareerFlow's provider layer was hardened to execute every encoding observed (with regressions), and the layers beneath the model are proven: live-verified streaming, cancellation, 401 handling, memory recall with isolation, Project-Intel-driven comprehension, plus the full fail→fix→retest→verify lifecycle under the mock provider (Phase 10 suite). The evidence points at the model, not the architecture: the same loop that fails live with the flash model passes the identical lifecycle mock-driven, and single-turn live tool calls DO execute correctly. Re-running the same gates against a function-calling-reliable model is the single highest-value next step.
