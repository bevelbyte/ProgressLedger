// Skills — typed bundles of system-prompt fragments + tools.
//
// Covers:
//   - register / enable / disable / forContext filtering
//   - buildSystemPrompt concatenation order
//   - parseSkillFrontmatter happy path + edge cases
//   - loadFromDisk skips malformed SKILL.md without crashing
//   - per-project scope isolation
//
// All disk activity is hermetic via a per-test tmp dir. No Electron.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  Skills,
  parseSkillFrontmatter,
  configureSkills,
} from "../src/services/skills/index.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "cf-skills-"));
  return root;
}

function writeSkill(root, id, fm, body = "You are helpful.") {
  const dir = join(root, "skills", id);
  mkdirSync(dir, { recursive: true });
  const head = Object.entries(fm)
    .map(([k, v]) => `---${k}: ${v}---`)
    .join("\n");
  writeFileSync(join(dir, "SKILL.md"), `${head}\n${body}\n`, "utf8");
}

test.beforeEach(() => {
  Skills._resetForTests();
});

// ---------------------------------------------------------------------------
// parseSkillFrontmatter
// ---------------------------------------------------------------------------

test("parseSkillFrontmatter: parses basic key/value lines", () => {
  const text = "---id: foo---\n---name: Foo---\n---tools: a, b---\nBody here.";
  const { frontmatter, body } = parseSkillFrontmatter(text);
  assert.equal(frontmatter.id, "foo");
  assert.equal(frontmatter.name, "Foo");
  assert.equal(frontmatter.tools, "a, b");
  assert.equal(body, "Body here.");
});

test("parseSkillFrontmatter: empty body", () => {
  const { frontmatter, body } = parseSkillFrontmatter("---id: foo---\n");
  assert.equal(frontmatter.id, "foo");
  assert.equal(body, "");
});

test("parseSkillFrontmatter: garbage input is tolerated", () => {
  const { frontmatter, body } = parseSkillFrontmatter(null);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, "");
});

// ---------------------------------------------------------------------------
// register + forContext + buildSystemPrompt
// ---------------------------------------------------------------------------

test("register + forContext returns enabled global skills", () => {
  Skills.register({ id: "a", name: "A", systemPrompt: "PROMPT A", tools: ["x"], scope: "global" });
  Skills.register({ id: "b", name: "B", systemPrompt: "PROMPT B", tools: ["y"], scope: "global" });
  Skills.enable(1, "*", "a");
  const ctx = Skills.forContext(1, 42);
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].id, "a");
  assert.equal(ctx[0].enabled, true);
});

test("buildSystemPrompt concatenates in registry order", () => {
  Skills.register({ id: "a", name: "A", systemPrompt: "alpha", scope: "global" });
  Skills.register({ id: "b", name: "B", systemPrompt: "beta", scope: "global" });
  Skills.enable(1, "*", "a");
  Skills.enable(1, "*", "b");
  const prompt = Skills.buildSystemPrompt(1, 42);
  assert.equal(prompt, "alpha\n\n---\n\nbeta");
});

test("buildSystemPrompt is empty when nothing enabled", () => {
  Skills.register({ id: "a", name: "A", systemPrompt: "alpha", scope: "global" });
  assert.equal(Skills.buildSystemPrompt(1, 42), "");
});

test("disable removes a skill from forContext", () => {
  Skills.register({ id: "a", name: "A", systemPrompt: "alpha", scope: "global" });
  Skills.enable(1, "*", "a");
  Skills.disable(1, "*", "a");
  assert.equal(Skills.forContext(1, 42).length, 0);
});

test("forContext separates skills across profiles", () => {
  Skills.register({ id: "a", name: "A", systemPrompt: "alpha", scope: "global" });
  Skills.enable(1, "*", "a");
  Skills.enable(2, "*", "a");
  assert.equal(Skills.forContext(1, 99).length, 1);
  assert.equal(Skills.forContext(3, 99).length, 0);
});

test("project-scoped skills only match their project_id", () => {
  Skills.register({ id: "p", name: "P", systemPrompt: "P", scope: "project", project_id: 7 });
  Skills.enable(1, 7, "p");
  Skills.enable(1, 8, "p"); // wrong project
  assert.equal(Skills.forContext(1, 7).length, 1);
  assert.equal(Skills.forContext(1, 8).length, 0);
});

test("enable returns scope-mismatch for wrong project on project-scoped skill", () => {
  Skills.register({ id: "p", name: "P", systemPrompt: "P", scope: "project", project_id: 7 });
  const r = Skills.enable(1, 99, "p");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "scope-mismatch");
});

test("enable returns unknown-skill for missing id", () => {
  const r = Skills.enable(1, "*", "nope");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "unknown-skill");
});

// ---------------------------------------------------------------------------
// loadFromDisk
// ---------------------------------------------------------------------------

test("loadFromDisk reads valid skills", () => {
  const root = freshRoot();
  writeSkill(root, "alpha", { id: "alpha", name: "Alpha", tools: "x", scope: "global" }, "first");
  writeSkill(root, "beta", { id: "beta", name: "Beta", tools: "y,z", scope: "global" }, "second");
  configureSkills({ rootDir: root });
  const r = Skills.loadFromDisk();
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.deepEqual(r.errors, []);
  const list = Skills.list();
  const ids = list.map((s) => s.id).sort();
  assert.deepEqual(ids, ["alpha", "beta"]);
  rmSync(root, { recursive: true, force: true });
});

test("loadFromDisk skips malformed SKILL.md without crashing", () => {
  const root = freshRoot();
  // Good skill
  writeSkill(root, "good", { id: "good", name: "Good", scope: "global" }, "ok");
  // Skill folder with no SKILL.md
  mkdirSync(join(root, "skills", "noskill"), { recursive: true });
  // Skill folder with a SKILL.md but missing id frontmatter
  mkdirSync(join(root, "skills", "no-id"), { recursive: true });
  writeFileSync(join(root, "skills", "no-id", "SKILL.md"), "no frontmatter here\n");
  // Project-scoped skill without project_id
  writeSkill(root, "bad-proj", { id: "bad-proj", name: "Bad", scope: "project" }, "no pid");
  configureSkills({ rootDir: root });
  const r = Skills.loadFromDisk();
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  // We expect errors for noskill (missing-SKILL.md), no-id (missing-id),
  // and bad-proj (project-scope-without-project_id).
  const reasons = r.errors.map((e) => e.reason).sort();
  assert.ok(reasons.includes("missing-SKILL.md"));
  assert.ok(reasons.includes("missing-id"));
  assert.ok(reasons.includes("project-scope-without-project_id"));
  rmSync(root, { recursive: true, force: true });
});

test("loadFromDisk returns empty result when skills dir missing", () => {
  const root = freshRoot();
  configureSkills({ rootDir: root });
  const r = Skills.loadFromDisk();
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.errors, []);
  rmSync(root, { recursive: true, force: true });
});

test("enable persists across reload via state file", () => {
  const root = freshRoot();
  writeSkill(root, "x", { id: "x", name: "X", scope: "global" }, "x");
  configureSkills({ rootDir: root });
  Skills.loadFromDisk();
  Skills.enable(1, "*", "x");
  // Re-configure (new instance) and reload — state file should restore.
  configureSkills({ rootDir: root });
  Skills.loadFromDisk();
  const ctx = Skills.forContext(1, 42);
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].id, "x");
  rmSync(root, { recursive: true, force: true });
});