import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dashboard } from "../src/features/dashboard";

const fixture = {
  trackCount: 1,
  semesterCount: 2,
  milestoneCount: 3,
  subjectCount: 8,
  noteCount: 4,
  pdfCount: 2,
  resourceCount: 6,
  completionPct: 62.5,
  status: { pending: 2, inProgress: 1, done: 5 },
  currentStreak: 3,
  recent: [],
};

beforeEach(() => {
  window.careerflow = {
    dashboard: { stats: vi.fn().mockResolvedValue(fixture) },
    mistakes: { stats: vi.fn().mockResolvedValue({ totalMistakes: 0, top3Types: [] }) },
    deadlines: { list: vi.fn().mockResolvedValue([]) },
    cards: { stats: vi.fn().mockResolvedValue({ dueToday: 0, reviewedToday: 0, totalCards: 0, streak: 0 }), due: vi.fn().mockResolvedValue([]) },
    sessions: { stats: vi.fn().mockResolvedValue({ totalSessions: 0, totalMinutes: 0, minutesToday: 0, activeDays: 0 }), list: vi.fn().mockResolvedValue([]) },
    career: { goals: vi.fn().mockResolvedValue([]), milestones: vi.fn().mockResolvedValue([]) },
    focusSignals: { get: vi.fn().mockResolvedValue({ subjects: [], deadlines: [], cards: [], sessions: [], mistakes: [] }) },
  };

});

describe("Dashboard overview", () => {
  it("renders the selected profile and current progress metrics", async () => {
    render(Dashboard, {
      props: {
        profileId: 1,
        activeProfile: { id: 1, name: "John" },
        profiles: [{ id: 1, name: "John" }],
      },
    });

    expect(await screen.findByRole("heading", { name: "John" })).toBeInTheDocument();
    expect(await screen.findByText("Degree progress")).toBeInTheDocument();
    expect(await screen.findByText("63%")).toBeInTheDocument();
    expect(screen.getByText("Subjects done")).toBeInTheDocument();
    expect(screen.getByText("Resources")).toBeInTheDocument();

    await waitFor(() => {
      expect(window.careerflow.dashboard.stats).toHaveBeenCalledWith(1);
      expect(window.careerflow.mistakes.stats).toHaveBeenCalledWith(1);
      expect(window.careerflow.deadlines.list).toHaveBeenCalledWith(1);
      expect(window.careerflow.cards.stats).toHaveBeenCalledWith(1);
      expect(window.careerflow.sessions.stats).toHaveBeenCalledWith(1);
    });
  });

  it("shows a placeholder when no profile is selected", () => {
    render(Dashboard, { props: { profileId: null } });
    expect(screen.getByRole("heading", { name: /Select a student profile/i })).toBeInTheDocument();
  });

  // Regression guard: a FAILED dashboard read used to render a blank Desk.
  // `load()` resolves `stats = fulfilled ? value : null` and always clears
  // `loading`, so a rejection left `stats === null` with `loading === false`
  // and no `{#if}` branch matched at all — the user saw the app chrome and no
  // content, with no error and no way to retry.
  it("reports a failed overview read instead of rendering a blank Desk", async () => {
    window.careerflow.dashboard.stats = vi.fn().mockRejectedValue(new Error("boom"));

    render(Dashboard, {
      props: {
        profileId: 1,
        activeProfile: { id: 1, name: "John" },
        profiles: [{ id: 1, name: "John" }],
      },
    });

    expect(await screen.findByRole("heading", { name: /Could not load the overview/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    // It must NOT claim the day is empty, and must NOT show the real metrics.
    expect(screen.queryByText(/Degree progress/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Loading overview/i })).not.toBeInTheDocument();
  });

  it("recovers when the retry succeeds", async () => {
    const stats = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(fixture);
    window.careerflow.dashboard.stats = stats;

    render(Dashboard, {
      props: {
        profileId: 1,
        activeProfile: { id: 1, name: "John" },
        profiles: [{ id: 1, name: "John" }],
      },
    });

    const retry = await screen.findByRole("button", { name: /try again/i });
    await fireEvent.click(retry);

    expect(await screen.findByText("Degree progress")).toBeInTheDocument();
    expect(stats).toHaveBeenCalledTimes(2);
  });

  it("excludes completed exams from the Upcoming Exams panel", async () => {
    // Two future-dated exams: one active, one completed. Only the active one
    // should appear in "Upcoming Exams".
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    window.careerflow.deadlines.list = vi.fn().mockResolvedValue([
      { id: 1, subjectId: 1, subjectName: "Maths", deadlineDate: future, category: "exam", title: "Active Exam", notes: "", completedAt: null },
      { id: 2, subjectId: 1, subjectName: "Maths", deadlineDate: future, category: "exam", title: "Completed Exam", notes: "", completedAt: "2026-01-01 09:00:00" },
    ]);

    render(Dashboard, {
      props: {
        profileId: 1,
        activeProfile: { id: 1, name: "John" },
        profiles: [{ id: 1, name: "John" }],
      },
    });

    // The active exam appears (it may also surface in the Today section).
    expect((await screen.findAllByText("Active Exam")).length).toBeGreaterThan(0);
    // The completed exam must not appear anywhere on the dashboard.
    expect(screen.queryByText("Completed Exam")).not.toBeInTheDocument();
  });
  it("routes career actions to Career Planning and linked projects to Project Mode", async () => {
    const onNavigate = vi.fn();
    const projectEvent = vi.fn();
    window.addEventListener("cf:open-project", projectEvent);
    window.careerflow.career.goals = vi.fn().mockResolvedValue([
      { id: 9, title: "Backend Engineer", status: "active", isPrimary: true },
    ]);
    window.careerflow.career.milestones = vi.fn().mockResolvedValue([
      { id: 10, title: "Build API", completedAt: null, linkedProjectId: 42, linkedProjectName: "API Project" },
    ]);
    try {
      render(Dashboard, { props: { profileId: 1, activeProfile: { id: 1, name: "John" }, onNavigate } });
      const careerButton = await screen.findByRole("button", { name: "Open Career Plan" });
      careerButton.click();
      expect(onNavigate).toHaveBeenCalledWith("career");
      const projectButton = await screen.findByRole("button", { name: /API Project/ });
      projectButton.click();
      expect(projectEvent).toHaveBeenCalledTimes(1);
      expect(projectEvent.mock.calls[0][0].detail).toEqual({ projectId: 42 });
    } finally {
      window.removeEventListener("cf:open-project", projectEvent);
    }
  });
});

// ---------------------------------------------------------------------------
// The Desk's Today band.
//
// The agenda replaced two parallel deadline columns ("Due & Overdue" and
// "Coming Up") with a single ordered run. That restructure had to stay inside
// the hooks the focus E2E flow depends on, so those hooks are asserted here:
//   - `.today .today-col` matching /Study/, holding
//     `.today-study > div > strong|span` (the "N studied today" read-out)
//   - the same Start Focus / Start a session buttons, by label
//   - a clickable deadline title that deep-links into the subject workspace
//   - a "N flashcards due" affordance that routes to the Recall Deck
// ---------------------------------------------------------------------------

function localDayOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const agendaDeadlines = [
  { id: 11, subjectId: 5, subjectName: "Algorithms", deadlineDate: localDayOffset(-1), category: "assignment", title: "Lab Report", notes: "", completedAt: null },
  { id: 12, subjectId: 5, subjectName: "Algorithms", deadlineDate: localDayOffset(0), category: "exam", title: "Quiz", notes: "", completedAt: null },
  { id: 13, subjectId: 6, subjectName: "Physics", deadlineDate: localDayOffset(3), category: "project", title: "Project Writeup", notes: "", completedAt: null },
  { id: 14, subjectId: 6, subjectName: "Physics", deadlineDate: localDayOffset(40), category: "exam", title: "Far Exam", notes: "", completedAt: null },
];

describe("Dashboard Today band", () => {
  function mount(extra = {}, { minutesToday = 20, deadlines = agendaDeadlines } = {}) {
    window.careerflow.deadlines.list = vi.fn().mockResolvedValue(deadlines);
    window.careerflow.cards.stats = vi.fn().mockResolvedValue({ dueToday: 4, reviewedToday: 0, totalCards: 9, streak: 0 });
    window.careerflow.sessions.stats = vi.fn().mockResolvedValue({
      totalSessions: minutesToday > 0 ? 1 : 0,
      totalMinutes: minutesToday,
      minutesToday,
      activeDays: minutesToday > 0 ? 1 : 0,
    });
    const props = {
      profileId: 1,
      activeProfile: { id: 1, name: "John" },
      profiles: [{ id: 1, name: "John" }],
      ...extra,
    };
    const utils = render(Dashboard, { props });
    return { ...utils, ...props };
  }

  const todaySection = () => document.querySelector(".today");

  it("reads as one dated run, not two competing columns", async () => {
    mount();
    await screen.findByRole("heading", { name: "Today", exact: true });

    await waitFor(() => {
      expect(document.querySelectorAll(".today .agenda-row").length).toBe(3);
    });

    const rows = [...document.querySelectorAll(".today .agenda-row")];
    // Overdue first, then today, then the upcoming tail — one order, by date.
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual([
      "overdue",
      "today",
      "soon",
    ]);
    expect(rows.map((r) => r.querySelector(".ti-title").textContent)).toEqual([
      "Lab Report",
      "Quiz",
      "Project Writeup",
    ]);
    // The date gutter states when, in the shortest honest form.
    expect(rows.map((r) => r.querySelector(".agenda-gutter").textContent)).toEqual([
      "1d late",
      "today",
      "in 3d",
    ]);
    // Deadlines beyond the week are not on the Desk at all.
    expect(todaySection().textContent).not.toContain("Far Exam");
  });

  it("states the day's facts without encouragement", async () => {
    mount();
    await screen.findByRole("heading", { name: "Today", exact: true });
    expect(await screen.findByText("1 overdue · 1 due today · 4 cards to review.")).toBeInTheDocument();
    expect(screen.queryByText(/You're caught up/i)).not.toBeInTheDocument();
  });

  it("opens the subject workspace from an agenda row", async () => {
    const onOpenSubject = vi.fn();
    mount({ onOpenSubject });
    // Scoped to the Today band on purpose: the same overdue deadline also
    // renders in the "This Week" section further down the Desk.
    await waitFor(() => {
      expect(todaySection().textContent).toContain("Lab Report");
    });
    const title = [...todaySection().querySelectorAll(".ti-title")].find(
      (el) => el.textContent === "Lab Report",
    );
    title.closest("button").click();
    expect(onOpenSubject).toHaveBeenCalledWith(5);
  });

  it("keeps the Study column's read-out path and start actions intact", async () => {
    const onStartFocus = vi.fn();
    const onNavigate = vi.fn();
    mount({ onStartFocus, onNavigate });
    await screen.findByRole("heading", { name: "Today", exact: true });

    // The focus E2E flow locates this column by text and then reads exactly
    // this path for the "N studied today" figure.
    const columns = [...document.querySelectorAll(".today .today-col")].filter((c) =>
      /Study/.test(c.textContent),
    );
    expect(columns.length).toBe(1);
    const study = columns[0];

    await waitFor(() => {
      expect(study.querySelector(".today-study > div > strong").textContent).toBe("20m");
    });
    expect(study.querySelector(".today-study > div > span").textContent).toBe("studied today");

    const labels = [...study.querySelectorAll("button")].map((b) => b.textContent.trim());
    expect(labels.some((t) => /Start another/.test(t))).toBe(true);
    expect(labels.some((t) => /Log more/.test(t))).toBe(true);

    [...study.querySelectorAll("button")].find((b) => /Start another/.test(b.textContent)).click();
    expect(onStartFocus).toHaveBeenCalledWith(null);
  });

  it("offers Start Focus before any time is logged today", async () => {
    mount({}, { minutesToday: 0 });

    await waitFor(() => {
      const study = [...document.querySelectorAll(".today .today-col")].find((c) =>
        /Study/.test(c.textContent),
      );
      expect(study.textContent).toMatch(/Start Focus/);
      expect(study.textContent).toMatch(/Start a session/);
      expect(study.textContent).not.toMatch(/Start another/);
    });
  });

  it("routes the due-card affordance to the Recall Deck", async () => {
    const onNavigate = vi.fn();
    mount({ onNavigate });
    const cta = await screen.findByText(/flashcard.*due/i);
    cta.closest("button").click();
    expect(onNavigate).toHaveBeenCalledWith("flashcards");
  });

  // -------------------------------------------------------------------------
  // The Desk's "The week" load instrument.
  //
  // The band answers "is this week survivable", which the ranked queue above it
  // cannot. What is asserted here is the contract the panel has with the data:
  // seven columns always present, the count per day, and the two ways it must
  // NOT lie -- by counting finished work as load, or by filing an item on a day
  // it does not belong to. Both would make a finished or light week look heavy.
  // -------------------------------------------------------------------------
  describe("The week band", () => {
    const days = () => [...document.querySelectorAll(".atl-week-day")];

    it("always renders seven columns, even with nothing scheduled", async () => {
      mount();
      await waitFor(() => expect(days().length).toBe(7));
    });

    it("counts each open item against its own day", async () => {
      mount();
      await waitFor(() => expect(days().length).toBe(7));

      // agendaDeadlines: one overdue (-1), one today, one at +3, one at +40.
      const counts = days().map((d) => d.querySelector(".atl-week-value").textContent.trim());
      // Column 0 is today. The overdue item is NOT this week, and the +40 exam
      // is far outside the window -- neither may appear as load.
      expect(counts).toEqual(["1", "0", "0", "1", "0", "0", "0"]);
    });

    it("marks today as today and leaves the other six unmarked", async () => {
      mount();
      await waitFor(() => expect(days().length).toBe(7));
      expect(days().map((d) => d.getAttribute("data-today"))).toEqual([
        "true",
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
      ]);
    });

    it("scales tones so a crowded day is visually distinct from a lone item", async () => {
      mount(
        {},
        {
          deadlines: [
            ...agendaDeadlines,
            { id: 21, subjectId: 6, subjectName: "Physics", deadlineDate: localDayOffset(0), category: "lab", title: "Second", notes: "", completedAt: null },
          ],
        },
      );
      await waitFor(() => expect(days().length).toBe(7));
      // Two open items on today -> "full"; one at +3 -> "light".
      expect(days()[0].getAttribute("data-tone")).toBe("full");
      expect(days()[3].getAttribute("data-tone")).toBe("light");
    });

    it("does not count a completed item as load", async () => {
      mount(
        {},
        {
          deadlines: [
            { id: 31, subjectId: 5, subjectName: "Algorithms", deadlineDate: localDayOffset(0), category: "assignment", title: "Done already", notes: "", completedAt: "2026-01-01 09:00:00" },
          ],
        },
      );
      await waitFor(() => expect(days().length).toBe(7));
      // A finished week must read as finished, not as load the user still owes.
      expect(days()[0].querySelector(".atl-week-value").textContent.trim()).toBe("0");
      expect(document.querySelector(".atl-section-aside").closest("section").textContent).toMatch(
        /Nothing open in the next seven days/i,
      );
    });

    it("states the week's total in the section header", async () => {
      mount();
      await waitFor(() => expect(days().length).toBe(7));
      expect(screen.getByText(/2 open items over the next seven days/i)).toBeInTheDocument();
    });

    it("gives every column a text alternative instead of a second tab stop", async () => {
      mount();
      await waitFor(() => expect(days().length).toBe(7));
      // The agenda is already the accessible list of these items, so the
      // columns must not also be focusable controls.
      expect(document.querySelectorAll(".atl-week-day[role='img']").length).toBe(7);
      expect(document.querySelectorAll(".atl-week-day button").length).toBe(0);
    });
  });
});
