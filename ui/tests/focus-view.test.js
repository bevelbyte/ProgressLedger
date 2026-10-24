import { describe, it, expect } from "vitest";
import {
  formatClock,
  elapsedWholeMinutes,
  focusSubjects,
  nearestDeadline,
  deadlinePhrase,
  buildFocusContext,
  contextIsEmpty,
  resolveFinish,
} from "../src/features/focus/focus-view.js";

describe("formatClock", () => {
  it("formats a sub-minute elapsed time", () => {
    expect(formatClock(0, 59_000)).toBe("00:00:59");
  });

  it("formats hours, minutes and seconds", () => {
    expect(formatClock(0, 3661_000)).toBe("01:01:01");
  });

  it("pads every field to two digits", () => {
    expect(formatClock(0, 1_000)).toBe("00:00:01");
  });

  it("never goes negative when the end precedes the start", () => {
    expect(formatClock(100_000, 10_000)).toBe("00:00:00");
  });

  it("tolerates non-numeric input", () => {
    expect(formatClock(null, undefined)).toBe("00:00:00");
  });
});

describe("elapsedWholeMinutes", () => {
  it("is zero under a minute", () => {
    expect(elapsedWholeMinutes(0, 59_999)).toBe(0);
  });

  it("is one at exactly a minute", () => {
    expect(elapsedWholeMinutes(0, 60_000)).toBe(1);
  });

  it("floors rather than rounds up", () => {
    expect(elapsedWholeMinutes(0, 90_000)).toBe(1);
    expect(elapsedWholeMinutes(0, 65_000)).toBe(1);
    expect(elapsedWholeMinutes(0, 120_000)).toBe(2);
  });

  it("never returns negative minutes", () => {
    expect(elapsedWholeMinutes(100_000, 0)).toBe(0);
  });

  it("returns zero for non-numeric input instead of NaN", () => {
    expect(elapsedWholeMinutes(null, undefined)).toBe(0);
    expect(elapsedWholeMinutes(undefined, undefined)).toBe(0);
  });
});

describe("focusSubjects", () => {
  const tree = [
    {
      name: "B.Tech",
      semesters: [
        {
          name: "Semester 5",
          milestones: [
            {
              title: "Core",
              subjects: [
                { id: 11, name: "Data Structures" },
                { id: 12, name: "Databases" },
              ],
            },
            {
              title: "Electives",
              subjects: [{ id: 21, name: "Machine Learning" }],
            },
          ],
        },
      ],
    },
  ];

  it("flattens every subject with its placement path", () => {
    const subjects = focusSubjects(tree);
    expect(subjects).toHaveLength(3);
    expect(subjects[0]).toMatchObject({
      id: 11,
      name: "Data Structures",
      trackName: "B.Tech",
      semesterName: "Semester 5",
      path: "B.Tech › Semester 5 › Core",
      label: "Data Structures — B.Tech / Semester 5",
    });
    expect(subjects[2].path).toBe("B.Tech › Semester 5 › Electives");
  });

  it("keeps ids intact for IPC use", () => {
    const subjects = focusSubjects(tree);
    expect(subjects.map((s) => s.id)).toEqual([11, 12, 21]);
    expect(subjects.every((s) => typeof s.id === "number")).toBe(true);
  });

  it("returns an empty list for empty or missing trees", () => {
    expect(focusSubjects([])).toEqual([]);
    expect(focusSubjects(null)).toEqual([]);
    expect(focusSubjects(undefined)).toEqual([]);
  });

  it("survives a malformed tree shape", () => {
    expect(focusSubjects([{ semesters: [] }, { name: "X" }, null])).toEqual([]);
    expect(focusSubjects([{ name: "T", semesters: [{}] }])).toEqual([]);
    expect(focusSubjects([null, { semesters: [null] }, { semesters: [{ milestones: [null] }] }])).toEqual([]);
    // A subject without an id cannot be logged against, so it is dropped.
    expect(
      focusSubjects([
        { name: "T", semesters: [{ name: "S", milestones: [{ title: "M", subjects: [{ id: null }, { name: "No id" }] }] }] },
      ])
    ).toEqual([]);
  });
});

describe("nearestDeadline", () => {
  const today = "2026-08-29";

  it("picks the earliest active deadline", () => {
    const result = nearestDeadline(
      [
        { title: "Later", deadlineDate: "2026-09-10" },
        { title: "Soonest", deadlineDate: "2026-09-01" },
        { title: "Between", deadlineDate: "2026-09-05" },
      ],
      today
    );
    expect(result.title).toBe("Soonest");
    expect(result.date).toBe("2026-09-01");
    expect(result.delta).toBe(3);
  });

  it("ignores completed deadlines", () => {
    const result = nearestDeadline(
      [
        { title: "Done", deadlineDate: "2026-08-01", completedAt: "2026-08-01T10:00:00" },
        { title: "Active", deadlineDate: "2026-09-05" },
      ],
      today
    );
    expect(result.title).toBe("Active");
  });

  it("ignores rows with no date", () => {
    expect(nearestDeadline([{ title: "No date" }], today)).toBeNull();
    expect(nearestDeadline([{ title: "Empty", deadlineDate: "" }], today)).toBeNull();
    expect(nearestDeadline([null, undefined], today)).toBeNull();
  });

  it("returns null for an empty or missing list", () => {
    expect(nearestDeadline([], today)).toBeNull();
    expect(nearestDeadline(null, today)).toBeNull();
    expect(nearestDeadline(undefined, today)).toBeNull();
  });

  it("computes overdue deltas on the local calendar", () => {
    const result = nearestDeadline([{ title: "Past", deadlineDate: "2026-08-27" }], today);
    expect(result.delta).toBe(-2);
  });

  it("falls back to the date when there is no title", () => {
    const result = nearestDeadline([{ deadlineDate: "2026-09-01" }], today);
    expect(result.title).toBe("2026-09-01");
  });
});

describe("deadlinePhrase", () => {
  it("describes overdue deadlines", () => {
    expect(deadlinePhrase({ delta: -1 })).toBe("1 day overdue");
    expect(deadlinePhrase({ delta: -3 })).toBe("3 days overdue");
  });

  it("describes due-today, tomorrow and later deadlines", () => {
    expect(deadlinePhrase({ delta: 0 })).toBe("due today");
    expect(deadlinePhrase({ delta: 1 })).toBe("due tomorrow");
    expect(deadlinePhrase({ delta: 5 })).toBe("due in 5 days");
  });

  it("is empty for no deadline", () => {
    expect(deadlinePhrase(null)).toBe("");
    expect(deadlinePhrase(undefined)).toBe("");
  });
});

describe("contextIsEmpty", () => {
  it("is empty for a quiet subject with zeros, not nulls", () => {
    // A valid subject's overview always returns numbers, so a quiet subject has
    // 0s here — never nulls. The UI must still say "nothing pending".
    expect(contextIsEmpty({ nearestDeadline: null, flashcardsDue: 0, minutesToday: 0 })).toBe(true);
  });

  it("is empty when only the unavailable fields are null", () => {
    expect(contextIsEmpty({ nearestDeadline: null, flashcardsDue: null, minutesToday: null })).toBe(true);
    expect(contextIsEmpty({ nearestDeadline: null, flashcardsDue: null, minutesToday: 0 })).toBe(true);
  });

  it("is empty for a missing context object", () => {
    expect(contextIsEmpty(null)).toBe(true);
    expect(contextIsEmpty(undefined)).toBe(true);
  });

  it("is not empty when a deadline is pending", () => {
    expect(
      contextIsEmpty({ nearestDeadline: { title: "Assignment", delta: 2 }, flashcardsDue: 0, minutesToday: 0 })
    ).toBe(false);
  });

  it("is not empty when flashcards are due", () => {
    expect(contextIsEmpty({ nearestDeadline: null, flashcardsDue: 3, minutesToday: 0 })).toBe(false);
    expect(contextIsEmpty({ nearestDeadline: null, flashcardsDue: 1, minutesToday: 0 })).toBe(false);
  });

  it("is not empty once time has been studied today", () => {
    expect(contextIsEmpty({ nearestDeadline: null, flashcardsDue: 0, minutesToday: 1 })).toBe(false);
    expect(contextIsEmpty({ nearestDeadline: null, flashcardsDue: 0, minutesToday: 120 })).toBe(false);
  });

  it("ignores garbage values rather than treating them as content", () => {
    expect(contextIsEmpty({ nearestDeadline: null, flashcardsDue: "many", minutesToday: "45" })).toBe(true);
    expect(contextIsEmpty({ nearestDeadline: null, flashcardsDue: -5, minutesToday: -1 })).toBe(true);
  });
});

describe("buildFocusContext", () => {
  // Self-dated: pick a deadline 3 days from real-today so the delta
  // assertion stays valid regardless of when the test runs. The
  // production code uses local-calendar dayDelta, so the test must
  // also use local-calendar "today" (not UTC ISO slice, which is off
  // by one in positive-offset timezones).
  const localToday = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const localAddDays = (yyyymmdd, n) => {
    const [y, m, d] = yyyymmdd.split("-").map(Number);
    const t = new Date(y, m - 1, d);
    t.setDate(t.getDate() + n);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  };
  const inThreeDaysStr = localAddDays(localToday, 3);

  it("surfaces only real, already-fetched data", () => {
    const ctx = buildFocusContext({
      subjectName: "Data Structures",
      path: "B.Tech › Semester 5 › Core",
      overview: { studyMinutesToday: 45, flashcardDue: 7 },
      deadlines: [{ title: "Assignment", deadlineDate: inThreeDaysStr }],
    }, );
    expect(ctx.subjectName).toBe("Data Structures");
    expect(ctx.path).toBe("B.Tech › Semester 5 › Core");
    expect(ctx.minutesToday).toBe(45);
    expect(ctx.flashcardsDue).toBe(7);
    expect(ctx.nearestDeadline).toMatchObject({ title: "Assignment", delta: 3 });
  });

  it("degrades to nulls when the overview fetch failed", () => {
    const ctx = buildFocusContext({
      subjectName: "Databases",
      overview: null,
      deadlines: [],
    });
    expect(ctx.minutesToday).toBeNull();
    expect(ctx.flashcardsDue).toBeNull();
    expect(ctx.nearestDeadline).toBeNull();
  });

  it("keeps minutesToday when the caller supplies it explicitly", () => {
    const ctx = buildFocusContext({ overview: { studyMinutesToday: 5 }, minutesToday: 12 });
    expect(ctx.minutesToday).toBe(12);
  });

  it("does not invent a deadline from an incomplete list", () => {
    expect(buildFocusContext({ deadlines: [] }).nearestDeadline).toBeNull();
    expect(buildFocusContext({ deadlines: null }).nearestDeadline).toBeNull();
  });

  it("does not fabricate flashcard counts from non-numeric values", () => {
    expect(buildFocusContext({ overview: { flashcardDue: "many" } }).flashcardsDue).toBeNull();
    expect(buildFocusContext({ overview: {} }).flashcardsDue).toBeNull();
  });
});

describe("resolveFinish", () => {
  it("never logs when nothing was running", () => {
    expect(resolveFinish({ startedMs: null, finishedAtMs: Date.now(), minutes: 0 })).toMatchObject({
      ok: false,
      reason: "not-running",
    });
    expect(resolveFinish({ startedMs: 1000, finishedAtMs: null, minutes: 10 })).toMatchObject({
      ok: false,
      reason: "not-running",
    });
    expect(resolveFinish({})).toMatchObject({ ok: false, reason: "not-running" });
  });

  it("refuses to log sub-minute sessions", () => {
    const t = Date.parse("2026-08-29T09:00:00");
    expect(resolveFinish({ startedMs: t, finishedAtMs: t + 30_000, minutes: 0 })).toMatchObject({
      ok: false,
      reason: "too-short",
    });
    expect(resolveFinish({ startedMs: t, finishedAtMs: t + 59_000, minutes: 0 })).toMatchObject({
      ok: false,
      reason: "too-short",
    });
  });

  it("derives whole minutes from the elapsed time when none is passed", () => {
    const t = Date.parse("2026-08-29T09:00:00");
    const result = resolveFinish({ startedMs: t, finishedAtMs: t + 61_000 });
    expect(result).toMatchObject({ ok: true, reason: null, minutes: 1 });
  });

  it("accepts a one-minute session", () => {
    const t = Date.parse("2026-08-29T09:00:00");
    const result = resolveFinish({ startedMs: t, finishedAtMs: t + 60_000, minutes: 1 });
    expect(result).toMatchObject({ ok: true, minutes: 1 });
  });

  it("accepts very long sessions without an upper bound", () => {
    const t = Date.parse("2026-08-29T00:00:00");
    const result = resolveFinish({ startedMs: t, finishedAtMs: t + 48 * 3600_000, minutes: 2880 });
    expect(result).toMatchObject({ ok: true, minutes: 2880 });
  });

  it("treats the objective as optional and trims it", () => {
    const t = Date.parse("2026-08-29T09:00:00");
    expect(resolveFinish({ startedMs: t, finishedAtMs: t + 60_000, minutes: 1 }).objective).toBeNull();
    expect(resolveFinish({ startedMs: t, finishedAtMs: t + 60_000, minutes: 1, objective: "" }).objective).toBeNull();
    expect(resolveFinish({ startedMs: t, finishedAtMs: t + 60_000, minutes: 1, objective: "   " }).objective).toBeNull();
    expect(
      resolveFinish({ startedMs: t, finishedAtMs: t + 60_000, minutes: 1, objective: "  Finish Unit 4  " }).objective
    ).toBe("Finish Unit 4");
  });

  it("rounds the supplied minute count", () => {
    const t = Date.parse("2026-08-29T09:00:00");
    expect(resolveFinish({ startedMs: t, finishedAtMs: t + 60_000, minutes: 1.4 }).minutes).toBe(1);
    expect(resolveFinish({ startedMs: t, finishedAtMs: t + 60_000, minutes: 1.6 }).minutes).toBe(2);
  });

  it("clamps a negative supplied minute count to too-short", () => {
    const t = Date.parse("2026-08-29T09:00:00");
    expect(resolveFinish({ startedMs: t, finishedAtMs: t + 120_000, minutes: -5 })).toMatchObject({
      ok: false,
      reason: "too-short",
    });
  });
});


// Regression (Phase 17): focusService must thread profileId into the shared
// services — the old signature dropped it, shifting every argument one slot
// (profileId=subjectId, subjectId=durationMinutes, durationMinutes=startedAt),
// which made every Finish click fail at the NAPI boundary ("String into i32").
// The service is imported with its real dependencies stubbed so the runes
// store / .svelte modules never load in this environment.
import { describe as focusSvcDescribe, it as focusSvcIt, expect as focusSvcExpect, vi } from "vitest";

vi.mock("../src/features/study-sessions", () => ({
  sessionsService: { add: vi.fn(async () => undefined) },
}));
vi.mock("../src/features/notes", () => ({
  noteService: { addNote: vi.fn(async () => undefined) },
}));
vi.mock("../src/features/subjects", () => ({
  subjectService: {
    getOverview: vi.fn(async () => null),
    listSubjectDeadlines: vi.fn(async () => []),
  },
}));

focusSvcDescribe("focusService IPC threading", () => {
  focusSvcIt("addSession forwards profileId as the first argument", async () => {
    const { focusService } = await import("../src/features/focus/services/focus.service.js");
    const { sessionsService } = await import("../src/features/study-sessions");
    await focusService.addSession(7, 42, 5, "2026-09-03 10:00:00", "2026-09-03 10:05:00", "obj");
    expect(sessionsService.add).toHaveBeenCalledWith(
      7, 42, 5, "2026-09-03 10:00:00", "2026-09-03 10:05:00", "obj"
    );
  });

  focusSvcIt("addQuickNote forwards profileId as the first argument", async () => {
    const { focusService } = await import("../src/features/focus/services/focus.service.js");
    const { noteService } = await import("../src/features/notes");
    await focusService.addQuickNote(7, 42, "Title", "Body");
    expect(noteService.addNote).toHaveBeenCalledWith(7, 42, "Title", "Body");
  });
});
