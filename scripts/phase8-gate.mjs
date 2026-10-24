#!/usr/bin/env node
/** Phase 8 gate verifier: read-only validation of preceding Playwright evidence. */
import { readFileSync, existsSync } from "node:fs";
// Playwright owns its output directory and may remove it when the worker exits.
// Keep the acceptance evidence beside the repository-level gate instead of
// inside test-results so the subsequent read-only gate can consume it.
const EVIDENCE = "phase8-evidence.json";
function fail(msg, detail="") { console.error("PHASE8_GATE_FAIL:", msg); if(detail) console.error("---evidence---\n"+detail); process.exit(1); }
async function main() {
  if (!existsSync(EVIDENCE)) fail("no evidence file produced by the preceding Phase 8 Playwright run");
  let ev; try { ev=JSON.parse(readFileSync(EVIDENCE,"utf8")); } catch(e) { fail("evidence JSON is unreadable",String(e)); }
  if (typeof ev.generatedAt !== "string" || !Number.isFinite(Date.parse(ev.generatedAt))) fail("evidence missing generatedAt timestamp");
  const age=Date.now()-Date.parse(ev.generatedAt); if(age < -60000 || age > 15*60*1000) fail("evidence is stale or timestamped in the future; rerun the required Phase 8 Playwright command");
  if(!ev.a || !ev.b) fail("evidence missing a/b",JSON.stringify(ev,null,2));
  if(!ev.a.cfId || !ev.b.cfId) fail("missing cfIds",JSON.stringify(ev,null,2));
  if(ev.a.cfId===ev.b.cfId) fail("CF ids are equal",JSON.stringify(ev));
  if(ev.a.bpLocalId===ev.b.bpLocalId) fail("browser localIds are equal",JSON.stringify(ev));
  if(!ev.a.donutId || !ev.b.donutId) fail("missing Donut ids",JSON.stringify(ev));
  if(ev.a.donutId===ev.b.donutId) fail("Donut UUIDs are equal",JSON.stringify(ev));
  if(!Array.isArray(ev.donutProfiles) || ev.donutProfiles.length!==ev.preTotal+2) fail("expected baseline + 2 Donut profiles, got "+(ev.donutProfiles?.length)+" (baseline "+ev.preTotal+")",JSON.stringify(ev));
  if(ev.afterRepeatTotal!==ev.preTotal+2) fail("repeated open created a duplicate: afterRepeatTotal="+ev.afterRepeatTotal+" baseline="+ev.preTotal,JSON.stringify(ev));
  if(ev.uuidsDiffer!==true) fail("uuidsDiffer flag false",JSON.stringify(ev));
  console.log(JSON.stringify(ev,null,2)); console.log("PHASE8_GATE_PASS");
}
main().catch(e=>fail("verifier crashed",String(e)));
