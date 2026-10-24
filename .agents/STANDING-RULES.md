# Standing rules for the CareerFlow Project Mode long-running session

> Authored by the main agent. Read this every turn before deciding what to do.

## Sub-agent rules

1. **Pool ceiling is 7 active sub-agents** (canonical order from `C:\Users\Asus\.zcode\AGENTS.md`):
   1. `rntm-1` — rntm.sh / free (slot 1)
   2. `rntm-2` — rntm.sh / free (slot 2)
   3. `hcnsec` — kat-coder-pro-v2.5 (slot 3)
   4. `sensenova` — sensenova-6.8-flash-lite (slot 4)
   5. `sensenova-2` — sensenova-6.7-flash-lite (slot 5)
   6. `opencode` — OpenCode Zen / laguna-s-2.1-free (slot 6)
   7. `openrouter` — openrouter/free (slot 7)
   **Utilization ≠ dispatch count.** 7 active doing overlapping thin work is worse than 5 active doing substantively different hard work.
2. **Tier the dispatch.** Mix the slots, don't fill them blindly:
   - **Heavy hitters** (rntm-1, rntm-2, hcnsec): 1-2 at a time on hard multi-file work (NAPI rebuilds, Core/Rust schema changes, full features that touch ≥3 layers)
   - **Steady producers** (sensenova, sensenova-2, opencode): 2-3 at a time on mid-size features (single Svelte component + 1 IPC + 1 test, no Rust changes)
   - **Light finishers** (openrouter + free slot): 1-2 at a time on quick wins (docs, CHANGELOG, single-file refactors)
3. **Coarse features, not fine ones.** Dispatch one sub-agent per "feature-shaped" outcome, not 7 thin overlapping UI panels. If two tasks could be one commit, they should be.
4. **Stop when value drops.** If the next candidate task is ≤2 minutes or trivial, the main agent does it. Sub-agents are for work that needs their 200K context.
5. **Re-launch on failure.** Rate-limit, error, timeout → launch a replacement with the same prompt. Don't silently fall back to main-agent work that the sub-agent would have done.
6. **Wait for results before re-dispatching.** Don't queue work speculatively. After a batch of N finishes, triage what landed, what's stuck in the working tree, and what's still missing — THEN dispatch the next batch.
7. **Main agent works in parallel.** While sub-agents run, the main agent does ≤2-minute focused work on a non-conflicting file (registry updates, REPORT.md polish, the next integration commit).
8. **No file collisions.** Sub-agents and main agent must not edit the same file simultaneously. The `LOCKS.md` manifest is the source of truth for which files are claimed.
9. **Every dispatch prompt must include a "why this needs a 200K sub-agent" line.** If the sub-agent can't justify it, the main agent should do the work instead.

## Sub-agent context budget

Each sub-agent has approximately **200K tokens of context**. The full system prompt (this file, the registry, the brief, the project map) can consume a noticeable portion of that. Use that budget efficiently:

- **Do not paste the entire architecture map into a sub-agent prompt.** Reference the file paths and let the sub-agent read them.
- **Do not restate the entire brief.** Reference the phase gate + the existing files; let the sub-agent read the spec.
- **Prefer focused prompts** that name the specific files to touch + the specific behavior to change + the specific tests to add.
- **Smaller prompts = more context for the sub-agent to do useful work.**

If a task is too large for one sub-agent, split it into 2-3 sub-tasks with separate sub-agents, each with a tight focused prompt.

## Skills (always apply when relevant)

The main agent AND every sub-agent MUST use these skills when relevant:

- `[$unlazy](C:\Users\Asus\.agents\skills\unlazy\SKILL.md)` — gate/ledger discipline. Maintain `GATES-zcode-platform.md` for every major phase. A gate is met only when its verification command exits zero.
- `[@ponytail](plugin://ponytail@ponytail)` — smallest-correct-solution, no over-engineering, reuse existing, no new dependencies unless transitively present.
- `[@understand-anything](plugin://understand-anything@understand-anything)` — repository understanding, dependency analysis, before modifying architecture.
- `[@superpowers](plugin://superpowers@claude-plugins-official)` — `subagent-driven-development`, `dispatching-parallel-agents`, `verification-before-completion`, `test-driven-development`.
- `[@frontend-design](plugin://frontend-design@claude-plugins-official)` — UI design quality.
- `[@superdesign](plugin://superdesign@claude-plugins-official)` — major visual exploration only; do not waste credits on trivial UI changes.

Every sub-agent prompt MUST include a single line near the top:

> "Apply the following skills as relevant: unlazy, ponytail, understand-anything, superpowers, frontend-design, superdesign. Read `.agents/STANDING-RULES.md` first."

## What this session is

- CareerFlow Project Mode = genuine autonomous long-running AI project environment
- ZCode = behavioural reference only; do NOT extract / reverse-engineer / decompile proprietary source
- Active workspace: `D:\10_Dev_Workspace\Projects\Laboratory\CareerFlow` (the ONLY one)
- Do NOT touch: `CareerFlow-Opus`, `CareerFlow-CHATGPT`, `CareerFlow-CHATGPT V2`, `CareerFlow-claude`, `CareerFlow-Gemini`, `DonutBrowser-Integration`, `C:\Users\Asus\Projects\Donutbrowser`
- Branch: `main`

## Sub-agent registry (track every dispatch)

When a sub-agent is launched, append a row to `\.agents\sub-agent-registry.md` with: id, task, started, ended, status, commit. When it ends, fill the row. Use this for handoffs.

## Sub-agent prompt template

Every sub-agent prompt should follow this skeleton (fill in the [BRACKETS]):

```
You are a focused sub-agent for CareerFlow (repo root: D:\10_Dev_Workspace\Projects/laboratory/CareerFlow).
Do NOT touch C:\Users\Asus\Projects\Donutbrowser. Do NOT touch the DonutBrowser-Integration folder.

Apply the following skills as relevant: unlazy, ponytail, understand-anything, superpowers, frontend-design, superdesign. Read `.agents/STANDING-RULES.md` first.

# Task: [TASK NAME]

[CONTEXT — 2-3 lines of why this matters, what the audit found, etc.]

# Background — current state
[1-3 paragraphs of the existing files + their line numbers + the relevant data shapes]

# Design (smallest correct)
[Concrete TypeScript signatures + schema + storage path]

# Steps
1. [Step 1: read X, then create Y at Z]
2. [Step 2: edit Y to do Z]
3. [Step 3: write tests in tests/]
4. [Step 4: run the gate]
5. [Step 5: commit with a focused message]

# Validation
[Concrete commands the sub-agent runs]

# Strict rules
- Do NOT touch the Rust NAPI surface. (when relevant)
- Do NOT touch any existing file outside the scope.
- Do NOT add new dependencies (the existing better-sqlite3 / fetch / child_process are sufficient).
- If a test fails, fix the source, not the test.
- Commit as one focused commit with a descriptive message.

Report concisely. ≤ 30 lines. Do not exceed your context budget with narrative.
```
