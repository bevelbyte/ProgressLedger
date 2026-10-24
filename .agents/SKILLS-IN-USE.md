# Skills in use for the CareerFlow Project Mode long-running session

The main agent AND every sub-agent MUST use these skills when relevant:

- [$unlazy](C:\Users\Asus\.agents\skills\unlazy\SKILL.md) — gate/ledger discipline. Maintain `GATES-zcode-platform.md` for every major phase. A gate is met only when its verification command exits zero.
- [@ponytail](plugin://ponytail@ponytail) — smallest-correct-solution, no over-engineering, reuse existing, no new dependencies unless transitively present.
- [@understand-anything](plugin://understand-anything@understand-anything) — repository understanding, dependency analysis, before modifying architecture.
- [@superpowers](plugin://superpowers@claude-plugins-official) — `subagent-driven-development`, `dispatching-parallel-agents`, `verification-before-completion`, `test-driven-development`.
- [@frontend-design](plugin://frontend-design@claude-plugins-official) — UI design quality.
- [@superdesign](plugin://superdesign@claude-plugins-official) — major visual exploration only; do not waste credits on trivial UI changes.

Every sub-agent prompt MUST include a single line near the top:

> "Apply the following skills as relevant: unlazy, ponytail, understand-anything, superpowers, frontend-design, superdesign. Read `.agents/STANDING-RULES.md` first."

The .agents/ directory tracks:
- STANDING-RULES.md — sub-agent limits, retry rules, prompt template
- SKILLS-IN-USE.md — this file
- sub-agent-registry.md — every dispatch
