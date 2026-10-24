// ===========================================================================
// Space obligation-strip capture, with POPULATED data.
//
// WHY THIS EXISTS. The default capture harness runs against whatever profile
// happens to be selected, which on a clean machine is nothing: every obligation
// figure reads 0. A strip of zeros proves only that zeros render -- it cannot
// distinguish a working strip from a broken one, and it cannot show the one
// thing worth reviewing, which is whether a LATE subject is actually
// distinguishable from a clear one.
//
// So this seeds a disposable profile through the app's OWN IPC surface, then
// captures. Every row is real, persisted by the real native core, and removed
// again in the same run. No mocked IPC, no fake renderer state.
//
// Method names and arities are taken from shell/src/preload.cjs, not guessed.
//   academic.addTrack(profileId, name)
//   academic.addSemester(profileId, trackId, name)
//   academic.addMilestone(profileId, semesterId, title)
//   academic.addSubject(profileId, milestoneId, name, code)
//   deadlines.add(profileId, subjectId, date, category, title, notes)
//   deadlines.setCompletion(profileId, id, completed)
//
//   node scripts/capture-space-obligations.mjs [label]
// ===========================================================================

import { _electron as electron } from "playwright-core";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const label = process.argv[2] ?? "space-obl";
const outDir = join(projectRoot, "shots", "redesign", label);
mkdirSync(outDir, { recursive: true });

const PROFILE = `cf-obl-${Date.now()}`;
const localDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

console.log("building ui/dist...");
const build = spawnSync("npx", ["vite", "build"], {
  cwd: join(projectRoot, "ui"), shell: true, encoding: "utf8",
});
if (build.status !== 0) {
  console.error("BUILD FAILED\n" + (build.stdout ?? "") + (build.stderr ?? ""));
  process.exit(1);
}
const app = await electron.launch({
  args: [projectRoot, "--careerflow-e2e"],
  env: { ...process.env, CAREERFLOW_E2E: "1" },
});
const win = await app.firstWindow();
await win.waitForLoadState("domcontentloaded");
await win.getByText(/CareerFlow core online/i).waitFor({ timeout: 20000 });
console.log("core online");
await win.setViewportSize({ width: 1600, height: 950 });

// Playwright's evaluate() takes exactly ONE argument, and that argument must be
// SERIALIZABLE -- a function cannot cross the boundary. So the day strings are
// precomputed here in Node and passed as plain strings; the in-page code only
// ever reads them.
const DAYS = {
  minus6: localDay(-6),
  minus3: localDay(-3),
  minus1: localDay(-1),
  today: localDay(0),
};

const seed = await win.evaluate(async ({ profileName, D }) => {
  const cf = window.careerflow;
  const out = { steps: [] };
  try {
    // `profiles.add` returns the CREATED PROFILE OBJECT, not a bare id. Passing
    // that object straight into `addTrack` reached the Rust side as an Object
    // and failed to convert to i64 -- so unwrap it rather than guessing.
    const created = await cf.profiles.add(profileName, profileName.toLowerCase());
    const pid = typeof created === "object" && created !== null ? created.id : created;
    if (typeof pid !== "number") throw new Error("profile id unresolved: " + JSON.stringify(created));
    out.pid = pid;
    out.steps.push("profile " + pid);

    // The academic create calls do NOT all return a bare id. addTrack and
    // addSemester return the created row OBJECT while addMilestone/addSubject
    // return a bare integer. Reading `.id` off a bare number yields undefined,
    // which silently produced a milestone parented to nothing -- so normalise
    // every return through one helper instead of assuming a shape.
    const idOf = (r) => (typeof r === "object" && r !== null ? (r.id ?? r.trackId ?? r.semesterId ?? r.milestoneId) : r);
    const need = (r, what) => {
      const v = idOf(r);
      if (typeof v !== "number") throw new Error(what + " id unresolved: " + JSON.stringify(r));
      return v;
    };

    const trackId = need(await cf.academic.addTrack(pid, "Computer Science BSc"), "track");
    const semId = need(await cf.academic.addSemester(pid, trackId, "Semester 1"), "semester");
    const msId = need(await cf.academic.addMilestone(pid, semId, "Core"), "milestone");
    out.steps.push(`track=${trackId} sem=${semId} ms=${msId}`);

    const late = need(await cf.academic.addSubject(pid, msId, "Operating Systems", "CS301"), "subject");
    const today = need(await cf.academic.addSubject(pid, msId, "Discrete Mathematics", "CS205"), "subject");
    const clear = need(await cf.academic.addSubject(pid, msId, "Computer Networks", "CS210"), "subject");
    out.subjects = { late, today, clear };

    // Two late items on one subject, one due today on another, none on the third.
    await cf.deadlines.add(pid, late, D.minus3, "assignment", "Lab report", "");
    await cf.deadlines.add(pid, late, D.minus1, "project", "Kernel writeup", "");
    await cf.deadlines.add(pid, today, D.today, "exam", "Midterm", "");

    // A COMPLETED deadline on the late subject. The strip must not count it:
    // finished work is not owed. This is the honesty case worth proving.
    const done = await cf.deadlines.add(pid, late, D.minus6, "assignment", "Already handed in", "");
    await cf.deadlines.setCompletion(pid, done, true);
    out.doneId = done;

    await cf.cards.create(pid, clear, "Front", "Back");
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}, { profileName: PROFILE, D: DAYS });
if (seed.ok) {
  // Switching profiles from the chip was unreliable here: the Desk's chip row is
  // inside the Home view, so a click can land before the strip has re-rendered
  // and silently hit the PREVIOUS profile. Instead select through the Profiles
  // view (where a row per profile is guaranteed) and then verify by reading the
  // active profile id back, so a silent no-op cannot pass unnoticed.
  await win.locator("button.nav-item", { hasText: "Profiles" }).first().click({ timeout: 8000 });
  await win.waitForTimeout(1000);

  // Switching profiles through the UI proved brittle: the Profiles view renders
  // from profileStore, which is populated on mount, and a profile created by
  // raw IPC mid-session is not in that list until the store is told to reload --
  // so the card never appears and the click silently no-ops.
  //
  // The reliable path is the same store action the card dispatches, exposed on
  // window so the probe can invoke it. This is still the REAL application
  // switching a REAL profile; it just skips the fragile DOM lookup.
  const switched = await win.evaluate(async (pid) => {
    if (typeof window.__cfSelectProfile === "function") {
      await window.__cfSelectProfile(pid);
      return true;
    }
    return false;
  }, seed.pid);
  if (!switched) {
    console.log("WARNING: no profile-select hook available; capture will show the previous profile");
  }
  await win.waitForTimeout(1600);

  // Read the SEEDED SUBJECTS back rather than trusting the click: if the profile
  // did not actually switch, the capture below would show a different profile's
  // data and quietly "prove" nothing about the obligation strip.
  const seen = await win.evaluate(async (pid) => {
    const tree = await window.careerflow.academic.tree(pid).catch(() => null);
    const tracks = tree?.tracks ?? (Array.isArray(tree) ? tree : []);
    const names = [];
    for (const t of tracks) {
      for (const s of t.semesters ?? []) {
        for (const m of s.milestones ?? []) {
          for (const sub of m.subjects ?? []) names.push(sub.name);
        }
      }
    }
    const all = await window.careerflow.profiles.list().catch(() => null);
    return {
      names,
      profiles: (Array.isArray(all) ? all : (all?.profiles ?? [])).map((p) => p.id + ":" + p.name),
    };
  }, seed.pid);
  console.log("seeded subjects: " + JSON.stringify(seen.names));
  console.log("profiles now: " + JSON.stringify(seen.profiles));
  if (!seen.names.includes("Operating Systems")) {
    console.log("WARNING: seeded subjects not visible -- the capture would NOT be evidence.");
  }

  await win.locator("button.nav-item", { hasText: "Subjects" }).first().click({ timeout: 8000 });
  await win.waitForTimeout(2000);

  await win.screenshot({ path: join(outDir, "01-space-owed-populated.png") });

  // Read the DOM back so the capture is EVIDENCE, not a picture that may be
  // showing zeros for entirely the wrong reason.
  const readout = await win.evaluate(() => ({
    why: document.querySelector(".owed .atl-section-why")?.textContent?.trim() ?? null,
    metrics: [...document.querySelectorAll(".owed .atl-metric")].map((m) => ({
      label: m.querySelector(".atl-metric-label")?.textContent?.trim(),
      value: m.querySelector(".atl-metric-value")?.textContent?.trim(),
    })),
    rows: [...document.querySelectorAll(".subject-row")].map((r) => ({
      name: r.querySelector(".s-name")?.textContent?.trim(),
      owed: r.querySelector(".s-owed")?.textContent?.trim() || null,
      tone: r.querySelector(".s-owed")?.dataset.tone ?? null,
    })),
  }));
  console.log("READBACK " + JSON.stringify(readout, null, 2));

  await win.setViewportSize({ width: 900, height: 700 });
  await win.waitForTimeout(1000);
  await win.screenshot({ path: join(outDir, "02-space-owed-narrow.png") });

  try {
    await win.evaluate(async (pid) => { await window.careerflow.profiles.remove(pid); }, seed.pid);
    console.log("cleanup: profile removed");
  } catch (e) {
    console.log("cleanup FAILED -- profile " + PROFILE + " may remain: " + e.message);
  }

  // Sweep up probe profiles left behind by EARLIER FAILED runs of this same
  // script. A seeding probe that only cleans up on the happy path quietly fills
  // the user's real profile list with junk across attempts, so each run removes
  // any cf-obl- leftovers it can still see. Only the probe's own prefix is
  // touched -- no real profile is ever a candidate.
  const swept = await win.evaluate(async () => {
    const cf = window.careerflow;
    const all = await cf.profiles.list().catch(() => null);
    const list = Array.isArray(all) ? all : (all?.profiles ?? []);
    const stale = list.filter((p) => typeof p.name === "string" && p.name.startsWith("cf-obl-"));
    for (const p of stale) {
      try { await cf.profiles.remove(p.id); } catch (_e) { /* leave it if it cannot be removed */ }
    }
    return stale.map((p) => `${p.id}:${p.name}`);
  });
  if (swept.length) console.log("swept stale probe profiles: " + JSON.stringify(swept));
} else {
  console.log("seed failed; capturing the honest empty state anyway");
  await win.screenshot({ path: join(outDir, "00-seed-failed.png") });
}

await app.close();
console.log("done -> shots/redesign/" + label + "/");

console.log("seed: " + JSON.stringify(seed).slice(0, 500));