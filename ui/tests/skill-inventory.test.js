// SkillInventory — UI tests.
//
// Coverage:
//   - renders one row per skill returned by progressLedger.extensions.listSkills()
//   - trigger chips + scope pills render per row (project/global)
//   - search input filters across id / name / description / trigger (case-insensitive)
//   - click a row → calls previewSkill(id) → shows the SKILL.md preview
//   - click preview close (or same row) collapses it
//   - missing extensions namespace shows the "not available in this build" error
//   - empty registry + non-ok IPC both surface the empty-state cell
//
// The IPC namespace is mocked via window.progressLedger.extensions. Tests reset
// window.progressLedger between cases for hermetic isolation.

import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/svelte";
import { describe, it, expect, vi, afterEach } from "vitest";

import SkillInventory from "../src/features/project-mode/components/SkillInventory.svelte";

const SAMPLE_SKILLS = [
  {
    id: "tdd",
    name: "Test-driven development",
    description: "Write a failing test first, then the minimal code to make it pass.",
    triggers: ["test", "TDD", "red-green-refactor"],
    scope: "global",
    project: false,
    global: true,
    project_id: null,
  },
  {
    id: "security-review",
    name: "Security review",
    description: "Audit the working tree for injection, SSRF, and misconfigurations.",
    triggers: ["security", "audit", "review"],
    scope: "project",
    project: true,
    global: false,
    project_id: 42,
  },
  {
    id: "frontend-design",
    name: "Frontend design",
    description: "Small, tasteful UI changes; reuse design tokens.",
    triggers: ["ui", "svelte"],
    scope: "global",
    project: false,
    global: true,
    project_id: null,
  },
];

const SAMPLE_MD = "# TDD\n\nWrite the test first, then the code.\n\n## Triggers\n- test\n- TDD\n";

function setupIpc({
  skills = SAMPLE_SKILLS,
  listImpl = null,
  previewImpl = null,
  setEnabledImpl = null,
  withSetEnabled = true,
  noNamespace = false,
} = {}) {
  if (noNamespace) {
    // Simulate a build where the extensions namespace is absent.
    window.progressLedger = {};
    return { list: null, preview: null, setEnabled: null };
  }
  const list = vi.fn(listImpl || (async () => ({ ok: true, skills })));
  const preview = vi.fn(
    previewImpl ||
      (async (id) =>
        typeof id === "string" && id
          ? { ok: true, skillId: id, content: SAMPLE_MD }
          : { ok: false, reason: "not-found" }),
  );
  const extensions = { listSkills: list, previewSkill: preview };
  // The enable toggle is the ONLY state-mutating Skills channel. `withSetEnabled`
  // lets a case simulate an older build that does not expose it, which is how
  // the panel must behave: read-only, not broken.
  const setEnabled = withSetEnabled
    ? vi.fn(setEnabledImpl || (async () => ({ ok: true })))
    : null;
  if (setEnabled) extensions.setSkillEnabled = setEnabled;
  window.progressLedger = { extensions };
  return { list, preview, setEnabled };
}

afterEach(() => {
  cleanup();
  delete window.progressLedger;
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("SkillInventory — rendering", () => {
  it("renders one row per skill returned by extensions.listSkills()", async () => {
    setupIpc();
    render(SkillInventory);
    const rows = await screen.findAllByTestId("skill-row");
    expect(rows).toHaveLength(SAMPLE_SKILLS.length);
    // Each row exposes its id + scope.
    expect(rows.map((r) => r.dataset.skillId)).toEqual(
      SAMPLE_SKILLS.map((s) => s.id),
    );
    // Names are rendered in the name cell.
    expect(screen.getByText("Test-driven development")).toBeInTheDocument();
    expect(screen.getByText("Security review")).toBeInTheDocument();
  });

  it("renders trigger chips and the scope pill (project / global)", async () => {
    setupIpc();
    render(SkillInventory);
    await screen.findAllByTestId("skill-row");

    // Triggers render as chips.
    const chips = screen.getAllByTestId("skill-trigger").map((c) => c.textContent);
    expect(chips).toEqual(expect.arrayContaining(["test", "TDD", "audit", "ui", "svelte"]));

    // Scope pills: security-review is project, the other two are global.
    const tddRow = screen.getAllByTestId("skill-row").find((r) => r.dataset.skillId === "tdd");
    expect(tddRow.querySelector('[data-testid="skill-scope"]').textContent).toBe("global");
    expect(tddRow.dataset.skillScope).toBe("global");

    const secRow = screen.getAllByTestId("skill-row").find((r) => r.dataset.skillId === "security-review");
    expect(secRow.querySelector('[data-testid="skill-scope"]').textContent).toBe("project");
    expect(secRow.dataset.skillScope).toBe("project");
    // Project-scoped row shows the project id.
    expect(secRow.querySelector('[data-testid="skill-project-id"]').textContent).toBe("#42");
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("SkillInventory — filtering", () => {
  it("search filters by id, name, description, or trigger (case-insensitive)", async () => {
    setupIpc();
    render(SkillInventory);
    await screen.findAllByTestId("skill-row");

    // By trigger (upper-case input, lower-case needle on the trigger).
    fireEvent.input(screen.getByTestId("skill-inventory-search"), { target: { value: "SECURITY" } });
    await waitFor(() => {
      const rows = screen.getAllByTestId("skill-row");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.skillId).toBe("security-review");
    });

    // Reset and filter by trigger word that only appears in one skill.
    fireEvent.input(screen.getByTestId("skill-inventory-search"), { target: { value: "" } });
    await waitFor(() => expect(screen.getAllByTestId("skill-row")).toHaveLength(SAMPLE_SKILLS.length));

    fireEvent.input(screen.getByTestId("skill-inventory-search"), { target: { value: "svelte" } });
    await waitFor(() => {
      const rows = screen.getAllByTestId("skill-row");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.skillId).toBe("frontend-design");
    });
  });

  it("shows the no-match empty state when the search yields nothing", async () => {
    setupIpc();
    render(SkillInventory);
    await screen.findAllByTestId("skill-row");
    fireEvent.input(screen.getByTestId("skill-inventory-search"), {
      target: { value: "definitely-not-a-real-skill" },
    });
    await waitFor(() => expect(screen.getByTestId("skill-inventory-empty")).toBeInTheDocument());
    expect(screen.getByText(/No skills match the current search/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe("SkillInventory — preview", () => {
  it("clicking a row opens the SKILL.md preview via extensions.previewSkill(id)", async () => {
    const { preview } = setupIpc();
    render(SkillInventory);
    await screen.findAllByTestId("skill-row");

    expect(screen.queryByTestId("skill-preview")).not.toBeInTheDocument();
    const tddRow = screen.getAllByTestId("skill-row").find((r) => r.dataset.skillId === "tdd");
    fireEvent.click(tddRow);

    // previewSkill called with the row's id.
    await waitFor(() => expect(preview).toHaveBeenCalledWith("tdd"));
    const previewPanel = await screen.findByTestId("skill-preview");
    expect(previewPanel.dataset.skillId).toBe("tdd");
    // Body contains the raw SKILL.md content.
    const body = await screen.findByTestId("skill-preview-body");
    expect(body.textContent).toContain("# TDD");
    expect(body.textContent).toContain("Write the test first");
  });

  it("clicking the same row again collapses the preview", async () => {
    setupIpc();
    render(SkillInventory);
    await screen.findAllByTestId("skill-row");
    const row = screen.getAllByTestId("skill-row").find((r) => r.dataset.skillId === "tdd");
    fireEvent.click(row);
    await screen.findByTestId("skill-preview");
    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByTestId("skill-preview")).not.toBeInTheDocument());
  });

  it("the preview close button collapses the preview", async () => {
    setupIpc();
    render(SkillInventory);
    await screen.findAllByTestId("skill-row");
    const row = screen.getAllByTestId("skill-row").find((r) => r.dataset.skillId === "tdd");
    fireEvent.click(row);
    const closeBtn = await screen.findByTestId("skill-preview-close");
    fireEvent.click(closeBtn);
    await waitFor(() => expect(screen.queryByTestId("skill-preview")).not.toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// Empty / failure states
// ---------------------------------------------------------------------------

describe("SkillInventory — empty / failure states", () => {
  it("renders the empty hint when the registry returns no skills", async () => {
    setupIpc({ skills: [] });
    render(SkillInventory);
    await waitFor(() => expect(screen.getByTestId("skill-inventory-empty")).toBeInTheDocument());
    expect(screen.getByText(/No skills installed/i)).toBeInTheDocument();
    expect(screen.queryByTestId("skill-row")).toBeNull();
  });

  it("treats a non-ok IPC response as an empty list (does not throw)", async () => {
    setupIpc({ listImpl: async () => ({ ok: false, reason: "no-userdata" }) });
    render(SkillInventory);
    // load-error message renders, and no rows.
    await waitFor(() => expect(screen.getByTestId("skill-inventory-load-error")).toBeInTheDocument());
    expect(screen.queryByTestId("skill-row")).toBeNull();
  });

  it("surfaces 'not available in this build' when the extensions namespace is missing", async () => {
    setupIpc({ noNamespace: true });
    render(SkillInventory);
    await waitFor(() => expect(screen.getByTestId("skill-inventory-load-error")).toBeInTheDocument());
    expect(screen.getByText(/not available in this build/i)).toBeInTheDocument();
  });
});

  // ---------------------------------------------------------------------------
  // The enable toggle — the only state-mutating Skills channel
  //
  // `skills:set-enabled` had NO renderer caller at all, so the one Skills
  // operation that actually changes what the agent is told was unreachable
  // from the product. These cases pin the wiring: it calls the real preload
  // signature, it reflects the RESULT rather than the optimism, and it degrades
  // to read-only instead of breaking when the channel or a profile is absent.
  // ---------------------------------------------------------------------------

  describe("SkillInventory — enable toggle", () => {
    it("calls setSkillEnabled(skillId, profileId, projectId, enabled) and marks the row enabled", async () => {
      const { setEnabled } = setupIpc();
      render(SkillInventory, { profileId: 7, projectId: null });
      const rows = await screen.findAllByTestId("skill-row");
      expect(rows[0].dataset.skillEnabled).toBe("false");

      const toggle = within(rows[0]).getByTestId("skill-enable-toggle");
      expect(toggle).toHaveTextContent("Enable");
      await fireEvent.click(toggle);

      await waitFor(() => expect(setEnabled).toHaveBeenCalledTimes(1));
      // Positional preload signature: (skillId, profileId, projectId, enabled)
      expect(setEnabled).toHaveBeenCalledWith("tdd", 7, null, true);
      // Reflected only after the shell confirmed it.
      await waitFor(() => expect(rows[0].dataset.skillEnabled).toBe("true"));
      expect(within(rows[0]).getByTestId("skill-enable-toggle")).toHaveTextContent("Enabled");
    });

    it("passes the active projectId through for a project-scoped toggle", async () => {
      const { setEnabled } = setupIpc();
      render(SkillInventory, { profileId: 3, projectId: 42 });
      const rows = await screen.findAllByTestId("skill-row");
      const securityRow = rows.find((r) => r.dataset.skillId === "security-review");
      await fireEvent.click(within(securityRow).getByTestId("skill-enable-toggle"));
      await waitFor(() => expect(setEnabled).toHaveBeenCalledWith("security-review", 3, 42, true));
    });

    it("does NOT mark a skill enabled when the shell refuses it, and shows the reason", async () => {
      // The shell owns the ownership gate; a refusal must leave the row off.
      const { setEnabled } = setupIpc({
        setEnabledImpl: async () => ({ ok: false, reason: "profile-not-found" }),
      });
      render(SkillInventory, { profileId: 7 });
      const rows = await screen.findAllByTestId("skill-row");
      await fireEvent.click(within(rows[0]).getByTestId("skill-enable-toggle"));

      await waitFor(() => expect(screen.getByTestId("skill-inventory-toggle-error")).toBeInTheDocument());
      expect(screen.getByTestId("skill-inventory-toggle-error")).toHaveTextContent("profile-not-found");
      // Optimistic enablement would be a lie here.
      expect(rows[0].dataset.skillEnabled).toBe("false");
    });

    it("toggles back off and calls the channel with enabled:false", async () => {
      const { setEnabled } = setupIpc();
      render(SkillInventory, { profileId: 7 });
      const rows = await screen.findAllByTestId("skill-row");
      await fireEvent.click(within(rows[0]).getByTestId("skill-enable-toggle"));
      await waitFor(() => expect(rows[0].dataset.skillEnabled).toBe("true"));
      await fireEvent.click(within(rows[0]).getByTestId("skill-enable-toggle"));
      await waitFor(() => expect(setEnabled).toHaveBeenLastCalledWith("tdd", 7, null, false));
      await waitFor(() => expect(rows[0].dataset.skillEnabled).toBe("false"));
    });

    it("clicking the toggle does not also expand the row preview", async () => {
      const { preview } = setupIpc();
      render(SkillInventory, { profileId: 7 });
      const rows = await screen.findAllByTestId("skill-row");
      await fireEvent.click(within(rows[0]).getByTestId("skill-enable-toggle"));
      await waitFor(() => expect(screen.queryByTestId("skill-preview")).not.toBeInTheDocument());
      expect(preview).not.toHaveBeenCalled();
    });

    it("stays read-only when no profile is active instead of calling the channel", async () => {
      const { setEnabled } = setupIpc();
      render(SkillInventory, { profileId: null });
      const rows = await screen.findAllByTestId("skill-row");
      expect(within(rows[0]).getByTestId("skill-enable-unavailable")).toBeInTheDocument();
      expect(within(rows[0]).queryByTestId("skill-enable-toggle")).toBeNull();
      expect(setEnabled).not.toHaveBeenCalled();
    });

    it("stays read-only when the build does not expose setSkillEnabled", async () => {
      const { setEnabled } = setupIpc({ withSetEnabled: false });
      render(SkillInventory, { profileId: 7 });
      const rows = await screen.findAllByTestId("skill-row");
      expect(within(rows[0]).getByTestId("skill-enable-unavailable")).toBeInTheDocument();
      expect(setEnabled).toBeNull();
    });

    it("surfaces a thrown toggle failure without marking the row enabled", async () => {
      const { setEnabled } = setupIpc({
        setEnabledImpl: async () => { throw new Error("ipc exploded"); },
      });
      render(SkillInventory, { profileId: 7 });
      const rows = await screen.findAllByTestId("skill-row");
      await fireEvent.click(within(rows[0]).getByTestId("skill-enable-toggle"));
      await waitFor(() => expect(screen.getByTestId("skill-inventory-toggle-error")).toBeInTheDocument());
      expect(setEnabled).toHaveBeenCalledTimes(1);
      expect(rows[0].dataset.skillEnabled).toBe("false");
    });
  });
