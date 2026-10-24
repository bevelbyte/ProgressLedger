/**
 * Task 8 — Comprehensive UI/UX Audit with seeded data.
 * 
 * Follows the cf-w1-shots.mjs pattern:
 *   1. Launch real Electron app
 *   2. Seed a profile + subjects + deadlines so views have content
 *   3. Navigate every rail destination and capture Playwright screenshots
 *   4. Test resize at multiple widths
 *   5. Test pane splits, arrangements, immerse mode
 *   6. Audit DOM for dark mode issues, unlabeled controls, empty states
 *   7. Test keyboard shortcuts
 */
import { _electron as electron } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = "shots/task8-full";
mkdirSync(OUT, { recursive: true });

const app = await electron.launch({
  args: [process.cwd(), `--user-data-dir=${mkdtempSync(join(tmpdir(), "cf-t8-"))}`],
  env: { ...process.env, CAREERFLOW_E2E: "1" },
});
const win = await app.firstWindow();
await win.waitForLoadState("domcontentloaded");
await win.setViewportSize({ width: 1600, height: 1000 });
await win.waitForTimeout(3500);

const shot = async (name) => {
  await win.waitForTimeout(650);
  await win.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("shot:", name);
};

// ══════════════════════════════════════════════════════════════════════════════
// A. INITIAL LANDING — before any profile
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== A. Initial Landing ===");
await shot("00-initial-landing");

// Check DOM state
const initialState = await win.evaluate(() => {
  const html = document.documentElement;
  return {
    colorScheme: getComputedStyle(html).colorScheme,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    density: html.getAttribute("data-density") || "default",
    title: document.title,
    buttons: document.querySelectorAll("button").length,
    inputs: document.querySelectorAll("input, textarea, select").length,
  };
});
console.log("Initial state:", JSON.stringify(initialState));

// ══════════════════════════════════════════════════════════════════════════════
// B. SEED PROFILE + DATA
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== B. Seed Data ===");
const seeded = await win.evaluate(async () => {
  const cf = window.careerflow;
  const created = await cf.profiles.add("UI Audit Student", "ui-audit");
  const p = created?.profile || created;
  const pid = p?.id ?? p?.profileId;
  if (!pid) return { ok: false, why: "no-profile" };
  try {
    await cf.academic.addTrack(pid, "BSc Computer Science");
    let tree = await cf.academic.tree(pid);
    const track = tree?.[0];
    if (!track) return { ok: false, why: "no-track" };

    await cf.academic.addSemester(pid, track.id, "Semester 5");
    tree = await cf.academic.tree(pid);
    const sem = tree?.[0]?.semesters?.[0];
    if (!sem) return { ok: false, why: "no-semester" };

    await cf.academic.addMilestone(pid, sem.id, "Core");
    tree = await cf.academic.tree(pid);
    const ms = tree?.[0]?.semesters?.[0]?.milestones?.[0];
    if (!ms) return { ok: false, why: "no-milestone" };

    const subjectPairs = [
      ["Design & Analysis of Algorithms", "CS301"],
      ["Operating Systems", "CS305"],
      ["Machine Learning", "CS410"],
      ["Discrete Mathematics", "CS201"],
    ];
    for (const [name, code] of subjectPairs) {
      await cf.academic.addSubject(pid, ms.id, name, code);
    }
    tree = await cf.academic.tree(pid);
    const subs = tree?.[0]?.semesters?.[0]?.milestones?.[0]?.subjects || [];
    const subIds = subs.map((s) => s.id);

    const day = (offset) => {
      const d = new Date();
      const local = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
      return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
    };
    
    if (subIds[0]) {
      await cf.deadlines.add(pid, subIds[0], day(0), "assignment", "DP problem set 4", "90 min");
      await cf.deadlines.add(pid, subIds[0], day(6), "exam", "Midterm — graph algorithms", "");
      await cf.deadlines.add(pid, subIds[1], day(-2), "gate", "Re-derive the master theorem", "");
      await cf.deadlines.add(pid, subIds[2], day(3), "assignment", "Neural network lab report", "2 hrs");
      await cf.deadlines.add(pid, subIds[3], day(1), "exam", "Quiz on combinatorics", "45 min");
    }

    // Add study sessions
    if (subIds[0]) {
      await cf.sessions.add(pid, subIds[0], 45, day(-1), "Reviewed greedy algorithms");
      await cf.sessions.add(pid, subIds[1], 60, day(0), "Practiced page replacement");
    }

    // Add a project
    try {
      await cf.projects.add(pid, "CareerFlow UI Audit", "mini", "In progress audit of all UI surfaces");
    } catch {}

    return { ok: true, pid, subjects: subIds.length };
  } catch (e) {
    return { ok: false, why: String(e && e.message) };
  }
});
console.log("Seed result:", JSON.stringify(seeded));

// Reload to pick up seeded profile
await win.reload();
await win.waitForLoadState("domcontentloaded");
await win.waitForTimeout(2500);

// Select the seeded profile
await win.locator('button.nav-item:has-text("Profiles")').first().click();
await win.waitForTimeout(1200);
const card = win.locator("button.profile-main").first();
if (await card.count()) {
  await card.click();
  await win.waitForTimeout(3000);
  console.log("Profile selected.");
} else {
  console.log("WARN: no profile card rendered");
}
await shot("01-profile-selected");

// ══════════════════════════════════════════════════════════════════════════════
// C. NAVIGATE ALL VIEWS — capture every rail destination
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== C. View-by-View Navigation ===");

const views = [
  ["Home", "02-desk"],
  ["Subjects", "03-subjects"],
  ["Projects", "04-projects"],
  ["Degree", "05-degree"],
  ["Labs", "06-labs"],
  ["Deadlines", "07-deadlines"],
  ["Study Sessions", "08-sessions"],
  ["Goals", "09-goals"],
  ["Career", "10-career"],
  ["Flashcards", "11-flashcards"],
  ["Mistakes", "12-mistakes"],
  ["Formulas", "13-formulas"],
  ["Project", "14-runs"],
  ["Browser", "15-browser"],
  ["Research ledger", "16-research-ledger"],
  ["Profiles", "17-profiles"],
  ["Settings", "18-settings"],
];

const viewAudits = {};
for (const [label, shotName] of views) {
  try {
    await win.locator(`button.nav-item:has-text("${label}")`).first().click({ timeout: 3000 });
    await win.waitForTimeout(1400);
    await shot(shotName);

    // DOM quality audit per view
    const audit = await win.evaluate(() => {
      let lightBg = 0, emptyEls = 0, errors = 0, unlabeledBtn = 0;
      const empties = document.querySelectorAll(".cf-empty, [class*='empty-state']");
      emptyEls = empties.length;
      const errEls = document.querySelectorAll(".error, .cf-error, [data-error]");
      errors = errEls.length;
      
      const btns = document.querySelectorAll("button");
      for (const b of btns) {
        if (b.offsetHeight === 0) continue;
        if (!b.textContent?.trim() && !b.getAttribute("aria-label") && !b.getAttribute("title")) unlabeledBtn++;
      }
      
      const all = document.querySelectorAll("*");
      for (const el of all) {
        if (el.offsetHeight === 0) continue;
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)") {
          const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (m && +m[1] > 220 && +m[2] > 220 && +m[3] > 220) lightBg++;
        }
      }
      
      return { emptyEls, errors, lightBg, unlabeledBtn };
    });
    viewAudits[label] = audit;
    if (audit.errors > 0 || audit.lightBg > 0 || audit.unlabeledBtn > 0) {
      console.log(`  ⚠ ${label}: errors=${audit.errors} lightBg=${audit.lightBg} unlabeledBtn=${audit.unlabeledBtn}`);
    } else {
      console.log(`  ✓ ${label}: clean (empties=${audit.emptyEls})`);
    }
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message?.slice(0, 80)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// D. PANE SPLITS & ARRANGEMENTS
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== D. Pane Splits & Arrangements ===");
await win.locator('button.nav-item:has-text("Home")').first().click();
await win.waitForTimeout(1400);

// Split
await win.keyboard.press("Control+\\");
await win.waitForTimeout(1000);
await shot("20-split-h");

// Vertical split
await win.keyboard.press("Control+Alt+\\");
await win.waitForTimeout(1000);
await shot("21-split-nested");

// Pane modes
try {
  await win.locator('select[aria-label="Pane mode"]').first().selectOption("ledge");
  await win.waitForTimeout(900);
  await shot("22-ledge-mode");
  await win.locator('select[aria-label="Pane mode"]').first().selectOption("margin");
  await win.waitForTimeout(900);
  await shot("23-margin-mode");
  await win.locator('select[aria-label="Pane mode"]').first().selectOption("content");
  await win.waitForTimeout(700);
} catch (e) {
  console.log("  Pane mode error:", e.message?.slice(0, 60));
}

// Trio arrangement
try {
  await win.locator('button:has-text("Arrange")').first().click();
  await win.waitForTimeout(400);
  await shot("24-arrange-menu");
  await win.locator('button[role="menuitem"]:has-text("Trio")').first().click();
  await win.waitForTimeout(1300);
  await shot("25-trio-arrangement");
} catch (e) {
  console.log("  Arrange error:", e.message?.slice(0, 60));
}

// ══════════════════════════════════════════════════════════════════════════════
// E. RESIZE TESTS — four sizes, check for overflow
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== E. Resize Tests ===");
// Reset to single pane
await win.keyboard.press("Escape");
await win.waitForTimeout(300);
await win.locator('button.nav-item:has-text("Home")').first().click();
await win.waitForTimeout(1000);

const sizes = [
  [1600, 1000, "30-wide"],
  [1200, 800, "31-medium"],
  [900, 700, "32-narrow"],
  [750, 600, "33-compact"],
];
for (const [w, h, name] of sizes) {
  await win.setViewportSize({ width: w, height: h });
  await win.waitForTimeout(600);
  await shot(name);
  
  const overflow = await win.evaluate(() => {
    const body = document.body;
    return {
      scrollW: body.scrollWidth,
      clientW: body.clientWidth,
      hasHScroll: body.scrollWidth > body.clientWidth + 5,
    };
  });
  if (overflow.hasHScroll) {
    console.log(`  ⚠ OVERFLOW at ${w}x${h}: sw=${overflow.scrollW} cw=${overflow.clientW}`);
  } else {
    console.log(`  ✓ ${w}x${h}: no overflow`);
  }
}
await win.setViewportSize({ width: 1600, height: 1000 });
await win.waitForTimeout(400);

// ══════════════════════════════════════════════════════════════════════════════
// F. KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== F. Keyboard Shortcuts ===");

// Ctrl+B — toggle slim rail
await win.keyboard.press("Control+b");
await win.waitForTimeout(800);
await shot("40-slim-rail");
await win.keyboard.press("Control+b");
await win.waitForTimeout(400);

// Immerse mode
await win.keyboard.press("Control+Shift+e");
await win.waitForTimeout(800);
await shot("41-immerse");
await win.keyboard.press("Escape");
await win.waitForTimeout(400);

// Keyboard help
await win.keyboard.press("?");
await win.waitForTimeout(800);
await shot("42-keyboard-help");
await win.keyboard.press("Escape");
await win.waitForTimeout(400);

// Command palette (Ctrl+K)
try {
  await win.keyboard.press("Control+k");
  await win.waitForTimeout(800);
  await shot("43-command-palette");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(400);
} catch (e) {
  console.log("  Command palette error:", e.message?.slice(0, 60));
}

// ══════════════════════════════════════════════════════════════════════════════
// G. DARK MODE COMPREHENSIVE AUDIT
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== G. Dark Mode Comprehensive Audit ===");
await win.locator('button.nav-item:has-text("Home")').first().click();
await win.waitForTimeout(1000);

const darkAudit = await win.evaluate(() => {
  const html = document.documentElement;
  const cs = getComputedStyle(html);
  const surfaces = [];
  const contrastIssues = [];
  const allEls = document.querySelectorAll("*");
  let checked = 0;

  for (const el of allEls) {
    if (el.offsetHeight === 0 || el.offsetWidth === 0) continue;
    checked++;
    const ecs = getComputedStyle(el);
    const bg = ecs.backgroundColor;
    const color = ecs.color;
    
    // Light background check
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m && +m[1] > 200 && +m[2] > 200 && +m[3] > 200) {
        if (surfaces.length < 15) {
          surfaces.push({
            tag: el.tagName,
            cls: (el.className?.toString() || "").slice(0, 50),
            bg,
            text: el.textContent?.trim().slice(0, 30),
          });
        }
      }
    }
    
    // Very dark text on dark background
    if (el.textContent?.trim()) {
      const cm = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (cm) {
        const lum = 0.299 * +cm[1] + 0.587 * +cm[2] + 0.114 * +cm[3];
        if (lum < 30 && el.offsetHeight > 5) {
          if (contrastIssues.length < 10) {
            contrastIssues.push({
              tag: el.tagName,
              cls: (el.className?.toString() || "").slice(0, 40),
              color,
              text: el.textContent?.trim().slice(0, 30),
            });
          }
        }
      }
    }
  }

  return {
    colorScheme: cs.colorScheme,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    checked,
    lightSurfaces: surfaces,
    contrastIssues,
  };
});

console.log(`  Color scheme: ${darkAudit.colorScheme}`);
console.log(`  Body BG: ${darkAudit.bodyBg}`);
console.log(`  Elements checked: ${darkAudit.checked}`);
console.log(`  Light surfaces: ${darkAudit.lightSurfaces.length}`);
for (const s of darkAudit.lightSurfaces) {
  console.log(`    <${s.tag}> .${s.cls} bg=${s.bg} "${s.text}"`);
}
console.log(`  Contrast issues: ${darkAudit.contrastIssues.length}`);
for (const c of darkAudit.contrastIssues) {
  console.log(`    <${c.tag}> .${c.cls} color=${c.color} "${c.text}"`);
}

// ══════════════════════════════════════════════════════════════════════════════
// H. SETTINGS VIEW DETAIL
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== H. Settings Detail ===");
await win.locator('button.nav-item:has-text("Settings")').first().click();
await win.waitForTimeout(1400);
await shot("50-settings");

// Check for settings sections
const settingsInfo = await win.evaluate(() => {
  const sections = document.querySelectorAll("h2, .atl-section-name, .settings-section");
  const sectionTexts = Array.from(sections).filter(s => s.offsetHeight > 0).map(s => s.textContent?.trim());
  const toggles = document.querySelectorAll('input[type="checkbox"], [role="switch"]');
  const selects = document.querySelectorAll("select");
  return {
    sectionTexts,
    toggleCount: toggles.length,
    selectCount: selects.length,
  };
});
console.log("  Sections:", settingsInfo.sectionTexts.join(", "));
console.log(`  Toggles: ${settingsInfo.toggleCount}, Selects: ${settingsInfo.selectCount}`);

// ══════════════════════════════════════════════════════════════════════════════
// I. SPINE / OBLIGATION RAIL DETAIL
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== I. Spine / Obligation Rail ===");
await win.locator('button.nav-item:has-text("Home")').first().click();
await win.waitForTimeout(1400);

const spineInfo = await win.evaluate(() => {
  const spine = document.querySelector(".spine");
  if (!spine) return { found: false };
  const metrics = spine.querySelectorAll(".atl-metric, .spine-metric");
  const items = Array.from(metrics).map(m => ({
    label: m.querySelector(".atl-metric-label, .spine-label")?.textContent?.trim(),
    value: m.querySelector(".atl-metric-value, .spine-value")?.textContent?.trim(),
  }));
  return {
    found: true,
    width: spine.offsetWidth,
    height: spine.offsetHeight,
    items,
  };
});
console.log(`  Spine found: ${spineInfo.found}`);
if (spineInfo.found) {
  console.log(`  Size: ${spineInfo.width}x${spineInfo.height}`);
  for (const item of (spineInfo.items || [])) {
    console.log(`    ${item.label}: ${item.value}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// J. BROWSER SURFACE
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n=== J. Browser Surface ===");
try {
  await win.locator('button.nav-item:has-text("Browser")').first().click({ timeout: 3000 });
  await win.waitForTimeout(1400);
  await shot("60-browser-surface");
  
  // Check browser controls
  const browserInfo = await win.evaluate(() => {
    const surface = document.querySelector('[data-testid="browser-surface"], .browser-surface');
    const addressBar = document.querySelector('input[type="url"], input[data-testid="browser-url"], .browser-address input');
    const backBtn = document.querySelector('[data-testid="browser-back"], button[aria-label="Back"]');
    const fwdBtn = document.querySelector('[data-testid="browser-forward"], button[aria-label="Forward"]');
    const refreshBtn = document.querySelector('[data-testid="browser-refresh"], button[aria-label="Refresh"]');
    return {
      hasSurface: !!surface,
      surfaceH: surface?.offsetHeight || 0,
      hasAddressBar: !!addressBar,
      hasBack: !!backBtn,
      hasForward: !!fwdBtn,
      hasRefresh: !!refreshBtn,
    };
  });
  console.log(`  Surface: ${browserInfo.hasSurface} (h=${browserInfo.surfaceH})`);
  console.log(`  Address bar: ${browserInfo.hasAddressBar}`);
  console.log(`  Nav buttons: back=${browserInfo.hasBack} fwd=${browserInfo.hasForward} refresh=${browserInfo.hasRefresh}`);
} catch (e) {
  console.log(`  Error: ${e.message?.slice(0, 80)}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// K. SUMMARY
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n╔════════════════════════════════════════════════════════╗");
console.log("║        Task 8 Comprehensive UI Audit Summary         ║");
console.log("╚════════════════════════════════════════════════════════╝");
console.log(`  Dark mode:          ${darkAudit.colorScheme}`);
console.log(`  Body BG:            ${darkAudit.bodyBg}`);
console.log(`  Light surfaces:     ${darkAudit.lightSurfaces.length}`);
console.log(`  Contrast issues:    ${darkAudit.contrastIssues.length}`);
console.log(`  Spine found:        ${spineInfo.found}`);
console.log(`  Views audited:      ${Object.keys(viewAudits).length}`);

let totalErrors = 0, totalLightBg = 0, totalUnlabeled = 0;
for (const [view, data] of Object.entries(viewAudits)) {
  totalErrors += data.errors;
  totalLightBg += data.lightBg;
  totalUnlabeled += data.unlabeledBtn;
}
console.log(`  Total view errors:  ${totalErrors}`);
console.log(`  Total light BGs:    ${totalLightBg}`);
console.log(`  Total unlabeled:    ${totalUnlabeled}`);
console.log("");

await app.close();
console.log("DONE →", OUT);
