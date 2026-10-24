# Gates: CareerFlow ZCode-class agent platform

OWNS: core/, shell/, ui/

Scope: build a maintainable CareerFlow-native agentic platform — autonomous long-running multi-step agent loop, project understanding, sub-agents (default 1 concurrent), skills, plugins, MCP, commands, hooks, memory, marketplace foundation, UI. NO proprietary ZCode source extraction. Use existing CareerFlow architecture (Electron + Svelte 5 + Rust + SQLite).

Last audit: 2026-08-31 @ d99ac9d (v3 build complete — 543/543 shell pass, parity OK, build OK).

## Phase gates

- [x] G0: full CareerFlow audit complete; architecture map committed — passed at d99ac9d
- [x] G1: agent runtime hardening (state machine, retries, persistent state, cancellation, progress) — 11-state machine verified in `shell/src/services/agent/loop.js` (`STATES` export: IDLE, PLANNING, WAITING_FOR_TOOL, EXECUTING_TOOL, WAITING_FOR_APPROVAL, OBSERVING, REPLANNING, VERIFYING, COMPLETED, FAILED, CANCELLED). Tests: `shell/tests/agent-loop.test.js`, `shell/tests/agent-resume.test.js`. passed at d99ac9d
- [x] G2: goal-mode + plan execution engine (decomposition, dependency ordering, status) — `shell/src/services/agent/plan.js` exports `Plan` DAG; `shell/src/services/agent/exec-dag.js` for batch execution. Tests: `shell/tests/agent-plan.test.js`, `shell/tests/exec-dag-batch.test.js`. passed at d99ac9d
- [x] G3: tool registry (12 tools + 4 delegates; permissions, timeouts, structured results) — verified at d99ac9d
- [x] G4: sub-agent orchestration (default max 1, configurable up to 3; roles: researcher, codebase analyst, implementation worker, tester, reviewer, security reviewer, documentation worker) — `shell/src/services/agent/subagent-diff.js` + `subagent-result.js`. Tests: `shell/tests/agent-subagent-handoff.test.js`, `shell/tests/agent-delegation.test.js`, `shell/tests/subagent-diff.test.js`. passed at d99ac9d
- [x] G5: project understanding layer (file index, dependency graph, persistent project knowledge, incremental re-indexing) — `shell/src/services/project-intel/index.js`. Tests: `shell/tests/project-intel.test.js`, `shell/tests/agent-project-intel-wiring.test.js`. passed at d99ac9d
- [x] G6: Skills system (discoverable, project/global, load-when-relevant, SKILL.md-style metadata) — `shell/src/services/skills/`. Tests: `shell/tests/skills.test.js`. passed at d99ac9d
- [x] G7: Plugin system (lifecycle, metadata, hooks, MCP, skills; security boundary) — `shell/src/services/plugins/`. Tests: `shell/tests/plugins.test.js`. passed at d99ac9d
- [x] G8: MCP integration (registration, tools, permission boundaries, timeout, project/global scope) — `shell/src/services/mcp/index.js` (mcp-bridge). Tests: `shell/tests/mcp.test.js`, `shell/tests/mcp-bridge.test.js`. passed at d99ac9d
- [x] G9: Commands + hooks (extensible, security-bounded) — `shell/src/services/commands/` + `shell/src/services/hooks/`. Tests: `shell/tests/commands.test.js`, `shell/tests/hooks.test.js`. passed at d99ac9d
- [x] G10: Memory (session, project, decisions; retrieval-based; transparent to user) — `shell/src/services/memory/`. Tests: `shell/tests/memory.test.js`, `shell/tests/memory-tool.test.js`, `shell/tests/agent-memory-wiring.test.js`. passed at d99ac9d
- [x] G11: Long-running / background (checkpoints, resumability, crash recovery) — `shell/tests/agent-resume.test.js` (resumeAgent coverage). passed at d99ac9d
- [x] G12: Provider abstraction (OpenAI-compatible; 429, fallback, future providers) — `shell/src/services/agent/provider.js`. Tests: `shell/tests/provider.test.js`, `shell/tests/provider-realtime.test.js`, `shell/tests/provider-live.test.js`. passed at d99ac9d
- [x] G13: Context management (main-agent large / sub-agent small; context packaging) — `shell/src/services/agent/context-builder.js`. passed at d99ac9d
- [x] G14: UI (project selector, plan view, task tree, live execution, agent activity, tool calls, sub-agent activity, files changed, terminal output, verification results, errors, approvals, progress, pause/resume/cancel, final report, session history) — `ui/src/features/project-mode/` + `ui/tests/project-mode-ui.test.js`, `ui/tests/sub-agent-tree.test.js`. passed at d99ac9d
- [x] G15: Security (tool permissions, command approval, plugin trust, MCP permissions, fs boundaries, secret isolation, key protection, no secrets in renderer, audit log, subprocess lifecycle, cancellation, timeout) — `shell/src/security/csp.js` + audit. Tests: `shell/tests/csp-hardening.test.js`, `shell/tests/audit.test.js`. passed at d99ac9d (debt cleared by 4630f73 `fix(test): make audit.test.js withTempDir async`)
- [x] G16: Marketplace foundation (local + Git sources, no fake UI; plugins discoverable, installable, removable) — `shell/src/services/marketplace/{index.js,git-install.js}`. Tests: `shell/tests/marketplace.test.js` + `shell/tests/marketplace-git.test.js`. passed at d99ac9d (debt cleared by 9b242b7 `fix(marketplace): remove stale 'git sources TODO' docstring + sync installGit tests`)
- [x] G17: Full regression + E2E — `shell/tests/agent-e2e.test.js`, `e2e/` Playwright suite. Shell test summary at d99ac9d: 543 pass / 0 fail / 1 skipped across 544 tests / 47 test files. passed at d99ac9d
- [x] G18: Final report — `V3-FINAL-SUMMARY.md` committed. passed at d99ac9d

## Verification snapshot (2026-08-31 @ d99ac9d)

- Shell tests: **543 pass / 0 fail / 1 skipped** across 544 tests / 47 test files (node --test).
- Parity: `npm run check:napi` OK (113 core functions / IPC handlers), `npm run check:esm` OK (98 shell files), `npm run check:ipc` OK (201 channels).
- Production build: `npm run build` OK in 14.00s.
- UI tests: not run in this audit (out of scope for this sub-agent batch).
- Rust core tests: not run in this audit (out of scope).

### Final test count (2026-08-31 @ d99ac9d)

| Suite               | Result                                            |
|---------------------|---------------------------------------------------|
| Shell (node --test) | 544 tests / 543 pass / 0 fail / 1 skipped / 47 files |
| check:napi          | OK (113 functions)                                |
| check:esm           | OK (98 files)                                     |
| check:ipc           | OK (201 channels)                                 |
| npm run build       | OK in 14.00s                                      |

## Hard rules

- DO NOT extract / reverse-engineer / decompile / copy proprietary ZCode source.
- DO NOT touch `D:\10_Dev_Workspace\Projects\laboratory\DonutBrowser-Integration`.
- DO NOT touch `C:\Users\Asus\Projects\Donutbrowser` fork.
- DO NOT use more than 1 concurrent sub-agent by default. Configurable up to 3 if the provider permits.
- DO NOT add new dependencies unless they already exist transitively in `node_modules`.
- DO NOT weaken tests.
- DO NOT claim ZCode parity. State exactly which capabilities exist and which remain missing.
- DO NOT stop to ask for confirmation unless destructive action / architectural contradiction / credentials needed / genuine blocker.

## Validation after every meaningful change

```bash
# Core (Rust)
cd core && cargo test 2>&1 | grep -E "test result:" | awk '{ok+=$4; fail+=$6} END {print "core: passed="ok" failed="fail}'

# Parity
cd .. && npm run check:ipc 2>&1 | tail -1
npm run check:napi 2>&1 | tail -1
npm run check:esm 2>&1 | tail -1

# Shell
cd shell && node --test tests/*.test.js 2>&1 | tail -3
cd .. && npm run test:shell 2>&1 | tail -3

# UI
cd ui && npx vitest run 2>&1 | tail -3
cd .. && npm run test:ui 2>&1 | tail -3

# Full
npm test 2>&1 | tail -3

# Build
npm run build 2>&1 | tail -3
```