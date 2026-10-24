import { describe, expect, it } from "vitest";
import { buildWeekLoad, loadTone, weekDays, localDay } from "../src/features/dashboard/week-load.js";

describe("week-load", () => {
  describe("weekDays", () => {
    it("always opens on today and spans seven days", () => {
      const days = weekDays("2026-10-04");
      expect(days).toHaveLength(7);
      expect(days[0].date).toBe("2026-10-04");
      expect(days[6].date).toBe("2026-10-10");
    });

    it("labels the first column TODAY and the rest by weekday", () => {
      const days = weekDays("2026-10-04"); // a Sunday
      expect(days[0].label).toBe("TODAY");
      expect(days.map((d) => d.offset)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it("crosses a month boundary without skipping a day", () => {
      const days = weekDays("2026-10-30");
      expect(days.map((d) => d.date)).toEqual([
        "2026-10-30",
        "2026-10-31",
        "2026-11-01",
        "2026-11-02",
        "2026-11-03",
        "2026-11-04",
        "2026-11-05",
      ]);
    });
  });

  describe("loadTone", () => {
    it("buckets by open-item count", () => {
      expect(loadTone(0)).toBe("clean");
      expect(loadTone(1)).toBe("light");
      expect(loadTone(2)).toBe("full");
      expect(loadTone(3)).toBe("full");
      expect(loadTone(4)).toBe("heavy");
      expect(loadTone(9)).toBe("heavy");
    });
  });

  describe("buildWeekLoad", () => {
    it("reports an empty window as clear, with no NaN bar heights", () => {
      const week = buildWeekLoad({ deadlines: [], todayStr: "2026-10-04" });
      expect(week.isClear).toBe(true);
      expect(week.total).toBe(0);
      expect(week.peak).toBe(0);
      // The divide-by-zero guard: every pct must be a real number, or the
      // style attribute renders as `height: NaN%` and the bars collapse.
      for (const c of week.columns) {
        expect(Number.isFinite(c.pct)).toBe(true);
        expect(c.pct).toBe(0);
      }
    });

    it("counts only OPEN items against a day", () => {
      const week = buildWeekLoad({
        todayStr: "2026-10-04",
        deadlines: [
          { id: 1, deadlineDate: "2026-10-04", completedAt: null },
          { id: 2, deadlineDate: "2026-10-04", completedAt: "2026-10-03 10:00:00" },
          { id: 3, deadlineDate: "2026-10-04", completedAt: null },
        ],
      });
      // Two open, one already finished -- a completed item is work the user
      // did, and counting it would make a finished week look heavy.
      expect(week.columns[0].count).toBe(2);
      expect(week.total).toBe(2);
    });

    it("ignores items dated outside the window instead of clamping them", () => {
      const week = buildWeekLoad({
        todayStr: "2026-10-04",
        deadlines: [
          { id: 1, deadlineDate: "2026-10-03", completedAt: null }, // before
          { id: 2, deadlineDate: "2026-10-11", completedAt: null }, // after
        ],
      });
      // Clamping would claim these belong to the first/last column, which is
      // false. They simply are not this week's load.
      expect(week.total).toBe(0);
      expect(week.columns.every((c) => c.count === 0)).toBe(true);
    });

    it("scales bar heights against the busiest day in the window", () => {
      const week = buildWeekLoad({
        todayStr: "2026-10-04",
        deadlines: [
          { id: 1, deadlineDate: "2026-10-04", completedAt: null },
          { id: 2, deadlineDate: "2026-10-05", completedAt: null },
          { id: 3, deadlineDate: "2026-10-05", completedAt: null },
          { id: 4, deadlineDate: "2026-10-05", completedAt: null },
          { id: 5, deadlineDate: "2026-10-05", completedAt: null },
        ],
      });
      expect(week.peak).toBe(4);
      expect(week.columns[0].pct).toBe(25);
      expect(week.columns[1].pct).toBe(100);
      expect(week.columns[1].tone).toBe("heavy");
      expect(week.columns[0].tone).toBe("light");
    });

    it("keeps a lone item visible on an otherwise empty week", () => {
      const week = buildWeekLoad({
        todayStr: "2026-10-04",
        deadlines: [{ id: 1, deadlineDate: "2026-10-07", completedAt: null }],
      });
      const solo = week.columns[3];
      expect(solo.count).toBe(1);
      // A 1/1 ratio is 100%, but the floor also covers a 1-in-8 case so a
      // single item is never a 2px sliver.
      expect(solo.pct).toBeGreaterThanOrEqual(8);
    });

    it("skips undated rows rather than filing them on today", () => {
      const week = buildWeekLoad({
        todayStr: "2026-10-04",
        deadlines: [
          { id: 1, deadlineDate: null, completedAt: null },
          { id: 2, deadlineDate: undefined, completedAt: null },
        ],
      });
      expect(week.total).toBe(0);
    });

    it("tolerates null rows in the deadline list", () => {
      const week = buildWeekLoad({
        todayStr: "2026-10-04",
        deadlines: [null, undefined, { id: 1, deadlineDate: "2026-10-04" }],
      });
      expect(week.total).toBe(1);
    });
  });

  describe("localDay", () => {
    it("formats a Date as a local YYYY-MM-DD string", () => {
      expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
    });
  });
});