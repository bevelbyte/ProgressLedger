# CareerFlow production-readiness root gates

- [ ] G1 Repository architecture and feature inventory is complete and reconciled with the current codebase.
  CHECK: node -e "const fs=require('fs'); for(const p of ['core/src','shell/src','ui/src','e2e','scripts','docs']) if(!fs.existsSync(p)) process.exit(1); console.log('ARCH_PATHS_PRESENT')"
  EXPECT: PASSARCH_PATHS_PRESENT

- [ ] G2 Independent security, core, agent, UI, and browser investigations have current evidence and every finding has a disposition.
  CHECK: node -e "const fs=require('fs'); const p='.unlazy/production/audit-summary.md'; if(!fs.existsSync(p)) process.exit(1); const s=fs.readFileSync(p,'utf8'); for(const x of ['Security','Rust/SQLite/NAPI','Agent/Goal/Project','UI/UX','Browser','Disposition']) if(!s.includes(x)) process.exit(1); console.log('AUDIT_SUMMARY_PRESENT')"
  EXPECT: PASSAUDIT_SUMMARY_PRESENT

- [ ] G3 Production implementation work is completed only from the prioritized roadmap, with regression coverage for genuine defects.
  CHECK: node -e "const fs=require('fs'); const p='.unlazy/production/PLAN.md'; const s=fs.readFileSync(p,'utf8'); if(!s.includes('execution')) process.exit(1); console.log('ROADMAP_EXECUTION_TRACKED')"
  EXPECT: PASSROADMAP_EXECUTION_TRACKED

- [ ] G4 Full automated verification passes after final implementation: IPC, NAPI, ESM, shell, UI, Rust/core, production build, and Electron E2E.
  CHECK: npm test
  EXPECT: PASS

- [ ] G5 Final security/reliability review finds no known critical/high defect and all required regressions are green.
  CHECK: node -e "const fs=require('fs'); const p='.unlazy/production/final-review.md'; if(!fs.existsSync(p)) process.exit(1); const s=fs.readFileSync(p,'utf8'); if(!s.includes('NO_KNOWN_CRITICAL_HIGH')) process.exit(1); console.log('FINAL_REVIEW_ACCEPTED')"
  EXPECT: PASSFINAL_REVIEW_ACCEPTED

- [ ] G6 Final repository state is clean and release evidence is recorded.
  CHECK: node -e "const cp=require('child_process'); const s=cp.execFileSync('git',['status','--short'],{encoding:'utf8'}); if(s.trim()) process.exit(1); console.log('GIT_CLEAN')"
  EXPECT: PASSGIT_CLEAN

