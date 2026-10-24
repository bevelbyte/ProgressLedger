import { _electron as electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const app = await electron.launch({ args: [process.cwd(), `--user-data-dir=${mkdtempSync(join(tmpdir(),"cf-dense-"))}`], env: { ...process.env, PROGRESSLEDGER_V2_E2E: "1" } });
const win = await app.firstWindow();
await win.waitForLoadState("domcontentloaded");
await win.setViewportSize({ width: 1600, height: 1000 });
await win.waitForTimeout(3500);

const shot = async (n) => { await win.waitForTimeout(900); await win.screenshot({ path: `logs/_dense-${n}.png` }); console.log("shot", n); };

const seed = await win.evaluate(async () => {
  const cf = window.progressLedger;
  await cf.profiles.add("Ada Lovelace", "ada-lovelace");
  const l = await cf.profiles.list();
  const pid = (l.profiles || l)[0].id;
  await cf.academic.addTrack(pid, "BSc Computer Science");
  let t = await cf.academic.tree(pid); const tr = t[0];
  await cf.academic.addSemester(pid, tr.id, "Semester 5");
  t = await cf.academic.tree(pid); const se = t[0].semesters[0];
  await cf.academic.addMilestone(pid, se.id, "Core");
  t = await cf.academic.tree(pid); const ms = t[0].semesters[0].milestones[0];
  for (const [n, c] of [["Design & Analysis of Algorithms","CS301"],["Operating Systems","CS305"],["Machine Learning","CS410"]]) await cf.academic.addSubject(pid, ms.id, n, c);
  t = await cf.academic.tree(pid);
  const subs = t[0].semesters[0].milestones[0].subjects;
  const d = (x) => new Date(Date.now() + x*864e5).toISOString().slice(0,10);
  await cf.deadlines.add(pid, subs[0].id, d(1), "assignment", "DP problem set 4 - questions 3, 5, 8", "90 min");
  await cf.deadlines.add(pid, subs[0].id, d(6), "exam", "Midterm - graph algorithms", "");
  await cf.deadlines.add(pid, subs[1].id, d(-2), "gate", "Re-derive the master theorem cases from notes", "");
  return { pid, subs: subs.map(s => s.id) };
});
console.log("seed", JSON.stringify(seed));

await win.reload();
await win.waitForLoadState("domcontentloaded");
await win.waitForTimeout(3500);

// Select the profile through the title-bar switcher.
const sw = win.locator('header.titlebar button:has-text("No profile"), header.titlebar .tb-profile').first();
if (await sw.count()) { await sw.click(); await win.waitForTimeout(1000); }
const opt = win.locator('button:has-text("Ada Lovelace")').first();
if (await opt.count()) { await opt.click(); await win.waitForTimeout(3000); }
console.log("selected:", await win.evaluate(() => document.querySelector("header.titlebar")?.innerText?.slice(0,120)));

await win.locator('button.nav-item:has-text("Home")').first().click(); await shot("desk");
await win.locator('button.nav-item:has-text("Subjects")').first().click(); await shot("subjects");
await win.locator('button.nav-item:has-text("Deadlines")').first().click(); await shot("deadlines");
await win.setViewportSize({ width: 900, height: 720 });
await win.locator('button.nav-item:has-text("Home")').first().click(); await shot("narrow-desk");
await app.close();
