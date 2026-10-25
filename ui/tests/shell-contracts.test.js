// Shell contract tests — the app shell's load-bearing behaviour.
//
// These lock the contracts that the E2E suite and the product depend on but
// that no component test covered, which is exactly how they were broken
// silently once already:
//
//   1. The status bar renders the native `ping()` response verbatim.
//      20 E2E specs gate on the text `Progress Ledger core online`. Paraphrasing it
//      to a friendlier word ("core ok") fails every one of them at the
//      readiness step, long before the test's actual subject is reached.
//   2. The nav rail exposes every route label verbatim, with `Project` matched
//      by an anchored regex — and counts must stay out of `textContent`.
//   3. The view registry and the shell's route allowlist are the same set, so
//      a destination can never be navigable-but-unroutable (or vice versa).
//   4. Settings opens on the vault, because the backup/restore E2E flow drives
//      "Backup Active Profile" immediately after navigating there.
//   5. `?` opens the keyboard reference and Escape closes it.
//   6. The whole shell composes: App mounts, the rail routes, and a real view
//      renders in the stage.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import App from "../src/App.svelte";
import StatusBar from "../src/shell/StatusBar.svelte";
import NavRail from "../src/shell/NavRail.svelte";
import SettingsHub from "../src/shell/SettingsHub.svelte";
import KeyboardHelp from "../src/shell/KeyboardHelp.svelte";
import { VIEWS, railGroups, orderedViews, captionFor, railViews } from "../src/shell/view-registry.js";

// The rail's vocabulary is the registry MINUS hidden surfaces (`page`, the
// embedded browser's page tab — see view-registry.js). Every assertion below
// that used to count VIEWS counts the rail's views, because that is what the
// rail has always meant: the destinations a user can navigate to.
import { __resetOperator, operator, applyOperatorEvent } from "../src/shell/operator.svelte.js";

// ---------------------------------------------------------------------------
// IPC surface
//
// Written out explicitly rather than through a permissive proxy: a proxy that
// answers every property with an async function silently satisfies code that
// should have failed, and would hide the very wiring bugs these tests exist to
// catch. `runtime.isE2E` in particular must stay a boolean.
// ---------------------------------------------------------------------------

const PING = "Progress Ledger core online";

function makeProgressLedger(overrides = {}) {
  const resolved = (value) => async () => value;
  const base = {
    ping: async () => PING,
    runtime: { isE2E: false },
    notes: { onQuickNoteShortcut: () => () => {} },
    profiles: {
      list: async () => [],
      add: resolved({ id: 1, name: "p", slug: "p" }),
      remove: resolved({ ok: true }),
      export: resolved({ ok: true }),
      import: resolved({ ok: true }),
    },
    academic: { tree: async () => [] },
    backups: {
      get: resolved({
        backupDir: "C:/vault",
        backups: [
          {
            path: "C:/vault/ada-20260920.cfprofile",
            name: "ada-20260920",
            modifiedAt: "2026-09-20T09:00:00.000Z",
            byteSize: 8192,
          },
        ],
        lastBackups: { "1": { at: "2026-09-20T09:00:00.000Z", path: "C:/vault/ada.cfprofile" } },
      }),
      chooseFolder: resolved({ selected: false }),
      clearFolder: resolved({ backupDir: null, backups: [], lastBackups: {} }),
      run: resolved({ ok: true }),
      openFolder: resolved({ ok: true }),
    },
    sync: {
      getAutomation: resolved({
        enabled: false,
        intervalMinutes: 60,
        target: "local",
        retentionKeep: 5,
      }),
      updateAutomation: resolved({ ok: true }),
      runNow: resolved({ ok: true }),
      onAutomationResult: () => () => {},
    },
    diagnostics: {
      getReport: resolved({
        status: "pass",
        generatedAt: "2026-09-20T10:00:00.000Z",
        checks: [],
        data: { profileCount: 1 },
        sync: {
          local: { configured: false, bundleCount: 0 },
          cloud: { configured: false, bundleCount: 0 },
          automation: { enabled: false },
        },
      }),
      readLog: resolved(""),
      openLogs: resolved({ ok: true }),
      exportReport: resolved({ exported: false }),
    },
    update: { check: resolved({ state: "idle" }), onStatus: () => () => {} },
    projectMode: { onEvent: () => () => {} },
  };
  window.progressLedger = { ...base, ...overrides };
  return window.progressLedger;
}

beforeEach(() => {
  __resetOperator();
  localStorage.setItem("progressledger_v2_onboarding_complete", "true");
  makeProgressLedger();
});

afterEach(() => {
  cleanup();
  delete window.progressLedger;
});

// ---------------------------------------------------------------------------

describe("status bar", () => {
  it("renders the native ping response verbatim — the E2E readiness gate", async () => {
    render(StatusBar, { props: { coreStatus: PING, online: true } });
    expect(await screen.findByText(PING)).toBeInTheDocument();
  });

  it("renders the failure message when the core is unreachable", async () => {
    const failure = "Rust core unreachable: binding missing";
    render(StatusBar, { props: { coreStatus: failure, online: false } });
    expect(await screen.findByText(failure)).toBeInTheDocument();
  });

  it("reports operator state and can open the console", async () => {
    applyOperatorEvent({ type: "agent.approval.required", agentId: 1, tool: "fs_write" });
    const onOpenConsole = vi.fn();
    render(StatusBar, { props: { coreStatus: PING, online: true, onOpenConsole } });

    expect(await screen.findByText("1 waiting for you")).toBeInTheDocument();
    await fireEvent.click(screen.getByTitle("Open the operator console"));
    expect(onOpenConsole).toHaveBeenCalled();
  });
});

describe("view registry", () => {
  // The shell's route allowlist (App.svelte ALLOWED_VIEWS). Duplicated here on
  // purpose: if a destination is added to one list and not the other, navigation
  // and rendering disagree and the app develops dead ends.
  const ALLOWED_VIEWS = new Set([
    "home", "cgpa", "tree", "labs", "projects", "flashcards", "mistakes",
    "formulas", "research-ledger", "browser-profiles", "deadlines", "sessions", "profiles", "project",
    "goals", "career", "settings",
  ]);

  it("declares exactly the routes the shell can render", () => {
    expect(new Set(railViews().map((v) => v.id))).toEqual(ALLOWED_VIEWS);
    expect(new Set(VIEWS.filter((v) => v.id !== "page").map((v) => v.id))).toEqual(new Set([...ALLOWED_VIEWS, "research-ledger"]));
  });

  it("keeps hidden surfaces out of the rail but still in the taxonomy", () => {
    // A web page is a surface, not a destination: `page` must exist as a view
    // (an opaque page id travels on a tab) but must never appear in the rail,
    // in the positional jumps, or in the shell's route allowlist.
    const page = VIEWS.find((v) => v.id === "page");
    expect(page, "the browser's page surface is registered").toBeTruthy();
    expect(page.hidden).toBe(true);
    expect(railViews().some((v) => v.id === "page")).toBe(false);
    expect(orderedViews().some((v) => v.id === "page")).toBe(false);
    expect(ALLOWED_VIEWS.has("page")).toBe(false);

    // Research ledger is a reachable destination but opts out of startup seeding.
    const ledger = VIEWS.find((v) => v.id === "research-ledger");
    expect(ledger.hidden).not.toBe(true);
    expect(ledger.seed).toBe(false);
    expect(railViews().some((v) => v.id === "research-ledger")).toBe(true);
  });

  it("gives every view a label, a plane, an icon and header copy", () => {
    for (const v of VIEWS) {
      expect(v.label, `${v.id} label`).toBeTruthy();
      expect(v.subtitle, `${v.id} subtitle`).toBeTruthy();
      expect(v.icon, `${v.id} icon`).toBeTruthy();
      expect(v.plane, `${v.id} plane`).toBeTruthy();
    }
  });

  it("reaches every view through the rail's positional order", () => {
    expect(orderedViews().length).toBe(railViews().length);
    expect(orderedViews().map((v) => v.id)).toEqual(railViews().map((v) => v.id));
  });

  it("pins exactly one plane to the rail footer", () => {
    const footers = railGroups().filter((g) => g.footer);
    expect(footers.map((g) => g.id)).toEqual(["system"]);
  });
});

describe("nav rail", () => {
  it("exposes every destination as a button.nav-item with its exact label", async () => {
    render(NavRail, { props: { currentView: "home", profileReady: true } });

    const items = document.querySelectorAll("button.nav-item");
    expect(items.length).toBe(railViews().length);

    for (const view of railViews()) {
      const match = [...items].find((b) => b.textContent.trim() === view.label);
      expect(match, `nav item "${view.label}"`).toBeTruthy();
    }
  });

  it("keeps the Runs console matchable by an anchored Project regex", async () => {
    // E2E: hasText: /^\s*Project\s*$/ — a badge must not leak into textContent,
    // or "Project 3" stops matching and every agent spec loses its entry point.
    render(NavRail, { props: { currentView: "project", profileReady: true, badges: { project: 3 } } });

    const project = [...document.querySelectorAll("button.nav-item")].filter((b) =>
      /^\s*Project\s*$/.test(b.textContent),
    );
    expect(project.length).toBe(1);
    expect(project[0].getAttribute("data-badge")).toBe("3");
  });

  it("marks the active destination with aria-current, not aria-selected", async () => {
    render(NavRail, { props: { currentView: "deadlines", profileReady: true } });
    const active = document.querySelector("button.nav-item.active");
    expect(active.textContent.trim()).toBe("Deadlines");
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(document.querySelectorAll("button.nav-item[aria-current='page']").length).toBe(1);
  });

  it("gates profile-scoped destinations until a profile exists", async () => {
    render(NavRail, { props: { currentView: "home", profileReady: false } });
    const item = (label) =>
      [...document.querySelectorAll("button.nav-item")].find(
        (b) => b.textContent.trim() === label,
      );

    for (const gated of ["Project", "Browser", "Goals", "Career", "Flashcards"]) {
      if (!item(gated)) continue;
      if (["Project", "Browser", "Goals", "Career"].includes(gated)) {
        expect(item(gated).disabled, `${gated} gated`).toBe(true);
      }
    }
    // Profile-independent destinations stay reachable.
    expect(item("Settings").disabled).toBe(false);
    expect(item("Profiles").disabled).toBe(false);
  });

  it("gives every destination a slim caption that fits the 64px numeric rail", async () => {
    render(NavRail, { props: { currentView: "home", profileReady: true } });

    for (const view of VIEWS) {
      const caption = captionFor(view.id);
      expect(caption, `${view.id} caption`).toBeTruthy();
      expect(caption, `${view.id} caption is a word, not a truncation`).not.toMatch(/\.\.\.|…/);
      // Five characters is what actually fits at 8.5px mono inside the rail's
      // usable width. This is the assertion that would have caught the
      // ellipsised "SUBJECTS"/"DEADLINES" captions in the first place.
      expect(caption.length, `${view.id} caption length`).toBeLessThanOrEqual(5);
    }
  });

  it("keeps the caption out of textContent and the accessible name", async () => {
    // The slim rail shows a short caption, but the FULL label is what the E2E
    // suite matches and what a screen reader must announce. The caption is drawn
    // from attr(data-caption) on an aria-hidden element, so neither the
    // anchored `/^\s*Project\s*$/` match nor the accessible name can see it.
    render(NavRail, { props: { currentView: "home", profileReady: true, slim: true } });

    const items = [...document.querySelectorAll("button.nav-item")];
    expect(items.length).toBe(railViews().length);

    for (const view of railViews()) {
      const btn = items.find((b) => b.textContent.trim() === view.label);
      expect(btn, `nav item "${view.label}"`).toBeTruthy();

      const cap = btn.querySelector(".nav-caption");
      expect(cap, `${view.id} caption element`).toBeTruthy();
      expect(cap.getAttribute("aria-hidden")).toBe("true");
      expect(cap.getAttribute("data-caption")).toBe(captionFor(view.id));
      // Empty element => nothing to leak into textContent or the name.
      expect(cap.textContent).toBe("");
      expect(btn.getAttribute("aria-label")).toBeNull();
    }
  });

  it("navigates when a destination is chosen", async () => {
    const onNavigate = vi.fn();
    render(NavRail, { props: { currentView: "home", profileReady: true, onNavigate } });
    const goals = document.querySelector("button.nav-item[data-testid='nav-goals']");
    await fireEvent.click(goals);
    expect(onNavigate).toHaveBeenCalledWith("goals");
  });
});

describe("settings", () => {
  it("opens on the vault so backup controls need no second click", async () => {
    render(SettingsHub, {
      props: { profiles: [{ id: 1, name: "Ada" }], activeProfile: { id: 1, name: "Ada" } },
    });

    expect(await screen.findByText("Data and vault")).toBeInTheDocument();

    // Drive the exact controls the backup/restore E2E flow clicks on landing.
    await waitFor(() => {
      expect(screen.getByText("Backup Active Profile")).toBeInTheDocument();
      expect(document.querySelectorAll(".backup-row").length).toBe(1);
      expect(document.querySelectorAll(".restore-btn").length).toBe(1);
    });
  });

  it("keeps existing backups restorable when the last local profile is gone", async () => {
    render(SettingsHub, {
      props: { profiles: [], activeProfile: null },
    });

    expect(await screen.findByText("Data and vault")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("ada-20260920")).toBeInTheDocument();
      expect(document.querySelectorAll(".restore-btn").length).toBe(1);
    });
    expect(screen.getByRole("button", { name: "Backup Active Profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Backup All" })).toBeDisabled();
  });

  it("swaps panes without losing the section rail", async () => {
    render(SettingsHub, { props: { profiles: [], activeProfile: null } });

    const diagnostics = screen.getByRole("button", { name: /Diagnostics/i });
    await fireEvent.click(diagnostics);

    await waitFor(() => {
      expect(screen.getByText("What each subsystem reports about itself, right now.")).toBeInTheDocument();
    });
    // Vault panel is unmounted: one pane at a time, not a scrolling wall.
    expect(screen.queryByText("Backup Active Profile")).not.toBeInTheDocument();
  });

  it("falls back to the first section when deep-linked to an unknown id", async () => {
    render(SettingsHub, { props: { initialSection: "does-not-exist" } });
    expect(await screen.findByText("Data and vault")).toBeInTheDocument();
  });
});

describe("keyboard reference", () => {
  it("lists the global chords when open", async () => {
    render(KeyboardHelp, { props: { open: true } });
    const dialog = await screen.findByRole("dialog", { name: /Keyboard/i });

    // Grouped by scope, and every chord has a spelled-out key.
    for (const group of ["Command", "Navigate", "Operator"]) {
      expect(dialog.textContent).toContain(group);
    }
    expect(dialog.textContent).toContain("Search everything, or run a command");
    expect(dialog.textContent).toContain("Allow the focused approval");
    expect([...dialog.querySelectorAll("kbd.cf-kbd")].map((k) => k.textContent)).toContain("K");
  });

  it("renders nothing when closed", () => {
    render(KeyboardHelp, { props: { open: false } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(KeyboardHelp, { props: { open: true, onClose } });
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("app shell", () => {
  it("composes: core readout, rail and stage all render", async () => {
    const { container } = render(App);

    // The E2E readiness gate.
    expect(await screen.findByText(PING)).toBeInTheDocument();
    // Navigation is present with the full routing vocabulary.
    expect(container.querySelectorAll("button.nav-item").length).toBe(railViews().length);
    // A real view renders in the stage (no profile => the profile chooser).
    await waitFor(() => {
      expect(document.querySelector("main")).toBeTruthy();
    });
  });

  it("routes from the rail into Settings, where the vault lives", async () => {
    render(App);
    await screen.findByText(PING);

    const settings = [...document.querySelectorAll("button.nav-item")].find(
      (b) => b.textContent.trim() === "Settings",
    );
    await fireEvent.click(settings);

    await waitFor(() => {
      expect(screen.getByText("Backup Active Profile")).toBeInTheDocument();
    });
  });

  it("keeps the operator console reachable from anywhere", async () => {
    render(App);
    await screen.findByText(PING);

    applyOperatorEvent({
      type: "agent.approval.required",
      agentId: 7,
      tool: "fs_write",
      permission: "WRITE",
    });

    // The console is a region of the shell, not a property of a view.
    await waitFor(() => {
      expect(screen.getByLabelText("Operator console")).toBeInTheDocument();
    });
    expect(operator.approvals.length).toBe(1);
  });
});
