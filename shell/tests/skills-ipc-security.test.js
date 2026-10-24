import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

import { Skills } from "../src/services/skills/index.js";
import { validateSkillEnableScope } from "../src/security/skills-auth.js";

test.beforeEach(() => Skills._resetForTests());

const core = (profiles, projects = {}) => ({
  getProfiles: async () => profiles,
  pmGetProject: async (_profileId, projectId) => projects[projectId] || null,
});

test("skills IPC scope rejects a nonexistent profile before state mutation", async () => {
  Skills.register({ id: "global", name: "Global", scope: "global" });
  const r = await validateSkillEnableScope({ core: core([{ id: 2 }]) }, 1, null, "global");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "profile-not-found");
});

test("skills IPC scope rejects a project owned by another profile", async () => {
  Skills.register({ id: "global", name: "Global", scope: "global" });
  const r = await validateSkillEnableScope(
    { core: core([{ id: 1 }, { id: 2 }], { 9: { id: 9, profile_id: 2 } }) },
    1,
    9,
    "global",
  );
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "project-not-owned");
});

test("skills IPC scope rejects unknown skills instead of creating arbitrary state", async () => {
  const r = await validateSkillEnableScope({ core: core([{ id: 1 }]) }, 1, null, "missing");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "unknown-skill");
});

test("skills IPC scope accepts an owned profile and project", async () => {
  Skills.register({ id: "project", name: "Project", scope: "project", project_id: 9 });
  const r = await validateSkillEnableScope(
    { core: core([{ id: 1 }], { 9: { id: 9, profile_id: 1 } }) },
    1,
    9,
    "project",
  );
  assert.deepEqual(r, { ok: true });
});


test("skills loader rejects a directory junction escaping userData", async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-skills-root-"));
  const outside = mkdtempSync(join(tmpdir(), "cf-skills-out-"));
  try {
    mkdirSync(join(outside, "evil"), { recursive: true });
    writeFileSync(join(outside, "evil", "SKILL.md"), "---id: evil---\nsecret", "utf8");
    mkdirSync(join(root, "skills"), { recursive: true });
    symlinkSync(join(outside, "evil"), join(root, "skills", "evil"), "junction");
    const { Skills } = await import("../src/services/skills/index.js");
    Skills.configureSkills({ rootDir: root });
    const result = Skills.loadFromDisk();
    assert.equal(result.count, 0);
    assert.ok(result.errors.some((e) => e.reason === "path-escape"));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
