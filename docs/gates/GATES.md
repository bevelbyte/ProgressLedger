# Gates: PHASE 7→11 CareerFlow real-Donut verification chain

OWNS: e2e/phase*-*.spec.js, e2e/GATES-*.md (no production code; production changes
appear in PHASE 11 as findings only and are not owned by this leaf unless
explicitly approved).

Scope: Complete the real Electron + real Donut backend verification chain for
the Browser Manager / Quick Actions feature, classify the QuickActionsPanel
refresh behaviour, prove cross-profile isolation, prove restart persistence,
and produce a forensic final report.

<!--
NOTE: CHECK lines below use a custom verifier that prints a single success-only
token on pass. The expected token is unique per gate so a mismatch is detectable.
For real Playwright specs, CHECK is the existing npx command; EXPECT matches the
last line of stdout that the spec prints on success.
-->

- [ ] G1: PHASE 7 — real shortcuts added (FB + IG), pinned, Quick Actions shows them, real Donut profile created and reused for both clicks, captured Donut UUID A.
  CHECK: cd "D:/10_Dev_Workspace/Projects/laboratory/CareerFlow" && node scripts/phase7-gate.mjs
  EXPECT: PHASE7_GATE_PASS
  EVIDENCE: pending

- [ ] G2: PHASE 7 — root-cause classification of QuickActionsPanel refresh behaviour (test sequencing vs UI defect) with concrete code citation.
  CHECK: cd "D:/10_Dev_Workspace/Projects/laboratory/CareerFlow" && node scripts/phase7-classify.mjs
  EXPECT: PHASE7_CLASSIFY_PASS
  EVIDENCE: pending

- [ ] G3: PHASE 8 — second profile isolation: Test Profile 02 → distinct Donut UUID B (B != A), shortcuts remain profile-scoped, no cross-route, no token leak, no foreign Donut profile touched, no duplicate remote profile.
  CHECK: cd "D:/10_Dev_Workspace/Projects/laboratory/CareerFlow" && node scripts/phase8-gate.mjs
  EXPECT: PHASE8_GATE_PASS
  EVIDENCE: pending

- [ ] G4: PHASE 9 — real restart persistence: both CF browser profiles, all shortcuts, all pins, all local bindings, and all Donut mappings survive; opening existing shortcuts after restart still targets the same Donut profile; no unnecessary new Donut profile is created.
  CHECK: cd "D:/10_Dev_Workspace/Projects/laboratory/CareerFlow" && node scripts/phase9-gate.mjs
  EXPECT: PHASE9_GATE_PASS
  EVIDENCE: pending
  ABANDON: G4 DBI Wayfern fingerprint generation reports "Too many profiles are being created. Fingerprint generation is temporarily unavailable for this browser." on the first profile create in a clean DBI session. The CareerFlow persistence mechanism is architecturally proven (SQLite binding store + localId-stable mapping + DBI 'bfc-<localId>' naming) but the end-to-end real-Donut run cannot complete in this environment. Full handoff in test-results/phase9-abandon.json. To re-run: close other Chromium-based browsers (Chrome, Edge with DevTools) and re-invoke the gate.

- [ ] G5: PHASE 10 — Quick Actions profile-scope: A→A's pins only, B→B's pins only, empty state honest, clicking each shortcut opens expected URL through its mapped Donut profile.
  CHECK: cd "D:/10_Dev_Workspace/Projects/laboratory/CareerFlow" && node scripts/phase10-gate.mjs
  EXPECT: PHASE10_GATE_PASS
  EVIDENCE: pending

- [ ] G6: PHASE 11 — final forensic review covering all 12 sub-checks in the resume directive (git status, diff, log, changed/untracked files, Agent-2 cleanliness, no token/PID leak, no hardcoded dev paths, no process-kill behaviour, all E2E assertions reviewed for false positives, real vs stub evidence clearly distinguished).
  CHECK: cd "D:/10_Dev_Workspace/Projects/laboratory/CareerFlow" && node scripts/phase11-gate.mjs
  EXPECT: PHASE11_GATE_PASS
  EVIDENCE: pending
