# Sub-agent file lock manifest

> Authored by the main agent. Sub-agents read this file BEFORE editing anything. If your assigned files collide with another active sub-agent's files, **stop and tell the main agent** — do not stage past it.

## Lane definitions

| Lane | Owning slots | Files this lane may touch |
|---|---|---|
| **UI lane** | sensenova, sensenova-2, openrouter | `ui/src/features/project-mode/**`, `ui/tests/**` |
| **Shell lane** | hcnsec | `shell/src/services/**`, `shell/src/ipc/**`, `shell/tests/**` |
| **Core/Rust lane** | rntm-1, rntm-2 | `core/src/**`, `core/migrations/**` (only ONE sub-agent at a time) |
| **Wiring lane** | opencode | `shell/src/preload.cjs`, `ui/src/features/project-mode/services/**` |
| **Docs/CI lane** | openrouter (when free) | `docs/**`, `README.md`, `.github/**`, `scripts/**` |

## Active sub-agents (current batch)

| Agent ID | Lane | Files claimed | Status |
|---|---|---|---|
| agent_55eaad89 | Core/Rust (RU) | `core/src/db/project_mode.rs`, `core/src/migrations.rs`, `core/careerflow_core.win32-x64-msvc.node`, `core/index.{js,d.ts}`, `ui/src/features/project-mode/components/AgentErrorLog.svelte`, `ui/tests/agent-error-log.test.js`, `ui/src/features/project-mode/components/ProjectWorkspace.svelte` (mount only) | running — DO NOT TOUCH these files |
| agent_a54f15b2 | Core/Rust (RU) | `core/migrations/020_plan_templates.sql`, `core/src/db/project_mode.rs`, `core/src/migrations.rs`, `core/careerflow_core.win32-x64-msvc.node`, `core/index.{js,d.ts}`, `ui/src/features/project-mode/components/PlanTemplates.svelte`, `ui/tests/plan-templates.test.js`, `ui/src/features/project-mode/components/ProjectWorkspace.svelte` (mount only) | running — DO NOT TOUCH these files |
| agent_6c9d3b3d | UI (UI) | `ui/src/features/project-mode/components/AgentRunHistory.svelte`, `ui/tests/agent-run-history.test.js`, `ui/src/features/project-mode/components/ProjectWorkspace.svelte` (mount only) | running — DO NOT TOUCH these files |
| agent_223df277 | Docs/CI | `scripts/pre-commit.mjs`, `scripts/install-hooks.sh` | running (RETRY for pre-commit hook) — DO NOT TOUCH these files |

## Collision avoidance

**Rule 1:** Two sub-agents in the same lane may NOT edit the same file. The lock manifest above is the source of truth.

**Rule 2:** `ProjectWorkspace.svelte` is a high-contention file. Only the agent that *owns the new component* may add the mount line. Other agents MUST NOT touch it.

**Rule 3:** `core/careerflow_core.win32-x64-msvc.node` is a binary. Only ONE sub-agent may rebuild it per batch. If two Rust agents land, the second one's rebuild will overwrite the first one's binary; whoever commits last wins.

**Rule 4:** `preload.cjs` is touched by both Shell and Wiring lanes. If a UI agent needs a new preload binding, it must wait for the Wiring-lane agent OR include the binding in its own commit (with the Wiring lane's permission).

## After dispatch

When a sub-agent finishes, it reports its commit hash to the main agent. The main agent updates the registry (`sub-agent-registry.md`) and the lock manifest.

## Bounded work per agent

- ≤ 5 files
- 1 commit
- 1 commit message
- Tests in the same commit
- Do NOT touch files outside the assigned lane without main-agent approval
