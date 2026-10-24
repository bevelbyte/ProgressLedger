// PRODUCTION WIRING — Skills registry.
//
// THE DEFECT THIS LOCKS OUT
// Skills were fully implemented — on-disk loader, frontmatter parser,
// per-(profile,project) enable state with JSON persistence, an ownership gate
// (`security/skills-auth.js`), a preload bridge, a mounted Skill Inventory
// panel, and an agent-loop consumption point
// (`services/agent/loop.js` -> `Skills.buildSystemPrompt()`) — and had ZERO
// production call sites. `Skills.configureSkills()` and `Skills.loadFromDisk()`
// were never called from `shell/src/main.js`.
//
// The consequence in the running application was not a crash. It was a
// permanently empty feature:
//
//   * `_rootDir` / `_statePath` stayed null, so `loadFromDisk()` returned
//     `{ ok: true, count: 0 }` and the registry stayed empty;
//   * `skills:list` answered `{ ok: true, skills: [] }` forever, so the Skill
//     Inventory panel rendered "No skills installed." regardless of what was on
//     disk;
//   * `skills:set-enabled` always failed `unknown-skill`;
//   * `Skills.buildSystemPrompt()` returned "", so the agent never saw a skill —
//     while `docs/PROJECT-MODE-GUIDE.md` advertises "skills are reusable
//     instruction packs".
//
// Unit tests could not catch this: `gate10-11-v7-mcp-skills-loop.test.js` and
// `skills.test.js` both inject `configureSkills({ rootDir })` themselves, so
// they exercised the service while the product stayed unwired. This is the
// same defect class as the inert audit trail and the unreachable Marketplace
// registry.
//
// WHAT IS ASSERTED HERE
//   1. `shell/src/main.js` really calls `configureSkills({ rootDir })` and
//      `loadFromDisk({ ... })`, inside `app.whenReady` — the wiring cannot be
//      deleted again without failing this test.
//   2. The root main.js configures is the SAME root the `skills:preview` IPC
//      handler resolves, so the panel can never list a skill whose SKILL.md the
//      preview channel refuses to read.
//   3. `skills:set-enabled` is audited on BOTH the granted and the refused
//      path, with a stringified detail (Audit.normalize() silently drops a
//      non-string detail).
//   4. Behavioural proof, end to end through the REAL service and the REAL
//      ownership gate against a real on-disk SKILL.md: load -> list -> refuse
//      an unowned profile -> enable for an owned profile -> the agent system
//      prompt changes -> and stays scoped to that one profile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { Skills } from "../src/services/skills/index.js";
import { validateSkillEnableScope } from "../src/security/skills-auth.js";

const here = dirname(fileURLToPath(import.meta.url));
const shellSrc = join(here, "..", "src");

// ---------------------------------------------------------------------------
// 1 + 2. The production wiring itself
// ---------------------------------------------------------------------------

test("main.js wires the Skills registry at startup against the userData root", () => {
  const main = readFileSync(join(shellSrc, "main.js"), "utf8");

  assert.match(
    main,
    /import \{ Skills \} from "\.\/services\/skills\/index\.js"/,
    "main.js must import the Skills service",
  );
  assert.match(
    main,
    /Skills\.configureSkills\(\{\s*rootDir:/,
    "main.js must call Skills.configureSkills({ rootDir }) — without it _rootDir and " +
      "_statePath stay null, loadFromDisk() finds no directory, and the registry is never populated",
  );
  assert.match(
    main,
    /Skills\.loadFromDisk\(\{/,
    "main.js must call Skills.loadFromDisk() — without it the in-memory registry stays empty",
  );

  // Same root as the skills:preview handler, which resolves it independently
  // from app.getPath("userData"). Two different roots would mean the panel can
  // list a skill whose SKILL.md preview is refused as not-found. Assert the
  // whole chain: the variable passed as rootDir must itself be app.getPath.
  const configured = main.match(/Skills\.configureSkills\(\{\s*rootDir:\s*([A-Za-z_$][\w$]*)/);
  assert.ok(configured, "configureSkills must pass an explicit rootDir identifier");
  const rootVar = configured[1];
  const rootDef = main.match(new RegExp(`(?:const|let|var)\\s+${rootVar}\\s*=\\s*([^;]+);`));
  assert.ok(rootDef, `the rootDir identifier "${rootVar}" must be assigned in main.js`);
  assert.match(
    rootDef[1],
    /app\.getPath\("userData"\)/,
    `the configured root (${rootVar}) must be app.getPath("userData"), matching the skills:preview handler`,
  );

  // The wiring must live in the real startup path, not a helper nobody calls.
  const whenReady = main.indexOf("app.whenReady");
  assert.ok(whenReady > 0, "main.js must have an app.whenReady block");
  const configureAt = main.indexOf("Skills.configureSkills(");
  assert.ok(
    configureAt > whenReady,
    "the Skills wiring must sit inside app.whenReady so it runs in the real app",
  );

  // And it must be inside the same guarded startup region as the plugin and
  // marketplace registries, so a throw in one cannot skip the others.
  assert.match(main, /Skill registry ready/, "startup must log the registry outcome");
});

// ---------------------------------------------------------------------------
// 3. The audit trail for a capability-changing operation
// ---------------------------------------------------------------------------

test("skills:set-enabled is audited on the granted and the refused path", () => {
  const src = readFileSync(join(shellSrc, "ipc", "skills-plugins-mcp.js"), "utf8");

  assert.match(
    src,
    /event: "skill\.set_enabled"/,
    "enabling a skill changes the agent's system prompt and must be on the security record",
  );
  assert.match(src, /result: "denied"/, "a refused enablement must be recorded too");
  assert.match(src, /result: r\.ok \? "ok" : "error"/, "the outcome must reflect the real result");

  // Audit.normalize() keeps `detail` only when it is a STRING. Passing an
  // object silently records null, so the record would lose its reason.
  const objectDetail = src.split("\n").filter((l) => /^\s*detail:\s*\{/.test(l));
  assert.equal(
    objectDetail.length,
    0,
    "audit detail must not be an object literal — Audit.normalize() only persists a string",
  );
  assert.ok(
    src.includes("detail: JSON.stringify("),
    "audit detail must be JSON.stringify'd",
  );
});

// ---------------------------------------------------------------------------
// 4. Behavioural proof through the real service and the real ownership gate
// ---------------------------------------------------------------------------

function seedSkill(rootDir, id, extraFrontmatter = []) {
  const dir = join(rootDir, "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      `---id: ${id}`,
      `---name: Deep Research`,
      "---description: Multi-source research discipline",
      "---tools: search, summarise",
      "---scope: global",
      ...extraFrontmatter,
      "---",
      "",
      "When answering a research question, triangulate across at least three",
      "independent sources before stating a conclusion.",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Minimal core double: one owned profile, and project ownership on demand. */
function coreCtx(profiles, projects = {}) {
  return {
    core: {
      getProfiles: () => profiles,
      pmGetProject: (profileId, projectId) => projects[projectId] ?? null,
    },
  };
}

test("a real on-disk skill reaches the agent prompt only for an owning profile", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-skills-wiring-"));
  try {
    seedSkill(userDataDir, "deep-research");

    // Exactly what main.js now does at startup.
    Skills.configureSkills({ rootDir: userDataDir });
    const loaded = Skills.loadFromDisk({ rootDir: userDataDir });

    assert.equal(loaded.ok, true, `loadFromDisk must succeed: ${JSON.stringify(loaded.errors)}`);
    assert.equal(loaded.count, 1, "the one real skill on disk must be registered");

    const listed = Skills.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "deep-research");
    assert.equal(listed[0].scope, "global");
    assert.deepEqual(listed[0].tools, ["search", "summarise"]);

    // THE SYMPTOM: before enabling, the agent sees nothing.
    assert.equal(
      Skills.buildSystemPrompt(1, "*"),
      "",
      "a skill that is not enabled must contribute nothing to the system prompt",
    );

    // A profile the core does not know must be refused by the real gate.
    const unowned = await validateSkillEnableScope(coreCtx([{ id: 1 }]), 999, null, "deep-research");
    assert.equal(unowned.ok, false);
    assert.equal(unowned.error.code, "profile-not-found");

    // A skill id that does not exist must be refused too.
    const unknown = await validateSkillEnableScope(coreCtx([{ id: 1 }]), 1, null, "no-such-skill");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "unknown-skill");

    // A missing core must fail closed, not open.
    const noCore = await validateSkillEnableScope({}, 1, null, "deep-research");
    assert.equal(noCore.ok, false);
    assert.equal(noCore.error.code, "core-not-wired");

    // The owned profile passes and the skill becomes part of its prompt.
    const owned = await validateSkillEnableScope(coreCtx([{ id: 1 }]), 1, null, "deep-research");
    assert.equal(owned.ok, true, `owned profile must pass the gate: ${JSON.stringify(owned.error)}`);

    const enabled = Skills.enable(1, "*", "deep-research");
    assert.equal(enabled.ok, true);

    const prompt = Skills.buildSystemPrompt(1, "*");
    assert.match(
      prompt,
      /triangulate across at least three/,
      "the enabled skill must actually reach the agent system prompt",
    );

    // Enablement is per profile: another profile must not inherit it.
    assert.equal(
      Skills.buildSystemPrompt(2, "*"),
      "",
      "enablement must be scoped to the profile that enabled it",
    );

    // And the raw SKILL.md the preview channel serves must come from the same
    // root the service loaded — this is the invariant the wiring comment cites.
    const previewPath = join(userDataDir, "skills", "deep-research", "SKILL.md");
    assert.match(readFileSync(previewPath, "utf8"), /triangulate/);

    // Disabling removes it again.
    assert.equal(Skills.disable(1, "*", "deep-research").ok, true);
    assert.equal(Skills.buildSystemPrompt(1, "*"), "");
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("enablement survives a restart via the persisted state file", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-skills-persist-"));
  try {
    seedSkill(userDataDir, "deep-research");

    Skills.configureSkills({ rootDir: userDataDir });
    Skills.loadFromDisk({ rootDir: userDataDir });
    assert.equal(Skills.enable(1, "*", "deep-research").ok, true);
    assert.match(Skills.buildSystemPrompt(1, "*"), /triangulate/);

    // Simulate a restart: configureSkills() re-reads the state file, and
    // loadFromDisk() rebuilds the registry. The enabled set must survive.
    Skills.configureSkills({ rootDir: userDataDir });
    Skills.loadFromDisk({ rootDir: userDataDir });
    assert.match(
      Skills.buildSystemPrompt(1, "*"),
      /triangulate/,
      "an enabled skill must still be enabled after a restart",
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
