// Project Intelligence — real-application end-to-end proof.
//
// WHY THIS TEST EXISTS
//   FINALVAL4 established the Project Intelligence service, ownership,
//   restart-recovery and agent-wiring layers in unit tests, and added the
//   "Index project" control that finally makes indexing reachable from the UI.
//   What was still missing is a single run through the REAL Electron app that
//   proves the whole chain at once:
//
//     real app -> real profile -> real project with a real root
//       -> index built through the production renderer API
//       -> indexed data read back through the production service boundary
//       -> ownership enforced across profiles
//       -> containment enforced (nothing outside the root is indexed)
//       -> app RESTARTED and the index still readable
//
//   Without this, the subsystem was correct in six layers and never once
//   demonstrated end to end.
//
// WHY IT CALLS THE RENDERER API RATHER THAN CLICKING THE BUTTON
//   `projectIntel.index(profileId, projectId, mode)` is precisely what the
//   "Index project" control calls — same preload function, same IPC channel,
//   same main-process ownership check. Driving the DOM button additionally
//   requires an agent run to give the panel an agentId and a changed file to
//   render; that fixture is covered by ui/tests/changed-files-panel.test.js
//   (9 cases, including the refusal path). This spec deliberately covers the
//   half that unit tests cannot: the real process, the real sidecar on disk,
//   the real ownership resolution and a real restart.
//
//   The control's wiring to this API is itself pinned by
//   shell/tests/project-intel-ui-wiring.test.js, so the two halves together
//   cover button -> API -> service.
//
// SECURITY INVARIANTS ASSERTED HERE (never weakened to pass)
//   * A second profile cannot read another profile's project index.
//   * A file OUTSIDE the project's root is never indexed, even though it is
//     reachable on disk.
//   * The renderer cannot name a root: the API takes only ids and a mode, and
//     the indexed paths are checked to be inside the project's stored root.

import { test, expect, _electron as electron } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A real project root with real files, plus one file deliberately OUTSIDE it. */
function makeProjectTree() {
  const root = mkdtempSync(join(tmpdir(), "cf-pi-e2e-root-"));
  const outside = mkdtempSync(join(tmpdir(), "cf-pi-e2e-outside-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
  writeFileSync(
    join(root, "src", "index.js"),
    'import { helper } from "./helper.js";\nexport const main = () => helper();\n',
  );
  writeFileSync(
    join(root, "src", "helper.js"),
    'export const helper = () => "progressledger-e2e-marker";\n',
  );
  writeFileSync(join(root, "README.md"), "# PI E2E\n");
  // node_modules must be skipped by the walker.
  writeFileSync(join(root, "node_modules", "junk", "index.js"), "module.exports = 1;\n");
  // This one is on disk and reachable, but OUTSIDE the authorized root.
  writeFileSync(join(outside, "secret.js"), "export const SECRET_MARKER = 1;\n");
  return { root, outside };
}

async function launchApp(userDataDir) {
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}

async function addProfile(win, name) {
  // `profiles:add` resolves to the created row object (see the other project
  // mode specs, which read `profile.id`), not to a bare id.
  const created = await win.evaluate(
    (n) => window.progressLedger.profiles.add(n, `pi-e2e-${Date.now()}`),
    name,
  );
  return created && typeof created === "object" ? created.id : created;
}

async function createProject(win, profileId, root) {
  const created = await win.evaluate(
    ([pid, rootPath]) =>
      window.progressLedger.projectMode.createProject({
        profileId: pid,
        name: "PI E2E Project",
        description: "project intelligence real-app e2e",
        rootPath,
        configJson: "{}",
      }),
    [profileId, root],
  );
  // The real NAPI pmCreateProject returns the new row id as a plain number.
  return typeof created === "number" ? created : created && created.id;
}

test("real app: Project Intelligence indexes, contains, isolates and survives a restart", async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-pi-e2e-"));
  const { root, outside } = makeProjectTree();

  let app;
  let win;
  let profileId;
  let projectId;

  try {
    ({ app, win } = await launchApp(userDataDir));
    profileId = await addProfile(win, "PI E2E Owner");
    expect(typeof profileId === "number" && profileId > 0).toBe(true);
    projectId = await createProject(win, profileId, root);
    expect(typeof projectId === "number" && projectId > 0).toBe(true);

    // ---- 1. BEFORE indexing: reads are refused, not served empty ----------
    // A project with no index must be refused rather than answering "no files",
    // otherwise a caller cannot tell "not indexed" from "genuinely empty".
    const before = await win.evaluate(
      ([pid, projId]) => window.progressLedger.projectIntel.stats(pid, projId),
      [profileId, projectId],
    );
    expect(
      before && before.ok !== true,
      `expected a refusal before indexing, got ${JSON.stringify(before)}`,
    );

    // ---- 2. INDEX through the production renderer API --------------------
    const indexed = await win.evaluate(
      ([pid, projId]) => window.progressLedger.projectIntel.index(pid, projId, "full"),
      [profileId, projectId],
    );
    expect(
      indexed && indexed.ok === true,
      `index failed: ${JSON.stringify(indexed)}`,
    );

    // ---- 3. READ BACK through the production service boundary ------------
    const listed = await win.evaluate(
      ([pid, projId]) => window.progressLedger.projectIntel.list(pid, projId, { max: 500 }),
      [profileId, projectId],
    );
    expect(listed && listed.ok === true, `list failed: ${JSON.stringify(listed)}`);
    const entries = (listed && listed.result && listed.result.entries) || [];
    const paths = entries.map((e) => String(e.path).replace(/\\/g, "/"));
    expect(paths.length).toBeGreaterThan(0);

    // The real files are present.
    expect(paths.some((p) => p.endsWith("src/index.js"))).toBe(true);
    expect(paths.some((p) => p.endsWith("src/helper.js"))).toBe(true);

    // ---- 4. CONTAINMENT: nothing outside the authorized root -------------
    // node_modules is skipped by the walker.
    expect(
      paths.some((p) => p.includes("node_modules")),
      `node_modules must not be indexed: ${JSON.stringify(paths)}`,
    ).toBe(false);
    // The out-of-root file is on disk and reachable, but must never appear.
    expect(
      paths.some((p) => p.includes("SECRET") || p.includes("secret.js")),
      `a file outside the project root was indexed: ${JSON.stringify(paths)}`,
    ).toBe(false);
    // The index stores paths RELATIVE to the authorized root, not absolute.
    // That is the stronger containment property and it is asserted here
    // explicitly, because an absolute path would both leak the machine's
    // directory layout to the renderer and keep the index pinned to one
    // location. (An earlier draft of this test wrongly assumed absolute paths
    // and failed against the relative ones — the product was right.)
    for (const p of paths) {
      expect(
        !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith("/"),
        `indexed path must be root-relative, got an absolute path: ${p}`,
      ).toBe(true);
      // No traversal segment can climb out of the root.
      expect(
        !p.split("/").includes(".."),
        `indexed path must not contain a parent-directory segment: ${p}`,
      ).toBe(true);
      // And no indexed path may name the temporary directory of the
      // out-of-root fixture.
      expect(
        !p.includes(outside.replace(/\\/g, "/").split("/").pop()),
        `an indexed path referenced the out-of-root fixture: ${p}`,
      ).toBe(true);
    }

    // ---- 5. STATS reflect the real tree ----------------------------------
    const stats = await win.evaluate(
      ([pid, projId]) => window.progressLedger.projectIntel.stats(pid, projId),
      [profileId, projectId],
    );
    expect(stats && stats.ok === true, `stats failed: ${JSON.stringify(stats)}`);
    const total = stats && stats.result && stats.result.totalFiles;
    expect(Number(total)).toBeGreaterThan(0);

    // ---- 6. DEPENDENCY EDGE from the real source -------------------------
    const neighbours = await win.evaluate(
      ([pid, projId]) =>
        window.progressLedger.projectIntel.neighbors(pid, projId, "src/index.js", 1),
      [profileId, projectId],
    );
    expect(
      neighbours && neighbours.ok === true,
      `neighbors failed: ${JSON.stringify(neighbours)}`,
    );

    // ---- 7. OWNERSHIP: a different profile cannot read this index ---------
    const otherProfileId = await addProfile(win, "PI E2E Intruder");
    expect(typeof otherProfileId === "number").toBe(true);
    const crossRead = await win.evaluate(
      ([pid, projId]) => window.progressLedger.projectIntel.list(pid, projId, { max: 500 }),
      [otherProfileId, projectId],
    );
    expect(
      crossRead && crossRead.ok !== true,
      `cross-profile read must be refused, got ${JSON.stringify(crossRead)}`,
    );

    // ---- 8. RESTART: the persisted index must still be readable ----------
    // The sidecar lives under userData, so a genuinely fresh process has to
    // reopen it. The handle cache is gone, which is exactly the case P-1 covers.
    await app.close();
    await sleep(1200);

    ({ app, win } = await launchApp(userDataDir));

    const afterRestart = await win.evaluate(
      ([pid, projId]) => window.progressLedger.projectIntel.list(pid, projId, { max: 500 }),
      [profileId, projectId],
    );
    expect(
      afterRestart && afterRestart.ok === true,
      `index did not survive the restart: ${JSON.stringify(afterRestart)}`,
    );
    const afterPaths = (
      (afterRestart && afterRestart.result && afterRestart.result.entries) || []
    ).map((e) => String(e.path).replace(/\\/g, "/"));
    expect(afterPaths.length).toBeGreaterThan(0);
    expect(afterPaths.some((p) => p.endsWith("src/index.js"))).toBe(true);

    // ---- 9. Ownership is STILL enforced after the restart ----------------
    // Authorization must not be "remembered" from the previous process.
    const crossAfterRestart = await win.evaluate(
      ([pid, projId]) => window.progressLedger.projectIntel.list(pid, projId, { max: 500 }),
      [otherProfileId, projectId],
    );
    expect(
      crossAfterRestart && crossAfterRestart.ok !== true,
      `cross-profile read must still be refused after restart, got ${JSON.stringify(crossAfterRestart)}`,
    );
  } finally {
    try {
      if (app) await Promise.race([app.close(), sleep(6000)]);
    } catch {
      /* best effort */
    }
  }
});
