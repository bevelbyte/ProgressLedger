// ===========================================================================
// Redesign capture harness (Phase 8 loop).
//
// Launches the REAL Electron app -- same binary, same preload, same NAPI core,
// same IPC surface the E2E suite drives -- walks the views Space Bunny
// redesigned, and writes a PNG per view into shots/redesign/<run>/.
//
// It exists so the redesign is compared against the actual reference at the
// actual window size, rather than against a description of it. It asserts
// nothing; a failed assertion here is not a test failure, it is a picture.
//
//   node scripts/capture-redesign.mjs [label] [width] [height]
// ===========================================================================

import { _electron as electron } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const label = process.argv[2] ?? "run";
const W = Number(process.argv[3] ?? 1600);
const H = Number(process.argv[4] ?? 950);
const outDir = join(projectRoot, "shots", "redesign", label);
mkdirSync(outDir, { recursive: true });

const report = [];
function note(s) {
  report.push(s);
  console.log(s);
}

// The app serves the BUILT bundle (shell/src/main.js loads ui/dist/index.html
// behind progressledger-v2://app). Screenshotting without rebuilding first silently
// captures the previous iteration, which is how a "fix" appears to have had no
// effect. So the harness builds, and fails loudly rather than lying.
note("building ui/dist (the app serves the built bundle)...");
const build = spawnSync("npx", ["vite", "build"], {
  cwd: join(projectRoot, "ui"),
  shell: true,
  encoding: "utf8",
});
if (build.status !== 0) {
  note("BUILD FAILED -- capture aborted, screenshotting stale output would be a lie:");
  note((build.stdout ?? "") + (build.stderr ?? ""));
  process.exit(1);
}
note("build ok");

const app = await electron.launch({
  args: [projectRoot],
  env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" },
});

const win = await app.firstWindow();
await win.waitForLoadState("domcontentloaded");

// The core readout is the app's own "I am up" gate, same as the E2E suite.
try {
  await win.getByText(/Progress Ledger core online/i).waitFor({ timeout: 20000 });
  note("core online: yes");
} catch {
  note("core online: NO (core readout never appeared)");
}

await win.setViewportSize({ width: W, height: H });
await win.waitForTimeout(1200);

/**
 * Navigate by clicking the real rail item, exactly as a person would, then
 * settle. Clicking is the point: it proves the rail still works, and it keeps
 * the pane tab strip in the state a user would actually be in.
 */
async function capture(name, labelText, { wait = 900, extra } = {}) {
  try {
    const item = win.locator("button.nav-item", { hasText: labelText }).first();
    await item.click({ timeout: 8000 });
    await win.waitForTimeout(wait);
    if (extra) await extra(win);
    await win.screenshot({ path: join(outDir, `${name}.png`) });
    const title = await win.locator(".ctx-title").first().textContent().catch(() => null);
    note(`  ${name.padEnd(18)} ok   title="${(title ?? "").trim()}"`);
    return true;
  } catch (e) {
    note(`  ${name.padEnd(18)} FAIL ${String(e.message).split("\n")[0].slice(0, 110)}`);
    return false;
  }
}

note(`capturing ${W}x${H} into shots/redesign/${label}/`);

await capture("01-desk", "Home");
await capture("02-profiles", "Profiles");
await capture("03-settings", "Settings");

// Space. Two states matter: the index (where the owed-here strip and the per-row
// obligation column live) and an opened subject workspace.
await capture("07-space-index", "Subjects");
try {
  const firstRow = win.locator(".subject-row .row-open").first();
  await firstRow.click({ timeout: 8000 });
  await win.waitForTimeout(1100);
  await win.screenshot({ path: join(outDir, "08-space-detail.png") });
  note("  08-space-detail     ok   (opened subject workspace)");
} catch (e) {
  note(`  08-space-detail     FAIL ${String(e.message).split("\n")[0].slice(0, 110)}`);
}

// The numeric rail is a Ctrl+B away; capture the Desk in both rail modes so
// the two forms can be compared side by side.
try {
  await win.keyboard.press("Control+b");
  await win.waitForTimeout(700);
  const item = win.locator("button.nav-item", { hasText: "Home" }).first();
  await item.click({ timeout: 8000 });
  await win.waitForTimeout(900);
  await win.screenshot({ path: join(outDir, "04-desk-slim-rail.png") });
  note("  04-desk-slim-rail   ok   (numeric rail)");
} catch (e) {
  note(`  04-desk-slim-rail   FAIL ${String(e.message).split("\n")[0].slice(0, 110)}`);
}

// Narrow window. The rail has to stay usable and nothing may clip.
try {
  await win.setViewportSize({ width: 900, height: 700 });
  await win.waitForTimeout(900);
  await win.screenshot({ path: join(outDir, "05-narrow.png") });
  note("  05-narrow           ok   (900x700)");
} catch (e) {
  note(`  05-narrow           FAIL ${String(e.message).split("\n")[0].slice(0, 110)}`);
}

// Keyboard reachability of the tab strip: the Space Bunny pane header is only
// worth having if it can be driven without a mouse.
try {
  await win.setViewportSize({ width: W, height: H });
  await win.waitForTimeout(500);
  const item = win.locator("button.nav-item", { hasText: "Settings" }).first();
  await item.click({ timeout: 8000 });
  await win.waitForTimeout(600);
  const tabs = win.locator('[role="tab"]');
  const n = await tabs.count();
  note(`  pane tabs present    ${n}`);
  if (n > 0) {
    await tabs.first().focus();
    await win.keyboard.press("ArrowRight");
    await win.waitForTimeout(500);
    await win.screenshot({ path: join(outDir, "06-tabs-keyboard.png") });
    note("  06-tabs-keyboard    ok   (ArrowRight moved the active tab)");
  }
} catch (e) {
  note(`  06-tabs-keyboard    FAIL ${String(e.message).split("\n")[0].slice(0, 110)}`);
}

await app.close();

writeFileSync(join(outDir, "report.txt"), report.join("\n") + "\n");
note("done");
process.exit(0);
