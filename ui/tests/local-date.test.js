import { describe, it, expect } from "vitest";
import {
  todayLocalISO,
  toLocalTimestamp,
  formatTimestamp,
  timeAgo,
} from "../src/shared/utils/local-date.js";

describe("local-date helpers", () => {
  it("todayLocalISO uses the LOCAL calendar, never UTC", () => {
    // 2026-08-24 00:30 local = 2026-08-23 19:00 UTC → local date must win.
    const d = new Date(2026, 7, 24, 0, 30, 0);
    expect(todayLocalISO(d)).toBe("2026-08-24");
  });

  it("toLocalTimestamp emits SQLite-friendly local 'YYYY-MM-DD HH:MM:SS'", () => {
    const d = new Date(2026, 7, 24, 23, 45, 5);
    const ts = toLocalTimestamp(d);
    expect(ts).toBe("2026-08-24 23:45:05");
    expect(ts).not.toContain("T");
    expect(ts).not.toContain("Z");
  });
});

// Vault metadata, backup manifests and settings files are plain JSON on the
// user's own disk — the one place a timestamp can be missing, truncated, or
// hand-edited. `Intl.DateTimeFormat.format(new Date(bad))` throws a RangeError,
// and that throw happens during render, so an unreadable value used to blank
// the entire surface instead of one row.
describe("formatTimestamp", () => {
  it("formats a real timestamp", () => {
    // Default style is compact (month + day + time) — the vault row already
    // carries context, so a year is noise except in the explicit long style.
    const out = formatTimestamp("2026-09-20T09:00:00.000Z");
    expect(out).toMatch(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
    expect(formatTimestamp("2026-09-20T09:00:00.000Z", {
      style: { year: "numeric", month: "short", day: "numeric" },
    })).toMatch(/2026/);
  });

  it("uses the fallback for nullish and empty values", () => {
    expect(formatTimestamp(null, { fallback: "Never" })).toBe("Never");
    expect(formatTimestamp(undefined, { fallback: "Never" })).toBe("Never");
    expect(formatTimestamp("", { fallback: "Never" })).toBe("Never");
    expect(formatTimestamp(null)).toBe("—");
  });

  it("never throws on junk, and never hides a diagnosable value", () => {
    // Every one of these previously threw during render.
    for (const junk of [
      "not-a-date",
      "2026-13-45T99:99:99Z",
      { at: 1 },
      () => {},
      NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => formatTimestamp(junk)).not.toThrow();
    }
    // A non-empty string we cannot parse is shown verbatim rather than dropped.
    expect(formatTimestamp("2026-13-45T99:99:99Z")).toBe("2026-13-45T99:99:99Z");
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    // Non-string junk has nothing worth echoing, so it states the fact instead.
    expect(formatTimestamp({ at: 1 })).toBe("Unknown");
    expect(formatTimestamp(() => {})).toBe("Unknown");
    expect(formatTimestamp(NaN)).toBe("Unknown");
  });

  it("accepts epoch numbers and Date instances", () => {
    const epoch = Date.parse("2026-09-20T09:00:00.000Z");
    expect(formatTimestamp(epoch)).toBe(formatTimestamp("2026-09-20T09:00:00.000Z"));
    expect(formatTimestamp(new Date(epoch))).toBe(formatTimestamp(epoch));
    // Epoch 0 is a real instant; falsy-check bugs must not swallow it.
    expect(formatTimestamp(0)).toMatch(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
  });
});

describe("timeAgo", () => {
  // One shared clock so the boundaries are exact rather than approximate.
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const at = (secondsAgo) => timeAgo(now - secondsAgo * 1000, { now });

  it("steps through just now → minutes → hours → days", () => {
    expect(at(0)).toBe("just now");
    expect(at(59)).toBe("just now");
    expect(at(60)).toBe("1m ago");
    expect(at(3599)).toBe("59m ago");
    expect(at(3600)).toBe("1h ago");
    expect(at(86399)).toBe("23h ago");
    expect(at(86400)).toBe("1d ago");
    expect(at(6 * 86400)).toBe("6d ago");
  });

  it("falls back to a date beyond a week, and never returns a raw timestamp", () => {
    const label = at(30 * 86400);
    expect(label).not.toContain("ago");
    expect(label).toBe(new Date(now - 30 * 86400 * 1000).toLocaleDateString());
  });

  it("returns null for anything unreadable so callers choose their placeholder", () => {
    // The six copy-pasted versions disagreed here (some printed "Invalid Date",
    // some printed an empty string) — null forces one decision per surface.
    for (const junk of [null, undefined, "", "not-a-date", {}, NaN]) {
      expect(timeAgo(junk, { now })).toBeNull();
    }
  });

  it("parses the local 'YYYY-MM-DD HH:MM:SS' storage form as LOCAL time", () => {
    // A stored row at 11:30 local, read at 12:00 local, is 30 minutes old —
    // not 5.5 hours (UTC interpretation) and not 30 minutes forward.
    const local = new Date(2026, 8, 21, 11, 30, 0);
    const label = timeAgo(toLocalTimestamp(local), { now: local.getTime() + 30 * 60 * 1000 });
    expect(label).toBe("30m ago");
  });

  it("never reports a future instant as negative", () => {
    expect(at(-3600)).toBe("just now");
  });
});
