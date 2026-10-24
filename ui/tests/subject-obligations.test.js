import { describe, expect, it } from "vitest";
import {
  buildObligations,
  obligationHeadline,
  obligationTone,
  obligationsTotals,
} from "../src/features/subjects/subject-obligations.js";

const T = "2026-10-04";

// Builds a LOCAL YYYY-MM-DD string relative to the fixed base 2026-10-04.
//
// This deliberately does NOT use toISOString(): that converts to UTC first, so
// in any timezone behind UTC a "0 day offset" deadline serialises to the
// PREVIOUS day and the whole bucket model silently shifts. Progress Ledger's date
// semantics are local-calendar everywhere (today.js documents this), so the
// helper has to build local strings the same way.
const dl = (id, subjectId, offset, completedAt = null) => {
  const d = new Date(2026, 9, 4 + offset);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    id,
    subjectId,
    deadlineDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    completedAt,
  };
};

describe("subject obligations", () => {
  describe("buildObligations", () => {
    it("counts open deadlines against their own subject", () => {
      const by = buildObligations({
        today: T,
        deadlines: [dl(1, 5, -1), dl(2, 5, 0), dl(3, 6, 2)],
      });
      expect(by.get(5).open).toBe(2);
      expect(by.get(6).open).toBe(1);
    });

    it("does not count a completed deadline as an obligation", () => {
      const by = buildObligations({
        today: T,
        deadlines: [dl(1, 5, -3, "2026-10-01 09:00:00")],
      });
      // Finished work is not owed. Counting it would make a tidy subject look
      // like it still had a problem.
      expect(by.has(5)).toBe(false);
    });

    it("separates late from due-today from soon", () => {
      const by = buildObligations({
        today: T,
        deadlines: [dl(1, 5, -2), dl(2, 5, 0), dl(3, 5, 4)],
      });
      const e = by.get(5);
      expect(e.late).toBe(1);
      expect(e.dueToday).toBe(1);
      expect(e.soon).toBe(1);
      expect(e.open).toBe(3);
    });

    it("keeps a far-future deadline out of the headline but counts it as open", () => {
      const by = buildObligations({ today: T, deadlines: [dl(1, 5, 30)] });
      const e = by.get(5);
      expect(e.open).toBe(1);
      // It is owed, but it is not what the row should shout about.
      expect(e.nearest).toBeNull();
      expect(obligationHeadline(e)).toBe("");
    });

    it("records the most pressing dated item as nearest", () => {
      const by = buildObligations({
        today: T,
        deadlines: [dl(1, 5, -5), dl(2, 5, -1)],
      });
      expect(by.get(5).nearest).toBe(-1);
    });

    it("counts only dated cards, and only those actually due", () => {
      const by = buildObligations({
        today: T,
        cards: [
          { id: 1, subjectId: 5, dueDate: "2026-10-04" },
          { id: 2, subjectId: 5, dueDate: "2026-10-01" },
          { id: 3, subjectId: 5, dueDate: null },
          { id: 4, subjectId: 5, dueDate: "2026-11-30" },
        ],
      });
      // "Due" is a claim about a date. An undated card cannot honestly be
      // counted as due, and one due in November is not due this week.
      expect(by.get(5).cardsDue).toBe(2);
    });

    it("counts only unresolved mistakes", () => {
      const by = buildObligations({
        today: T,
        mistakes: [
          { id: 1, subjectId: 5, resolvedAt: null },
          { id: 2, subjectId: 5, resolvedAt: "2026-10-02 10:00:00" },
        ],
      });
      expect(by.get(5).mistakesOpen).toBe(1);
    });

    it("ignores rows with no subject rather than bucketing them", () => {
      const by = buildObligations({
        today: T,
        deadlines: [{ id: 1, subjectId: null, deadlineDate: "2026-10-04", completedAt: null }],
        cards: [{ id: 2, subjectId: undefined, dueDate: "2026-10-04" }],
      });
      expect(by.size).toBe(0);
    });

    it("degrades cleanly when every source is missing", () => {
      expect(buildObligations().size).toBe(0);
      expect(buildObligations({ today: T, deadlines: undefined, cards: undefined }).size).toBe(0);
    });

    it("tolerates null rows in each source", () => {
      const by = buildObligations({
        today: T,
        deadlines: [null, dl(1, 5, 0)],
        cards: [null, { id: 2, subjectId: 5, dueDate: "2026-10-04" }],
        mistakes: [null, undefined],
      });
      expect(by.get(5).open).toBe(1);
    });
  });

  describe("obligationHeadline", () => {
    it("states lateness first, because that is what the user would say", () => {
      expect(obligationHeadline({ late: 2, dueToday: 1, nearest: 0 })).toBe("2 late");
      expect(obligationHeadline({ late: 1, dueToday: 1, nearest: 0 })).toBe("1 late");
    });

    it("falls to due today, then to the nearest item", () => {
      expect(obligationHeadline({ late: 0, dueToday: 3, nearest: 0 })).toBe("3 due today");
      expect(obligationHeadline({ late: 0, dueToday: 0, nearest: 4 })).toBe("in 4d");
      expect(obligationHeadline({ late: 0, dueToday: 0, nearest: 0 })).toBe("today");
    });

    it("says nothing rather than inventing urgency", () => {
      expect(obligationHeadline({ late: 0, dueToday: 0, nearest: null, open: 0 })).toBe("");
      expect(obligationHeadline(null)).toBe("");
    });
  });

  describe("obligationTone", () => {
    it("escalates only on real lateness", () => {
      expect(obligationTone({ late: 1 })).toBe("bad");
      expect(obligationTone({ late: 0, dueToday: 1 })).toBe("warn");
      expect(obligationTone({ late: 0, dueToday: 0, open: 2 })).toBe("signal");
      expect(obligationTone({ late: 0, dueToday: 0, open: 0 })).toBe("quiet");
    });
  });

  describe("obligationsTotals", () => {
    it("sums across subjects without double counting", () => {
      const by = buildObligations({
        today: T,
        deadlines: [dl(1, 5, -1), dl(2, 5, 0), dl(3, 6, 0)],
      });
      expect(obligationsTotals(by)).toEqual({ open: 3, late: 1, dueToday: 2 });
    });

    it("is zero for an empty portfolio", () => {
      expect(obligationsTotals(buildObligations({ today: T }))).toEqual({
        open: 0, late: 0, dueToday: 0,
      });
    });
  });
});