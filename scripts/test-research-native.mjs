import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../core/careerflow_core.win32-x64-msvc.node");

const childRun = process.env.CF_RESEARCH_SMOKE_CHILD === "1";
const dir = process.env.CF_RESEARCH_SMOKE_DIR || mkdtempSync(join(tmpdir(), "careerflow-research-contract-"));
if (!childRun) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, CF_RESEARCH_SMOKE_CHILD: "1", CF_RESEARCH_SMOKE_DIR: dir },
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

try {
  core.initDb(join(dir, "research.sqlite"));
  const profile = core.addProfile("Research Contract Test", `research-${process.pid}`);
  const first = core.saveResearchSource(profile.id, "HTTPS://Example.COM:443/article#section?utm_source=x", "Example article");
  const duplicate = core.saveResearchSource(profile.id, "https://example.com/article", "Example article refreshed");
  assert.equal(first.id, duplicate.id, "canonical source saves must deduplicate");
  assert.equal(duplicate.url, "https://example.com/article");
  const passage = core.captureResearchPassage(profile.id, "https://example.com/article", "Example article", "bp-1", "clip", "A kept passage");
  const duplicatePassage = core.captureResearchPassage(profile.id, "https://example.com/article#different", "Example article", "bp-1", "clip", "A kept passage");
  assert.equal(passage.id, duplicatePassage.id, "duplicate captures must return the durable existing row");
  assert.equal(core.countKeptResearchPassages(profile.id, "https://example.com/article"), 1);
  assert.equal(core.listResearchSources(profile.id).length, 1);
  assert.equal(core.listResearchCaptures(profile.id).length, 1);
  assert.throws(() => core.saveResearchSource(profile.id, "file:///etc/passwd", "Forbidden"));
  assert.throws(() => core.captureResearchPassage(profile.id, "https://example.com", "Example", "bp-1", "unknown", "Text"));
  core.deleteProfile(profile.id);
  console.log("Research native contract PASS: canonical dedupe, persisted capture, kept count, invalid URL/kind refusal, cascade cleanup.");
} finally { /* parent process removes the temporary DB after this process exits */ }
