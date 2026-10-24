# Phase 19 — integrated browser + Agent Everywhere continuation

OWNS: shell/src/**, ui/src/**, e2e/**, scripts/**, docs/**

- [ ] G1: current Phase 18 browser boundary is revalidated from the actual repository state and the chosen next implementation is backed by source evidence.
  CHECK: git status --short --branch; git rev-parse HEAD
  EXPECT: ## main

- [ ] G2: selected Phase 19 implementation has focused regression coverage and passes its targeted test suite.
  CHECK: npm run test:shell
  EXPECT: 0 fail

- [ ] G3: UI/integration verification for the changed surface passes.
  CHECK: npm run test:ui
  EXPECT: 0 fail

- [ ] G4: static/build verification passes after implementation.
  CHECK: npm run check:ipc; npm run check:napi; npm run check:esm; npm run build
  EXPECT: exit 0

- [ ] G5: live REAL-1 validation is either independently proven with fresh runtime evidence or explicitly handed off with the exact external blocker; no stub result may be represented as real-browser evidence.
  EVIDENCE: pending
