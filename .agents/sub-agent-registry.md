# Sub-agent registry

Append a row for every sub-agent launched. Keep the table accurate. The main agent uses this to coordinate handoffs and to remember what was done.

| ID | Task | Started | Ended | Status | Commit |
|---|---|---|---|---|---|
| agent_6b8eb571 | ZCode skill + plugin scan | 2026-08-30 | 2026-08-30 | completed | (no commit — read-only) |
| agent_c24c081c | Full CareerFlow audit | 2026-08-30 | 2026-08-30 | completed | (no commit — read-only) |
| agent_fecfb2f2 | requiresApproval dedupe | 2026-08-30 | 2026-08-30 | completed | `3fd1c86` |
| agent_ea07f805 | Token budget interrupt | 2026-08-30 | 2026-08-30 | completed | `44fe82e` |
| agent_fded874c | parent_agent_id column | 2026-08-30 | 2026-08-30 | completed | `84b3af7` |
| agent_1261db5d | per-agent projectRoot | 2026-08-30 | 2026-08-30 | completed | `2ccf826` |
| agent_a7795829 | Skills + Plugins + MCP | 2026-08-30 | 2026-08-30 | completed | `990eef2` |
| agent_b69177cb | Project intelligence layer | 2026-08-30 | 2026-08-30 | completed | (commit pending — untracked) |
| agent_d6a062e0 | Sub-agent tree UI | 2026-08-30 | 2026-08-30 | partial (8 lines, finished by main) | `903c7c9` (main finished) |
| agent_015b27b6 | Commands + Hooks | 2026-08-30 | 2026-08-30 | completed | `8b36bdb` |
| agent_73a176ed | Memory layer | 2026-08-30 | 2026-08-30 | completed | `886656a` |
| agent_328f41eb | Multi-step execution engine | 2026-08-30 | 2026-08-30 | completed | `9d50e86` |
| agent_5d9491b4 | Real LLM provider + 429 | 2026-08-30 | 2026-08-30 | completed | `27002da` |
| agent_9448d9dd | E2E final round fix verify + commit | 2026-08-31 | 2026-08-31 | completed | `5c6acc4` |
| agent_6fc58f1a | Ponytail debt audit + GATES ledger + V3 summary | 2026-08-31 | 2026-08-31 | completed | (read-only + V3-FINAL-SUMMARY.md) |
| agent_03aef2ee | Marketplace git-source TODO fix | 2026-08-31 | 2026-08-31 | completed | `9b242b7` |
| agent_6b8b4af5 | Parity check:napi + check:esm + test-count fixes | 2026-08-31 | 2026-08-31 | FAILED (rate-limit) | (none) |
| agent_668dea38 | Parity + audit fix (RETRY of 6b8b4af5) | 2026-08-31 | 2026-08-31 | completed | `20953a4` |
| agent_21d7007c | Final integration commit (REPORT.md + registry + V3-FINAL-SUMMARY.md) | 2026-08-31 | 2026-08-31 | completed | `816dd0e` |
| agent_8f834f68 | audit.test.js withTempDir fix (audit.test.js only) | 2026-08-31 | 2026-08-31 | FAILED (rate-limit) | (fix landed by main as `4630f73`) |
| agent_2c2215c8 | Build smoke + GATES ledger finalization | 2026-08-31 | running | active | (pending) |
| agent_e8434611 | REPORT.md V3 final wrap-up | 2026-08-31 | running | active | (pending) |
| agent_78857132 | Curated MCP server list (filesystem + fetch) | 2026-08-31 | running | active | (pending) |
| agent_b654decd | Live LLM smoke nightly CI lane | 2026-08-31 | running | active | (pending) |
| agent_c4ae9a12 | Sub-agent run telemetry (start/end/list + UI) | 2026-08-31 | running | active | (pending) |
| agent_d08b91c8 | Plugin hot-reload (no app restart) | 2026-08-31 | running | active | (pending) |
| agent_05d033fb | Audit-log retention policy (per-profile, configurable) | 2026-08-31 | running | active | (pending) |
| agent_e2fb90f9 | Skill inventory panel (rntm-2) | 2026-08-31 | 2026-08-31 | FAILED (rate-limit) | (partial — component + IPC landed, unwired) |
| sensenova | Skill inventory panel (finish rntm-2's work: wire into ProjectWorkspace + add tests) | 2026-08-31 | 2026-08-31 | completed | `12aefda` |
| sensenova-2 | Agent error log (failed runs + retry, IPC + UI + 7 tests) | 2026-08-31 | 2026-08-31 | completed | `1630af8` |

## Active sub-agents right now (7 of 7 slots)

- agent_2c2215c8 — Build smoke + GATES ledger finalization
- agent_e8434611 — REPORT.md V3 final wrap-up
- agent_78857132 — Curated MCP server list (filesystem + fetch)
- agent_b654decd — Live LLM smoke nightly CI lane
- agent_c4ae9a12 — Sub-agent run telemetry (start/end/list + UI)
- agent_d08b91c8 — Plugin hot-reload (no app restart)
- agent_05d033fb — Audit-log retention policy (per-profile, configurable)

## Recently-completed sub-agents (last 2)

- agent_21d7007c — Final integration commit (816dd0e)
- agent_03aef2ee — Marketplace git-source TODO fix (9b242b7)

## Handoff notes

- Multi-step engine sub-agent: introduced `pickNextStep` + `classifyStall` + `nextAfterMark` in `shell/src/services/agent/exec-dag.js`. Stall detection handles `stalled-with-running` (mark stuck step failed), `stalled-with-failed` (bail to FAILED), generic stalls (reset and re-enter). The model still drives planning; the engine enforces that the same step isn't re-attempted when nothing new is unlocked.
- LLM provider sub-agent: `createOpenAiProvider` is now the production default (via `resolveDefaultProvider` in `loop.js`); mock remains the test default + offline fallback. 429 with `Retry-After`, 401 (no retry, `'auth-failed'`), 5xx (1 retry), 4xx (terminal), network failure (1 retry), malformed SSE → error event. Abort signal respected between retries.
| agent_sensenova | Goal quick-start suggestions (chips UI + tests) | 2026-08-31 | 2026-08-31 | completed | `dfd04fa` |
| agent_sensenova-1 | GATE 17 v8 — sub-agent poll 500->2000ms (bottleneck #3) | 2026-09-01 | 2026-09-01 | completed | `b341004` |
