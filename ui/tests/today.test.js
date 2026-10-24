import { describe, it, expect } from "vitest";
import {
  localDayString,
  dayDelta,
  classifyDeadline,
  buildToday,
  buildAgenda,
  agendaGutter,
  agendaStateLabel,
  agendaSummary,
} from "../src/features/dashboard/today.js";

describe("localDayString / dayDelta", () => {
  it("formats a local YYYY-MM-DD", () => {
    expect(localDayString(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
  it("computes whole-day deltas on local calendar", () => {
    expect(dayDelta("2026-01-05", "2026-01-05")).toBe(0);
    expect(dayDelta("2026-01-06", "2026-01-05")).toBe(1);
    expect(dayDelta("2026-01-04", "2026-01-05")).toBe(-1);
    expect(dayDelta("2026-02-01", "2026-01-31")).toBe(1); // month boundary
  });
});

describe("classifyDeadline", () => {
  const today = "2026-01-15";
  it("classifies overdue / today / soon / later", () => {
    expect(classifyDeadline("2026-01-14", today)).toBe("overdue");
    expect(classifyDeadline("2026-01-15", today)).toBe("today");
    expect(classifyDeadline("2026-01-18", today)).toBe("soon");
    expect(classifyDeadline("2026-01-22", today)).toBe("soon"); // within 7 days
    expect(classifyDeadline("2026-01-23", today)).toBe("later"); // 8 days out
  });
});

describe("buildToday", () => {
  const today = "2026-01-15";
  const deadlines = [
    { id: 1, title: "Old Assignment", deadlineDate: "2026-01-10", category: "assignment", subjectId: 7, subjectName: "Maths" },
    { id: 2, title: "Quiz", deadlineDate: "2026-01-15", category: "exam", subjectId: 7, subjectName: "Maths" },
    { id: 3, title: "Project", deadlineDate: "2026-01-19", category: "project", subjectId: 8, subjectName: "Physics" },
    { id: 4, title: "Far Exam", deadlineDate: "2026-03-01", category: "exam", subjectId: 8, subjectName: "Physics" },
  ];

  // ---- The Desk's agenda -------------------------------------------------
  //
  // The Desk used to render overdue and upcoming work as two separate columns,
  // so "what is next" required reading two places and comparing them. The
  // agenda is those buckets as ONE ordered run; these tests pin the ordering,
  // the gutter wording, and the cap on the upcoming tail.
  describe("buildAgenda", () => {
    const model = {
      overdue: [
        { id: 1, title: "Old", deadlineDate: "2026-01-10", dayDelta: -5 },
        { id: 2, title: "Older", deadlineDate: "2026-01-08", dayDelta: -7 },
      ],
      dueToday: [{ id: 3, title: "Quiz", deadlineDate: "2026-01-15", dayDelta: 0 }],
      soon: [
        { id: 4, title: "Project", deadlineDate: "2026-01-19", dayDelta: 4 },
        { id: 5, title: "Reading", deadlineDate: "2026-01-20", dayDelta: 5 },
        { id: 6, title: "Essay", deadlineDate: "2026-01-21", dayDelta: 6 },
        { id: 7, title: "Lab", deadlineDate: "2026-01-22", dayDelta: 7 },
      ],
    };

    it("orders overdue → today → upcoming in one run", () => {
      expect(buildAgenda(model).map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it("stamps each row with the bucket it came from", () => {
      expect(buildAgenda(model).map((r) => r.state)).toEqual([
        "overdue", "overdue", "today", "soon", "soon", "soon", "soon",
      ]);
    });

    it("caps only the upcoming tail, never the work you are already late on", () => {
      const capped = buildAgenda(model, { soonLimit: 2 });
      expect(capped.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
      // Nothing overdue is ever dropped, however many there are.
      const manyLate = buildAgenda(
        { overdue: Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, dayDelta: -1 })), soon: [] },
        { soonLimit: 1 },
      );
      expect(manyLate.length).toBe(20);
    });

    it("tolerates an empty or partial model", () => {
      expect(buildAgenda()).toEqual([]);
      expect(buildAgenda({})).toEqual([]);
      expect(buildAgenda({ dueToday: [{ id: 9, dayDelta: 0 }] }).length).toBe(1);
    });

    it("does not mutate the model it is given", () => {
      const input = JSON.parse(JSON.stringify(model));
      buildAgenda(model, { soonLimit: 1 });
      expect(input.soon.length).toBe(4);
    });
  });

  describe("agendaGutter", () => {
    it("states lateness in days, and today/tomorrow in words", () => {
      expect(agendaGutter({ dayDelta: -3 })).toBe("3d late");
      expect(agendaGutter({ dayDelta: -1 })).toBe("1d late");
      expect(agendaGutter({ dayDelta: 0 })).toBe("today");
      expect(agendaGutter({ dayDelta: 1 })).toBe("tomorrow");
      expect(agendaGutter({ dayDelta: 6 })).toBe("in 6d");
    });

    it("falls back to the date once relative wording stops helping", () => {
      expect(agendaGutter({ dayDelta: 30, deadlineDate: "2026-02-14" })).toBe("2026-02-14");
    });

    it("returns nothing rather than a wrong claim when the delta is missing", () => {
      expect(agendaGutter({})).toBe("");
      expect(agendaGutter({ dayDelta: null })).toBe("");
      expect(agendaGutter(null)).toBe("");
    });
  });

  describe("agendaStateLabel", () => {
    it("names each bucket", () => {
      expect(agendaStateLabel("overdue")).toBe("Overdue");
      expect(agendaStateLabel("today")).toBe("Due today");
      expect(agendaStateLabel("soon")).toBe("Next 7 days");
      expect(agendaStateLabel(undefined)).toBe("");
    });
  });

  describe("agendaSummary", () => {
    it("counts what is actually late, due, and waiting", () => {
      expect(
        agendaSummary({ overdue: [1, 2], dueToday: [3], flashcardsDue: 4 }),
      ).toBe("2 overdue · 1 due today · 4 cards to review.");
    });

    it("singularises a single card", () => {
      expect(agendaSummary({ flashcardsDue: 1 })).toBe("1 card to review.");
    });

    it("states the fact when there is nothing, instead of encouraging", () => {
      expect(agendaSummary({})).toBe("Nothing is due. Nothing is late.");
      expect(agendaSummary({ flashcardsDue: 0, overdue: [], dueToday: [] })).toBe(
        "Nothing is due. Nothing is late.",
      );
    });
  });

  it("buckets deadlines by local-date urgency", () => {
    const t = buildToday({ deadlines, today });
    expect(t.overdue.map((d) => d.id)).toEqual([1]);
    expect(t.dueToday.map((d) => d.id)).toEqual([2]);
    expect(t.soon.map((d) => d.id)).toEqual([3]); // #4 is "later", excluded
  });

  it("surfaces due flashcards and today's study minutes", () => {
    const t = buildToday({
      deadlines,
      reviewStats: { dueToday: 5 },
      sessionStats: { minutesToday: 40 },
      today,
    });
    expect(t.flashcardsDue).toBe(5);
    expect(t.studyMinutesToday).toBe(40);
    // attention = overdue(1) + today(1) + cards(5)
    expect(t.attentionCount).toBe(7);
    expect(t.caughtUp).toBe(false);
  });

  it("is 'caught up' when nothing overdue/today and no cards due", () => {
    const t = buildToday({
      deadlines: [{ id: 9, title: "Later", deadlineDate: "2026-03-01", category: "exam", subjectId: 1, subjectName: "X" }],
      reviewStats: { dueToday: 0 },
      sessionStats: { minutesToday: 0 },
      today,
    });
    expect(t.attentionCount).toBe(0);
    expect(t.caughtUp).toBe(true);
  });

  it("excludes completed deadlines from attention even if past-dated", () => {
    const t = buildToday({
      deadlines: [
        { id: 1, title: "Done Overdue", deadlineDate: "2026-01-10", category: "assignment", subjectId: 7, subjectName: "Maths", completedAt: "2026-01-16 09:00:00" },
        { id: 2, title: "Active Overdue", deadlineDate: "2026-01-10", category: "assignment", subjectId: 7, subjectName: "Maths", completedAt: null },
      ],
      today,
    });
    expect(t.overdue.map((d) => d.id)).toEqual([2]); // completed #1 excluded
    expect(t.attentionCount).toBe(1);
  });

  it("degrades gracefully when optional sources are missing", () => {
    const t = buildToday({ deadlines, today }); // no review/session stats
    expect(t.flashcardsDue).toBe(0);
    expect(t.studyMinutesToday).toBe(0);
    // Deadlines still bucket correctly.
    expect(t.overdue.length).toBe(1);
    expect(t.dueToday.length).toBe(1);
  });

  it("handles a completely empty dataset", () => {
    const t = buildToday({ today });
    expect(t).toMatchObject({ overdue: [], dueToday: [], soon: [], flashcardsDue: 0, studyMinutesToday: 0, caughtUp: true });
  });
});
