# CareerFlow production-readiness execution plan

## Contract

Baseline: `400aa46 feat(agent): complete Phase 19 authorization and verification`. Working tree must begin and end each committed phase clean. Preserve Phase 17–19 behavior unless evidence requires change. Never touch `CareerFlow-Opus` or embedded-browser implementation before architecture investigation.

## Depth tree

| ID | Deliverable | Owner | Needs | State |
|---|---|---|---|---|
| audit-arch | Full repository/architecture/product gap audit | main | — | COMPLETE |
| audit-sec | Electron/IPC/security/profile isolation audit | main | — | COMPLETE |
| audit-core | Rust/SQLite/NAPI/migration/recovery audit | main | — | COMPLETE |
| audit-agent | Agent/Goal/Project Mode lifecycle audit | main | — | COMPLETE |
| audit-ui | UI/UX/accessibility/core-flow audit | main | — | COMPLETE |
| audit-browser | Donut/Wayfern/browser architecture investigation | main | — | COMPLETE |
| roadmap | Integrate audits into prioritized executable roadmap | main | all audits | COMPLETE |
| execution | Implement highest-risk gaps incrementally | main + bounded workers | roadmap | NEXT |
| integration | Full cross-layer verification and E2E | main + reviewers | execution | WAITING |
| release | Docs, final security review, build/dist verification, clean Git | main | integration | WAITING |

## Rules

- Maximum 6 live workers; no overlapping file ownership.
- Audit workers are read-only unless explicitly promoted to an implementation task after triage.
- No embedded-browser code during the audit/browser-investigation stage.
- Every discovered defect is classified: critical/high/medium/low, real vs informational, reproduction/evidence, owner, regression test, and fix order.
- A passing test suite is evidence, not proof of product completeness.

## Verification contract

Root completion requires: all required audit findings dispositioned; no known critical/high security defect; no known broken core flow; ownership/profile isolation verified; agent lifecycle verified; browser architecture decision documented and, where technically viable, implemented and tested; relevant Rust/shell/UI/IPC/NAPI/ESM/E2E/build gates pass; security scan passes; Git clean.
