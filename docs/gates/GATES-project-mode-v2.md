# Gates: Project Mode v2 — multi-agent + plan execution + verification

OWNS: core/src/db/project_mode.rs, core/migrations/, shell/src/services/agent/, shell/src/services/project-tools/, shell/src/ipc/project-mode.js, shell/src/preload.cjs, ui/src/features/project-mode/, shell/tests/, ui/tests/, core/tests/

Scope: real Project Mode end-to-end with multi-agent dispatch, plan execution, file-conflict protection, verification gate, and test/fix/retest loop.

## Phase gates (each one verifiable)

- [ ] G1: Native rebuild — `pm_*` methods visible in `core/index.d.ts`; `core: passed=119 failed=0`
- [ ] G2: Real start-agent — IPC `project:start-agent` calls the loop; mock provider drives a 2-step plan to `completed`
- [ ] G3: Plan operational — `parsePlan(plan_json)` returns a DAG; loop respects `depends_on`; `PlanView.svelte` renders status chips
- [ ] G4: Sub-agent architecture — `pm_agents.parent_agent_id`, `role`, `allowed_tools_json`; `delegate_research` / `delegate_coder` tools spawn child agents; children persist + emit final result
- [ ] G5: Scoped context packets — `buildPacket({parentPlan, step, files, summary, tools, outputShape})` produces a deterministic sub-agent initial context
- [ ] G6: File-conflict model — `file_reservations` table; sub-agents acquire before `fs_write`; conflict refused with `path-reserved-by-sibling`
- [ ] G7: Verification-before-completion — `completed` state requires `pm_agents.finished_at` AND a `verify` row in `pm_messages` with `role='status'` and `name='verified'`; reviewer sub-agent runs after the main agent and before `completed`
- [ ] G8: Test/fix/retest — tester sub-agent runs `test_run` after coder; on failure, parent re-dispatches coder with the failure transcript; max 2 fix iterations
- [ ] G9: Provider 429 handling — exponential backoff in `provider.js`; one fallback provider slot in `pm_projects.config_json`
- [ ] G10: Focused regression tests — delegation, parent/child, tool restrictions, file conflicts, plan ordering, verification, failure recovery, cancellation, test/fix/retest, profile/project isolation
- [ ] G11: Full CareerFlow verification gate — `npm test` exit 0, `cargo test` passes, `svelte-check` clean, production build OK
- [ ] G12: Working tree clean — focused commits; no unrelated modifications; no secrets

## Validation commands (run after every meaningful change)

```bash
# Core (Rust)
cd core && cargo test 2>&1 | grep -E "test result:" | awk '{ok+=$4; fail+=$6} END {print "core: passed="ok" failed="fail}'
cargo build 2>&1 | tail -3

# Parity
cd .. && npm run check:ipc 2>&1 | tail -1
npm run check:napi 2>&1 | tail -1
npm run check:esm 2>&1 | tail -1

# Shell
cd shell && node --test tests/agent-loop.test.js tests/project-tools.test.js 2>&1 | tail -5
node --test tests/*.test.js 2>&1 | tail -3
cd .. && npm run test:shell 2>&1 | tail -3

# UI
cd ui && npx vitest run 2>&1 | tail -3
cd .. && npm run test:ui 2>&1 | tail -3

# Full gate
npm test 2>&1 | tail -3

# Build
npm run build 2>&1 | tail -3
```

## Hard constraints

- Do NOT modify DonutBrowser-Integration.
- Do NOT touch the Donutbrowser fork.
- Do NOT reverse-engineer ZCode.exe.
- Do NOT introduce a generic MCP framework, desktop computer-use, arbitrary browser automation, or speculative provider support.
- Do NOT claim "Z Code parity." State exactly which capabilities exist and which are missing.
- Do NOT skip a gate. A gate is met only when its test/command exits zero AND the output matches the expected pattern.
