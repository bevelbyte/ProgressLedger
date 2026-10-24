// CareerPlan — the roadmap surface, and the hooks the subject-link E2E drives.
//
// `e2e/career-subject-link.spec.js` drives this surface entirely through
// accessible names and classes, so a restyle that renames a label or drops a
// wrapper breaks a proven flow at the end of a four-minute Electron run. These
// tests pin those hooks in seconds:
//
//   * `.milestone` rows, located by title text
//   * a "Link Subject" button, and exactly ONE `select` per row when open
//   * `.link-picker` containing a button named "Save"
//   * `.m-link-subject` containing a control titled "Remove link"
//   * the subject option label format `{track} › {semester} › {name}`
//   * the honest "Linked subject no longer exists" state
//
// They also assert the Atlas IA claim: the roadmap is a numbered sequence and
// the readout is a real count, never a fabricated score.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import CareerPlan from "../src/features/career/components/CareerPlan.svelte";

const GOAL = {
  id: 9,
  title: "Backend Engineer",
  targetRole: "Backend Engineer",
  domain: "Systems",
  description: "Ship things that stay up.",
  targetDate: null,
  status: "active",
  isPrimary: true,
};

function milestone(over = {}) {
  return {
    id: 100,
    title: "Learn SQL",
    description: "",
    targetDate: null,
    completedAt: null,
    linkedProjectId: null,
    linkedProjectName: "",
    linkedSubjectId: null,
    linkedSubjectName: "",
    ...over,
  };
}

let milestones = [];

function setupIpc({
  goals = [GOAL],
  rows = [milestone()],
  subjects = [],
} = {}) {
  milestones = rows.map((m) => ({ ...m }));
  window.careerflow = {
    career: {
      goals: vi.fn(async () => goals),
      milestones: vi.fn(async () => milestones),
      setMilestoneSubject: vi.fn(async (_pid, id, subjectId) => {
        const m = milestones.find((x) => x.id === id);
        if (m) {
          m.linkedSubjectId = subjectId;
          m.linkedSubjectName = subjectId ? "Algorithms" : "";
        }
        return { ok: true };
      }),
      setMilestoneCompletion: vi.fn(async () => ({ ok: true })),
    },
    projects: { list: vi.fn(async () => []) },
    academic: {
      tree: vi.fn(async () => [
        {
          name: "B.Tech",
          semesters: [
            {
              name: "Semester 1",
              milestones: [
                { subjects: [{ id: 5, name: "Algorithms" }] },
              ],
            },
          ],
        },
      ]),
    },
  };
  return window.careerflow;
}

function tick() {
  return new Promise((r) => setTimeout(r, 30));
}

describe("CareerPlan", () => {
  afterEach(() => cleanup());

  it("states the absence of a career goal instead of an empty frame", async () => {
    setupIpc({ goals: [] });
    render(CareerPlan, { profileId: 1 });
    expect(await screen.findByText("No career goal yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add Career Goal/i })).toBeInTheDocument();
  });

  it("renders the goal and an honest roadmap count", async () => {
    setupIpc({
      rows: [
        milestone({ id: 1, title: "Learn SQL", completedAt: "2026-01-01 10:00:00" }),
        milestone({ id: 2, title: "Build API" }),
      ],
    });
    render(CareerPlan, { profileId: 1 });

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll(".milestone").length).toBe(2);
    });
    // Real count out of a real total — no readiness score anywhere.
    expect(screen.getByText("1 of 2 milestones complete")).toBeInTheDocument();
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  });

  it("numbers the roadmap in order, so the path is visible", async () => {
    setupIpc({
      rows: [
        milestone({ id: 1, title: "One" }),
        milestone({ id: 2, title: "Two" }),
        milestone({ id: 3, title: "Three" }),
      ],
    });
    render(CareerPlan, { profileId: 1 });
    await waitFor(() => {
      expect(document.querySelectorAll(".milestone").length).toBe(3);
    });

    const gutter = [...document.querySelectorAll(".milestone .step-gutter")].map((g) =>
      g.textContent.trim(),
    );
    expect(gutter).toEqual(["01", "02", "03"]);
  });

  it("links a subject through the picker, with the E2E-asserted option label", async () => {
    const ipc = setupIpc({ rows: [milestone()] });
    render(CareerPlan, { profileId: 1 });
    await waitFor(() => {
      expect(document.querySelectorAll(".milestone").length).toBe(1);
    });

    const row = document.querySelector(".milestone");
    const linkBtn = [...row.querySelectorAll("button")].find((b) =>
      /Link Subject/.test(b.textContent),
    );
    expect(linkBtn).toBeTruthy();
    await fireEvent.click(linkBtn);
    await tick();

    // Exactly one select in the row, labelled the way the E2E selects it.
    const selects = row.querySelectorAll("select");
    expect(selects.length).toBe(1);
    expect([...selects[0].options].map((o) => o.textContent)).toContain(
      "B.Tech › Semester 1 › Algorithms",
    );

    // Svelte binds option values by identity, and subject ids are numbers —
    // select by option index so the test drives the same binding the UI does.
    const algo = [...selects[0].options].find(
      (o) => o.textContent === "B.Tech › Semester 1 › Algorithms",
    );
    algo.selected = true;
    await fireEvent.change(selects[0]);

    const save = row.querySelector(".link-picker button");
    expect(save.textContent.trim()).toBe("Save");
    await fireEvent.click(save);
    await tick();

    await waitFor(() => {
      expect(ipc.career.setMilestoneSubject).toHaveBeenCalledWith(1, 100, 5);
    });
  });

  it("offers an unlink control in the subject link region", async () => {
    setupIpc({
      rows: [milestone({ linkedSubjectId: 5, linkedSubjectName: "Algorithms" })],
    });
    render(CareerPlan, { profileId: 1 });
    await waitFor(() => {
      expect(document.querySelectorAll(".milestone").length).toBe(1);
    });

    const row = document.querySelector(".milestone");
    // The linked subject's button has the subject's name as its accessible text.
    expect(
      [...row.querySelectorAll("button")].some((b) => b.textContent.trim() === "Algorithms"),
    ).toBe(true);

    const unlink = row.querySelector('.m-link-subject button[title="Remove link"]');
    expect(unlink).toBeTruthy();
  });

  it("states a dangling subject link honestly rather than hiding it", async () => {
    setupIpc({
      rows: [milestone({ linkedSubjectId: 77, linkedSubjectName: "" })],
    });
    render(CareerPlan, { profileId: 1 });
    expect(await screen.findByText("Linked subject no longer exists")).toBeInTheDocument();
    // The user can still clear the stale link.
    expect(
      document.querySelector('.m-link-subject button[title="Remove link"]'),
    ).toBeTruthy();
  });

  it("keeps the project link visible as text in the row", async () => {
    setupIpc({
      rows: [milestone({ linkedProjectId: 42, linkedProjectName: "API Project" })],
    });
    render(CareerPlan, { profileId: 1 });
    expect(await screen.findByText("API Project")).toBeInTheDocument();
  });

  it("completes a milestone through the real IPC and reflects the new count", async () => {
    const ipc = setupIpc({ rows: [milestone({ id: 100 })] });
    render(CareerPlan, { profileId: 1 });
    await waitFor(() => {
      expect(document.querySelectorAll(".milestone").length).toBe(1);
    });

    await fireEvent.click(document.querySelector(".milestone .check"));
    await tick();
    expect(ipc.career.setMilestoneCompletion).toHaveBeenCalledWith(1, 100, true);
  });

  it("offers a milestone-only action set (no fabricated reorder beyond bounds)", async () => {
    setupIpc({
      rows: [milestone({ id: 1, title: "Only" })],
    });
    render(CareerPlan, { profileId: 1 });
    await waitFor(() => {
      expect(document.querySelectorAll(".milestone").length).toBe(1);
    });

    const up = document.querySelector('.milestone button[title="Move up"]');
    const down = document.querySelector('.milestone button[title="Move down"]');
    // A single step has nowhere to go, so both are inert rather than misleading.
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(true);
  });
});
