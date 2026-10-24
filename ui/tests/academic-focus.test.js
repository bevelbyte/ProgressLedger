/**
 * Academic Focus — pure function tests.
 *
 * The full Phase 3 test gate:
 *   - no data -> empty
 *   - overdue deadline
 *   - deadline today
 *   - deadline soon
 *   - multiple deadlines
 *   - inactive subject
 *   - recent study reduces inactivity signal
 *   - flashcards due
 *   - multiple simultaneous signals
 *   - deterministic ordering
 *   - missing subject references
 *   - profile isolation (different subjects; no cross-contamination)
 *   - completed deadlines ignored
 *   - future deadlines handled correctly
 *   - duplicate signals don't inflate score incorrectly
 *   - the EXACT explanation text is pinned
 *
 * Pure: no IPC, no Svelte, no Date.now. All inputs are plain objects.
 */
import { describe, it, expect } from "vitest";
import { buildAcademicFocus, __internals } from "../src/features/dashboard/academic-focus.js";
import { localDayString } from "../src/features/dashboard/today.js";

const TODAY = "2026-02-10"; // fixed so day deltas are stable across runs/timezones

// --- Test fixtures ---------------------------------------------------------

function makeSubject(id, name, status = "pending") {
  return { id, name, code: null, status };
}

function makeDeadline(id, subjectId, date, title = "D", opts = {}) {
  return {
    id,
    subjectId,
    subjectName: nameFor(subjectId),
    deadlineDate: date,
    category: opts.category || "exam",
    title,
    notes: "",
    createdAt: "2026-01-01 10:00:00",
    completedAt: opts.completedAt || null,
  };
}

function makeSession(subjectId, date, duration = 30) {
  return {
    id: 1,
    subjectId,
    subjectName: nameFor(subjectId),
    startedAt: date,
    endedAt: null,
    durationMinutes: duration,
    notes: "",
  };
}

function makeCard(subjectId, dueDate) {
  return {
    id: 1,
    subjectId,
    subjectName: nameFor(subjectId),
    front: "f",
    back: "b",
    easeFactor: 2.5,
    interval: 0,
    repetitions: 0,
    dueDate,
    createdAt: "2026-01-01 10:00:00",
    lastReviewed: null,
  };
}

function makeMistake(subjectId, createdAt) {
  return {
    id: 1,
    subjectId,
    subjectName: nameFor(subjectId),
    questionText: "q",
    mistakeType: "conceptual",
    correctApproach: "a",
    tags: "[]",
    createdAt,
  };
}

function nameFor(id) {
  return SUBJECTS[id] || `Subject ${id}`;
}

const SUBJECTS = {
  1: "Algorithms",
  2: "DBMS",
  3: "OS",
  4: "Networks",
};

// =====================================================================
// Phase 3 — test gate
// =====================================================================

describe("buildAcademicFocus — empty / no-data", () => {
  it("returns empty with honest message when no inputs are provided", () => {
    const out = buildAcademicFocus({ today: TODAY });
    expect(out.empty).toBe(true);
    expect(out.items).toEqual([]);
    expect(out.message).toBe("Nothing urgent. Your current workload is under control.");
  });

  it("returns empty when subjects exist but have no signals", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms"), makeSubject(2, "DBMS")],
    });
    expect(out.empty).toBe(true);
  });

  it("returns empty when only done subjects exist", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms", "done")],
      deadlines: [makeDeadline(99, 1, "2026-02-09")], // overdue but on a done subject
    });
    expect(out.empty).toBe(true);
  });
});

describe("buildAcademicFocus — single signal types", () => {
  it("scores overdue deadline highest", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-05", "Big-O review")],
    });
    expect(out.empty).toBe(false);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].subjectId).toBe(1);
    expect(out.items[0].signals.map((s) => s.kind)).toEqual(["overdue_deadline"]);
    expect(out.items[0].reason).toBe("1 deadline 5d overdue");
    expect(out.items[0].score).toBe(__internals.POINTS.overdueDeadline);
  });

  it("scores deadline today below overdue but above soon", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-10", "Quiz")],
    });
    expect(out.items[0].signals[0].kind).toBe("deadline_today");
    expect(out.items[0].reason).toBe("1 deadline today");
    expect(out.items[0].score).toBe(__internals.POINTS.deadlineToday);
  });

  it("scores deadline in 2 days with the 1..=3 window", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-12", "Lab")],
    });
    expect(out.items[0].signals[0].kind).toBe("deadline_within_3_days");
    expect(out.items[0].reason).toBe("1 deadline in 2d");
    expect(out.items[0].score).toBe(__internals.POINTS.deadlineSoon3);
  });

  it("scores deadline in 5 days with the 4..=7 window", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-15", "Quiz")],
    });
    expect(out.items[0].signals[0].kind).toBe("deadline_within_7_days");
    expect(out.items[0].reason).toBe("1 deadline this week");
    expect(out.items[0].score).toBe(__internals.POINTS.deadlineSoon7);
  });

  it("scores deadline 9 days out (later) softly", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-19", "Midterm")],
    });
    expect(out.items[0].signals[0].kind).toBe("deadline_within_14_days");
    expect(out.items[0].reason).toBe("1 deadline in 9d");
    expect(out.items[0].score).toBe(__internals.POINTS.deadlineLater);
  });

  it("ignores deadlines > 14 days out", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-03-30", "Final")],
    });
    expect(out.empty).toBe(true);
  });

  it("scores cards due", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      cards: [makeCard(1, "2026-02-10"), makeCard(1, "2026-02-09")],
    });
    expect(out.items[0].signals[0].kind).toBe("cards_due");
    expect(out.items[0].signals[0].count).toBe(2);
    expect(out.items[0].reason).toBe("2 flashcards due");
    expect(out.items[0].score).toBe(__internals.POINTS.cardsDue);
    expect(out.items[0].actions).toContain("openRecall");
  });

  it("ignores cards due after today (future), and treats today as due", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      cards: [
        makeCard(1, "2026-02-11"), // future
        makeCard(1, "2026-02-10"), // today
        makeCard(1, "2026-02-09"), // overdue
      ],
    });
    expect(out.items[0].signals[0].count).toBe(2);
  });

  it("scores recent mistakes (low bucket)", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      mistakes: [makeMistake(1, "2026-02-09 12:00:00")],
    });
    expect(out.items[0].signals[0].kind).toBe("recent_mistakes");
    expect(out.items[0].reason).toBe("1 recent mistake");
    expect(out.items[0].score).toBe(__internals.POINTS.recentMistakesLow);
  });

  it("scores recent mistakes (high bucket) and supersedes low", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      mistakes: [
        makeMistake(1, "2026-02-08 12:00:00"),
        makeMistake(1, "2026-02-09 12:00:00"),
        makeMistake(1, "2026-02-10 12:00:00"),
      ],
    });
    // Exactly ONE mistake signal — high, not low.
    expect(out.items[0].signals.filter((s) => s.kind.startsWith("recent_mistakes"))).toHaveLength(1);
    expect(out.items[0].signals[0].kind).toBe("recent_mistakes_high");
    expect(out.items[0].score).toBe(__internals.POINTS.recentMistakesHigh);
    expect(out.items[0].reason).toBe("3 recent mistakes");
  });

  it("ignores mistakes older than the recent window", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      mistakes: [makeMistake(1, "2025-12-01 12:00:00")], // ~2 months old
    });
    expect(out.empty).toBe(true);
  });

  it("ignores mistakes with future timestamps (clock skew safety)", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      mistakes: [makeMistake(1, "2026-02-11 12:00:00")],
    });
    expect(out.empty).toBe(true);
  });
});

describe("buildAcademicFocus — completed deadlines", () => {
  it("does not surface a completed deadline", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [
        makeDeadline(1, 1, "2026-02-05", "Old", { completedAt: "2026-02-06 10:00:00" }),
      ],
    });
    expect(out.empty).toBe(true);
  });

  it("ignores a completed deadline but still uses other active deadlines", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [
        makeDeadline(1, 1, "2026-02-05", "Done", { completedAt: "2026-02-06 10:00:00" }),
        makeDeadline(2, 1, "2026-02-11", "Active"),
      ],
    });
    expect(out.items[0].signals[0].kind).toBe("deadline_within_3_days");
    expect(out.items[0].score).toBe(__internals.POINTS.deadlineSoon3);
  });
});

describe("buildAcademicFocus — study inactivity", () => {
  it("does not flag inactivity on a brand-new profile (no sessions ever)", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
    });
    expect(out.empty).toBe(true);
  });

  it("flags a subject inactive for 10 days (default 7-day threshold)", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      sessions: [
        // 10 days ago: a session on a DIFFERENT subject establishes "has
        // any session", so the inactivity signal is meaningful.
        makeSession(2, "2026-01-31 10:00:00"),
        // 12 days ago: this subject's last activity.
        makeSession(1, "2026-01-29 10:00:00"),
      ],
    });
    expect(out.items[0].signals[0].kind).toBe("study_inactive");
    expect(out.items[0].signals[0].days).toBe(12);
    expect(out.items[0].reason).toBe("no study in 12d");
    expect(out.items[0].score).toBe(__internals.POINTS.studyInactive);
  });

  it("does NOT flag a subject with a session today as inactive", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      sessions: [makeSession(1, "2026-02-10 09:00:00")],
    });
    expect(out.empty).toBe(true);
  });

  it("does NOT flag a subject with a session 5 days ago as inactive", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      sessions: [makeSession(1, "2026-02-05 09:00:00")],
    });
    expect(out.empty).toBe(true);
  });
});

describe("buildAcademicFocus — multiple deadlines and subject ordering", () => {
  it("orders by score desc — overdue > today > soon > later", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [
        makeSubject(1, "Algorithms"),
        makeSubject(2, "DBMS"),
        makeSubject(3, "OS"),
        makeSubject(4, "Networks"),
      ],
      deadlines: [
        makeDeadline(10, 4, "2026-02-19", "Later"),     // score 4
        makeDeadline(11, 3, "2026-02-12", "Soon3"),     // score 30
        makeDeadline(12, 2, "2026-02-10", "Today"),     // score 60
        makeDeadline(13, 1, "2026-02-03", "Overdue"),   // score 100
      ],
    });
    expect(out.items.map((i) => i.subjectId)).toEqual([1, 2, 3, 4]);
  });

  it("orders subjects with the same score by earliest deadline asc", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms"), makeSubject(2, "DBMS")],
      deadlines: [
        makeDeadline(10, 2, "2026-02-08", "DBMS-old"),   // -2 days, earlier date
        makeDeadline(11, 1, "2026-02-09", "Algo-old"),   // -1 day
      ],
    });
    // Same score (both overdue). Earliest date first -> subject 2 (-2d < -1d).
    expect(out.items[0].subjectId).toBe(2);
    expect(out.items[1].subjectId).toBe(1);
  });

  it("tie-breaks by subjectId asc when no deadlines are present", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms"), makeSubject(2, "DBMS")],
      cards: [makeCard(1, "2026-02-10"), makeCard(2, "2026-02-10")],
    });
    expect(out.items[0].subjectId).toBe(1);
    expect(out.items[1].subjectId).toBe(2);
  });
});

describe("buildAcademicFocus — deterministic", () => {
  it("is byte-identical across repeated calls with the same input", () => {
    const input = {
      today: TODAY,
      subjects: [
        makeSubject(1, "Algorithms"),
        makeSubject(2, "DBMS"),
        makeSubject(3, "OS"),
      ],
      deadlines: [
        makeDeadline(1, 1, "2026-02-09", "Quiz"),
        makeDeadline(2, 2, "2026-02-10", "Lab"),
      ],
      sessions: [makeSession(3, "2026-01-25 10:00:00")],
      cards: [makeCard(2, "2026-02-10")],
    };
    const a = buildAcademicFocus(input);
    const b = buildAcademicFocus(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is deterministic even when input field order is shuffled", () => {
    const a = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-09", "Quiz")],
      sessions: [],
      cards: [],
      mistakes: [],
    });
    const b = buildAcademicFocus({
      today: TODAY,
      mistakes: [],
      cards: [],
      sessions: [],
      deadlines: [makeDeadline(1, 1, "2026-02-09", "Quiz")],
      subjects: [makeSubject(1, "Algorithms")],
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildAcademicFocus — multiple simultaneous signals", () => {
  it("combines overdue + cards due and lists both signals", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-05", "Exam")],
      cards: [makeCard(1, "2026-02-10"), makeCard(1, "2026-02-09")],
    });
    const kinds = out.items[0].signals.map((s) => s.kind).sort();
    expect(kinds).toEqual(["cards_due", "overdue_deadline"]);
    // Score is the sum, no per-subject cap needed at this small magnitude.
    expect(out.items[0].score).toBe(
      __internals.POINTS.overdueDeadline + __internals.POINTS.cardsDue
    );
    expect(out.items[0].actions).toContain("openSubject");
    expect(out.items[0].actions).toContain("openRecall");
  });

  it("duplicate signals do not double-count the deadline bucket", () => {
    // Two overdue deadlines for the same subject should produce ONE
    // overdue_deadline signal (count: 2), not two separate signals.
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [
        makeDeadline(1, 1, "2026-02-05", "Quiz 1"),
        makeDeadline(2, 1, "2026-02-07", "Quiz 2"),
      ],
    });
    const overdue = out.items[0].signals.filter((s) => s.kind === "overdue_deadline");
    expect(overdue).toHaveLength(1);
    expect(overdue[0].count).toBe(2);
    // The reason mentions the plural, not the count twice.
    expect(out.items[0].reason).toBe("2 deadlines overdue");
  });

  it("limits the reason string to two phrases (no multi-clause noise)", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-05", "Quiz")],
      cards: [makeCard(1, "2026-02-10")],
      mistakes: [makeMistake(1, "2026-02-08 12:00:00")],
      sessions: [makeSession(1, "2025-12-01 10:00:00")], // very stale
    });
    // Up to two "·" separated phrases -> at most one "·" character.
    const parts = out.items[0].reason.split(" · ");
    expect(parts.length).toBeLessThanOrEqual(2);
  });
});

describe("buildAcademicFocus — missing subject references and isolation", () => {
  it("ignores deadlines/cards/mistakes that point to subjects not in the subject list", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 999, "2026-02-05", "Ghost")], // subject 999 not in list
      cards: [makeCard(999, "2026-02-10")],
      mistakes: [makeMistake(999, "2026-02-09 12:00:00")],
    });
    expect(out.empty).toBe(true);
  });

  it("profile isolation: profile A's signals do not influence profile B's recommendation", () => {
    // Two independent "profiles" are simulated as two disjoint subject
    // universes, since the algorithm is profile-agnostic by design.
    const profileA = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-05", "Critical")],
    });
    const profileB = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(2, "DBMS")],
      // DBMS has nothing on its own, but the deadlines/sessions list
      // contains noise from profile A's domain. None of it should leak
      // because they reference subjectId 1, which is not in profile B's
      // subject list.
      deadlines: [makeDeadline(1, 1, "2026-02-05", "Critical")],
      sessions: [makeSession(1, "2026-01-30 10:00:00")],
    });
    expect(profileA.items).toHaveLength(1);
    expect(profileA.items[0].subjectId).toBe(1);
    expect(profileB.empty).toBe(true);
  });

  it("filters out subjects with status done even when they have urgent deadlines", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms", "done")],
      deadlines: [makeDeadline(1, 1, "2026-02-05", "Old")],
    });
    expect(out.empty).toBe(true);
  });
});

describe("buildAcademicFocus — multi-deadline phrasing", () => {
  it("overdue plural uses 'N deadlines overdue'", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [
        makeDeadline(1, 1, "2026-02-05", "Q1"),
        makeDeadline(2, 1, "2026-02-06", "Q2"),
      ],
    });
    expect(out.items[0].reason).toBe("2 deadlines overdue");
  });

  it("deadline tomorrow uses 'deadline tomorrow'", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-11", "Quiz")],
    });
    expect(out.items[0].reason).toBe("1 deadline tomorrow");
  });

  it("deadline 3 days out uses 'in 3d' phrasing", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      deadlines: [makeDeadline(1, 1, "2026-02-13", "Quiz")],
    });
    expect(out.items[0].reason).toBe("1 deadline in 3d");
  });
});

describe("buildAcademicFocus — cap behaviour", () => {
  it("respects maxResults", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [
        makeSubject(1, "A1"),
        makeSubject(2, "A2"),
        makeSubject(3, "A3"),
        makeSubject(4, "A4"),
        makeSubject(5, "A5"),
      ],
      deadlines: [
        makeDeadline(1, 1, "2026-02-05"),
        makeDeadline(2, 2, "2026-02-06"),
        makeDeadline(3, 3, "2026-02-07"),
        makeDeadline(4, 4, "2026-02-08"),
        makeDeadline(5, 5, "2026-02-09"),
      ],
      options: { maxResults: 3 },
    });
    expect(out.items).toHaveLength(3);
    expect(out.message).toBe("3 subjects need attention.");
  });

  it("maxResults=1 is the lower clamp", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "A1"), makeSubject(2, "A2")],
      deadlines: [makeDeadline(1, 1, "2026-02-05"), makeDeadline(2, 2, "2026-02-06")],
      options: { maxResults: 0 },
    });
    expect(out.items).toHaveLength(1);
  });
});

describe("buildAcademicFocus — exact text pins", () => {
  it("the canonical 'nothing urgent' message is exactly pinned", () => {
    expect(
      buildAcademicFocus({ today: TODAY }).message
    ).toBe("Nothing urgent. Your current workload is under control.");
  });

  it("subject with only study inactivity emits 'no study in Nd' reason", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      sessions: [makeSession(1, "2026-01-29 10:00:00")], // 12 days ago
    });
    expect(out.items[0].reason).toBe("no study in 12d");
  });

  it("subject with only one recent mistake emits '1 recent mistake' (singular)", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      mistakes: [makeMistake(1, "2026-02-09 12:00:00")],
    });
    expect(out.items[0].reason).toBe("1 recent mistake");
  });

  it("subject with only one card due emits '1 flashcard due' (singular)", () => {
    const out = buildAcademicFocus({
      today: TODAY,
      subjects: [makeSubject(1, "Algorithms")],
      cards: [makeCard(1, "2026-02-10")],
    });
    expect(out.items[0].reason).toBe("1 flashcard due");
  });
});

describe("buildAcademicFocus — performance", () => {
  // Phase 6: the algorithm must be cheap. The Rust aggregator caps rows
  // at 500 deadlines / 500 sessions / 500 cards / 200 mistakes per read.
  // We measure the algorithm at the cap so any quadratic regression shows
  // up here before it reaches a user.
  it("stays under 50ms at 50 subjects with 500 deadlines, 500 sessions, 500 cards, 200 mistakes", () => {
    const subjects = [];
    for (let i = 1; i <= 50; i++) subjects.push(makeSubject(i, `Subject-${i}`));
    const deadlines = [];
    for (let i = 0; i < 500; i++) {
      const subjId = (i % 50) + 1;
      const dayOff = (i % 30) - 15; // -15..+14
      const date = `2026-02-${String(10 + dayOff).padStart(2, "0")}`;
      deadlines.push(makeDeadline(i, subjId, date, `D-${i}`));
    }
    const sessions = [];
    for (let i = 0; i < 500; i++) {
      const subjId = (i % 50) + 1;
      const dayOff = i % 30;
      const d = `2026-0${String(1 + (dayOff % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`;
      sessions.push(makeSession(subjId, `${d} 10:00:00`));
    }
    const cards = [];
    for (let i = 0; i < 500; i++) {
      const subjId = (i % 50) + 1;
      cards.push(makeCard(subjId, "2026-02-10"));
    }
    const mistakes = [];
    for (let i = 0; i < 200; i++) {
      const subjId = (i % 50) + 1;
      mistakes.push(makeMistake(subjId, "2026-02-09 10:00:00"));
    }
    // Warm up.
    buildAcademicFocus({ today: TODAY, subjects, deadlines, sessions, cards, mistakes });
    const samples = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      const out = buildAcademicFocus({ today: TODAY, subjects, deadlines, sessions, cards, mistakes });
      samples.push(performance.now() - t0);
      expect(out.items.length).toBeLessThanOrEqual(4); // maxResults default
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];
    // eslint-disable-next-line no-console
    console.log(`buildAcademicFocus median over 5 runs at scale: ${median.toFixed(2)} ms (samples ${samples.map((s) => s.toFixed(2)).join(", ")} ms)`);
    expect(median).toBeLessThan(50);
  });
});

describe("buildAcademicFocus — profile isolation (Phase 7)", () => {
  // The algorithm is profile-agnostic: the calling code supplies ONLY the
  // profile's own data. The contract test here exercises a property the
  // SQL boundary already enforces: even if a hostile caller hands the
  // algorithm rows from BOTH profiles, the recommendation set is still
  // computed correctly from the data given. The two profile "worlds" must
  // be independent when run in parallel against the same algorithm.

  it("two profiles with overlapping subjectIds produce independent lists", () => {
    // Same subjectId numeric values appear in both profiles. The
    // algorithm is given the profile's subject list as the authoritative
    // set; an entry that references subjectId 7 in profile A's world
    // does not magically transfer to profile B even if B's deadline list
    // accidentally contains a row with subjectId 7 (which the SQL
    // boundary forbids but the test simulates the worst case).
    const subjectListA = [makeSubject(1, "A-Algos"), makeSubject(2, "A-DBMS")];
    const subjectListB = [makeSubject(10, "B-Algos")];
    const deadlinesA = [
      makeDeadline(1, 1, "2026-02-05", "A1"),
      makeDeadline(2, 2, "2026-02-06", "A2"),
      // Hostile cross-profile row — algorithm must ignore because
      // subjectId 10 is not in subjectListA.
      makeDeadline(3, 10, "2026-02-07", "Ghost"),
    ];
    const deadlinesB = [
      makeDeadline(1, 10, "2026-02-05", "B1"),
      // Hostile cross-profile row — algorithm must ignore because
      // subjectId 1 is not in subjectListB.
      makeDeadline(2, 1, "2026-02-06", "Ghost"),
    ];
    const outA = buildAcademicFocus({ today: TODAY, subjects: subjectListA, deadlines: deadlinesA });
    const outB = buildAcademicFocus({ today: TODAY, subjects: subjectListB, deadlines: deadlinesB });
    const aIds = outA.items.map((i) => i.subjectId).sort();
    const bIds = outB.items.map((i) => i.subjectId).sort();
    expect(aIds).toEqual([1, 2]);
    expect(bIds).toEqual([10]);
    // And the reasons reflect only the in-profile data.
    expect(outA.items.find((i) => i.subjectId === 1).reason).toBe("1 deadline 5d overdue");
    expect(outA.items.find((i) => i.subjectId === 2).reason).toBe("1 deadline 4d overdue");
    expect(outB.items[0].reason).toBe("1 deadline 5d overdue");
  });

  it("completing all of profile A's deadlines does not affect profile B's list", () => {
    // Even if the calling code never updates its cache (a bug a future
    // refactor could introduce), the algorithm will exclude completed
    // deadlines regardless of which profile they "belong to".
    const subjectListA = [makeSubject(1, "A")];
    const subjectListB = [makeSubject(1, "B")];
    const completedA = [
      makeDeadline(1, 1, "2026-02-05", "Done", { completedAt: "2026-02-06 10:00:00" }),
    ];
    const activeB = [makeDeadline(1, 1, "2026-02-05", "Active")];
    const outA = buildAcademicFocus({
      today: TODAY,
      subjects: subjectListA,
      deadlines: completedA,
    });
    const outB = buildAcademicFocus({
      today: TODAY,
      subjects: subjectListB,
      deadlines: activeB,
    });
    expect(outA.empty).toBe(true);
    expect(outB.items[0].reason).toBe("1 deadline 5d overdue");
  });

  it("re-running the algorithm for the same profile is byte-identical (no hidden state)", () => {
    const input = {
      today: TODAY,
      subjects: [makeSubject(1, "X"), makeSubject(2, "Y")],
      deadlines: [
        makeDeadline(1, 1, "2026-02-05", "a"),
        makeDeadline(2, 2, "2026-02-10", "b"),
      ],
      sessions: [makeSession(1, "2026-01-25 10:00:00")],
      cards: [makeCard(2, "2026-02-10")],
      mistakes: [makeMistake(1, "2026-02-08 10:00:00")],
    };
    const a = buildAcademicFocus(input);
    const b = buildAcademicFocus(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
