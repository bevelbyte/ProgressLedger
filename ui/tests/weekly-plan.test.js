import { describe, it, expect } from "vitest";
import {
  localDay,
  currentWeek,
  classifyDeadline,
  buildWeeklyPlan,
  aggregateSessions,
} from "../src/features/dashboard/weekly-plan.js";

describe("localDay", () => {
  it("formats a Date to YYYY-MM-DD", () => {
    expect(localDay(new Date(2026, 0, 15))).toBe("2026-01-15");
  });
});

describe("currentWeek", () => {
  it("returns Monday and Sunday for a given date", () => {
    // 2026-01-15 is a Thursday
    const week = currentWeek("2026-01-15");
    expect(week.start).toBe("2026-01-12");
    expect(week.end).toBe("2026-01-18");
  });
  it("handles month boundaries", () => {
    // 2026-01-31 Saturday
    const week = currentWeek("2026-01-31");
    expect(week.start).toBe("2026-01-26");
    expect(week.end).toBe("2026-02-01");
  });
  it("treats Sunday as end of week", () => {
    const week = currentWeek("2026-01-18"); // Sunday
    expect(week.start).toBe("2026-01-12");
    expect(week.end).toBe("2026-01-18");
  });
});

describe("classifyDeadline", () => {
  const today = "2026-01-15";
  it("excludes completed deadlines", () => {
    const d = { deadlineDate: "2026-01-10", completedAt: "2026-01-12" };
    expect(classifyDeadline(d, today)).toBe("completed");
  });
  it("classifies overdue", () => {
    const d = { deadlineDate: "2026-01-10", completedAt: null };
    expect(classifyDeadline(d, today)).toBe("overdue");
  });
  it("classifies this week", () => {
    const d = { deadlineDate: "2026-01-16", completedAt: null };
    expect(classifyDeadline(d, today)).toBe("this-week");
  });
  it("classifies later", () => {
    const d = { deadlineDate: "2026-01-20", completedAt: null };
    expect(classifyDeadline(d, today)).toBe("later");
  });
});

describe("buildWeeklyPlan", () => {
  const today = "2026-01-15";
  const deadlines = [
    { id: 1, title: "Overdue", deadlineDate: "2026-01-10", subjectId: 10, subjectName: "Maths", completedAt: null },
    { id: 2, title: "This Week", deadlineDate: "2026-01-16", subjectId: 20, subjectName: "Physics", completedAt: null },
    { id: 3, title: "Completed", deadlineDate: "2026-01-05", subjectId: 30, subjectName: "Chem", completedAt: "2026-01-06" },
    { id: 4, title: "Later", deadlineDate: "2026-01-25", subjectId: 40, subjectName: "Bio", completedAt: null },
  ];
  it("buckets deadlines correctly and excludes completed", () => {
    const plan = buildWeeklyPlan({ deadlines, todayStr: today });
    expect(plan.overdue.length).toBe(1);
    expect(plan.thisWeek.length).toBe(1);
    expect(plan.later.length).toBe(1);
    expect(plan.focus.length).toBe(2); // only subjects with overdue or this‑week deadlines
    expect(plan.hasWork).toBe(true);
    expect(plan.count).toBe(2);
  });
  it("handles no deadlines", () => {
    const plan = buildWeeklyPlan({ deadlines: [], todayStr: today });
    expect(plan.overdue).toEqual([]);
    expect(plan.thisWeek).toEqual([]);
    expect(plan.focus).toEqual([]);
    expect(plan.hasWork).toBe(false);
    expect(plan.count).toBe(0);
  });
});

describe("aggregateSessions", () => {
  // Week containing Thursday 2026-01-15: Monday 2026-01-12 .. Sunday 2026-01-18.
  const today = "2026-01-15";

  it("counts only this week for production-format (space-separated) timestamps", () => {
    const sessions = [
      // Wednesday of the target week — in week.
      { subjectId: 10, durationMinutes: 30, startedAt: "2026-01-14 10:00:00" },
      // Sunday of the target week (the week's own end day) — in week.
      { subjectId: 10, durationMinutes: 10, startedAt: "2026-01-18 23:30:00" },
      // Same shape but last month — total only, never "this week".
      { subjectId: 10, durationMinutes: 45, startedAt: "2025-12-10 10:00:00" },
    ];
    const result = aggregateSessions(sessions, today);
    expect(result.bySubjectId[10].totalMinutes).toBe(85);
    expect(result.bySubjectId[10].thisWeekMinutes).toBe(40);
  });

  it("does not count the previous week's Sunday", () => {
    const result = aggregateSessions(
      [{ subjectId: 20, durationMinutes: 20, startedAt: "2026-01-11 09:00:00" }],
      today
    );
    expect(result.bySubjectId[20].totalMinutes).toBe(20);
    expect(result.bySubjectId[20].thisWeekMinutes).toBe(0);
  });

  it("does not count the week after", () => {
    const result = aggregateSessions(
      [{ subjectId: 20, durationMinutes: 20, startedAt: "2026-01-19 09:00:00" }],
      today
    );
    expect(result.bySubjectId[20].thisWeekMinutes).toBe(0);
  });

  it("still accepts ISO (T-separated) timestamps", () => {
    const result = aggregateSessions(
      [
        { subjectId: 30, durationMinutes: 5, startedAt: "2026-01-12T09:00:00" },
        { subjectId: 30, durationMinutes: 8, startedAt: "2025-11-02T09:00:00" },
      ],
      today
    );
    expect(result.bySubjectId[30].totalMinutes).toBe(13);
    expect(result.bySubjectId[30].thisWeekMinutes).toBe(5);
  });

  it("aggregates across subjects and counts the Monday boundary", () => {
    const result = aggregateSessions(
      [
        { subjectId: 10, durationMinutes: 15, startedAt: "2026-01-12 08:00:00" },
        { subjectId: 20, durationMinutes: 25, startedAt: "2026-01-15 20:00:00" },
      ],
      today
    );
    expect(result.bySubjectId[10].thisWeekMinutes).toBe(15);
    expect(result.bySubjectId[20].thisWeekMinutes).toBe(25);
  });

  it("keeps totals even when a session has no start timestamp", () => {
    const result = aggregateSessions(
      [
        { subjectId: 10, durationMinutes: 20 },
        { subjectId: 10, durationMinutes: 10, startedAt: null },
      ],
      today
    );
    expect(result.bySubjectId[10].totalMinutes).toBe(30);
    expect(result.bySubjectId[10].thisWeekMinutes).toBe(0);
  });

  it("skips rows with no subject and never invents minutes", () => {
    const result = aggregateSessions(
      [
        { durationMinutes: 99, startedAt: "2026-01-14 10:00:00" },
        { subjectId: 10, startedAt: "2026-01-14 10:00:00" },
      ],
      today
    );
    expect(Object.keys(result.bySubjectId)).toEqual(["10"]);
    expect(result.bySubjectId[10].totalMinutes).toBe(0);
    expect(result.bySubjectId[10].thisWeekMinutes).toBe(0);
  });

  it("returns an empty aggregation for empty or missing input", () => {
    expect(aggregateSessions([], today).bySubjectId).toEqual({});
    expect(aggregateSessions(null, today).bySubjectId).toEqual({});
    expect(aggregateSessions(undefined, today).bySubjectId).toEqual({});
  });
});