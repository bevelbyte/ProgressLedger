import { render, screen, waitFor, cleanup } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import SubjectList from "../src/features/subjects/components/SubjectList.svelte";
import { subjectStore } from "../src/features/subjects/stores/subject.svelte.js";

// Local YYYY-MM-DD relative to now. CareerFlow's date semantics are
// local-calendar (see today.js), so this builds local strings -- never
// toISOString(), which would shift the day in any timezone behind UTC.
const localDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const deadline = (id, subjectId, offset, completedAt = null) => ({
  id,
  subjectId,
  deadlineDate: localDay(offset),
  completedAt,
});

const subject = (id, name, extra = {}) => ({
  id,
  name,
  code: `S${id}`,
  status: "pending",
  trackName: "B.Tech",
  ...extra,
});

/**
 * The obligation sources are stubbed explicitly rather than through a permissive
 * proxy, so a call the component is NOT supposed to make fails loudly instead of
 * resolving to undefined and quietly yielding a zero strip.
 */
function stubCareerflow({ deadlines = [], cards = [], mistakes = [], fail = [] } = {}) {
  window.careerflow = {
    deadlines: {
      list: fail.includes("deadlines")
        ? async () => { throw new Error("deadline source down"); }
        : async () => deadlines,
    },
    cards: {
      all: fail.includes("cards")
        ? async () => { throw new Error("card source down"); }
        : async () => cards,
    },
    mistakes: {
      list: fail.includes("mistakes")
        ? async () => { throw new Error("mistake source down"); }
        : async () => mistakes,
    },
  };
}

const metric = (label) =>
  [...document.querySelectorAll(".atl-metric")].find(
    (m) => m.querySelector(".atl-metric-label")?.textContent.trim() === label,
  )?.querySelector(".atl-metric-value")?.textContent.trim();

describe("SubjectList owed-here band", () => {
  beforeEach(() => {
    localStorage.clear();
    subjectStore.tree = [];
    subjectStore.allSubjects = [subject(5, "Operating Systems"), subject(6, "Discrete Maths")];
    subjectStore.lastStudiedAt = {};
    stubCareerflow();
  });

  afterEach(() => {
    cleanup();
    delete window.careerflow;
  });

  it("leads with real counts, not an inventory", async () => {
    stubCareerflow({
      deadlines: [deadline(1, 5, -2), deadline(2, 5, 0), deadline(3, 6, 3)],
    });
    render(SubjectList, { props: { profileId: 7 } });

    await waitFor(() => expect(metric("Open")).toBe("3"));
    expect(metric("Late")).toBe("1");
    expect(metric("Due today")).toBe("1");
    // The band's own sentence must agree with the metric above it.
    expect(screen.getByText(/3 open items across 2 subjects/)).toBeInTheDocument();
  });

  it("surfaces lateness as a badge and marks the row tone", async () => {
    stubCareerflow({ deadlines: [deadline(1, 5, -2)] });
    render(SubjectList, { props: { profileId: 7 } });

    // "1 late" legitimately appears twice -- once as the band-level badge and
    // once on the subject row -- so both are asserted by role rather than by a
    // bare text query that could not tell them apart.
    await waitFor(() =>
      expect(document.querySelector(".atl-section-aside .cf-badge.danger")?.textContent.trim())
        .toBe("1 late"),
    );

    const row = document.querySelector(".s-owed");
    expect(row.dataset.tone).toBe("bad");
    expect(row.textContent.trim()).toBe("1 late");
  });

  it("does not claim a completed deadline is still owed", async () => {
    stubCareerflow({ deadlines: [deadline(1, 5, -2, "2026-10-01 09:00:00")] });
    render(SubjectList, { props: { profileId: 7 } });

    await waitFor(() => expect(screen.getByText("Owed here")).toBeInTheDocument());
    expect(metric("Open")).toBe("0");
    expect(screen.getByText(/Nothing outstanding across 2 subjects/)).toBeInTheDocument();
  });

  it("says a subject with nothing owed is clear, accessibly", async () => {
    render(SubjectList, { props: { profileId: 7 } });

    await waitFor(() => expect(metric("Open")).toBe("0"));
    // Every row renders a cell; silent rows must not read as missing data.
    const rows = [...document.querySelectorAll(".s-owed")];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.textContent).toContain("Nothing outstanding");
      expect(r.dataset.tone).toBe("quiet");
    }
  });

  it("falls back to a review count when only cards are due", async () => {
    stubCareerflow({ cards: [{ id: 1, subjectId: 6, dueDate: localDay(0) }] });
    render(SubjectList, { props: { profileId: 7 } });

    await waitFor(() => expect(screen.getByText("1 to review")).toBeInTheDocument());
    // A due card is not a deadline: it must not inflate the Open/late figures.
    expect(metric("Open")).toBe("0");
  });

  it("labels a partially-failed read as partial instead of silently under-reporting", async () => {
    stubCareerflow({ deadlines: [deadline(1, 5, -2)], fail: ["cards"] });
    render(SubjectList, { props: { profileId: 7 } });

    // The deadline read still renders...
    await waitFor(() => expect(metric("Late")).toBe("1"));
    // ...but the strip admits it could not read everything.
    expect(screen.getByText(/Partial — 1 of 3 sources could not be read/)).toBeInTheDocument();
  });

  it("renders no obligations at all without a profile", async () => {
    render(SubjectList, { props: { profileId: null } });

    await waitFor(() => expect(screen.getByText("Owed here")).toBeInTheDocument());
    expect(metric("Open")).toBe("0");
  });
});