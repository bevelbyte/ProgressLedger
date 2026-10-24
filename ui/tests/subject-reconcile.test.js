import { describe, it, expect } from "vitest";
import { planSubjectReconciliation } from "../src/features/cgpa/subject-reconcile.js";

const db = (id, name, code = null) => ({ id, name, code });
const ui = (name, { subjectId = null, code = null } = {}) => ({
  id: subjectId != null ? `db_${subjectId}` : `sub_${name}`,
  subjectId,
  name,
  code,
});

describe("planSubjectReconciliation", () => {
  it("rename -> UPDATE the same subject.id, never delete+create", () => {
    const plan = planSubjectReconciliation([db(7, "Algorithms")], [ui("Distributed Systems", { subjectId: 7 })]);
    expect(plan.updates).toEqual([{ id: 7, name: "Distributed Systems", code: null }]);
    expect(plan.adds).toHaveLength(0);
    expect(plan.deleteIds).toHaveLength(0);
    expect(plan.claimedIds.has(7)).toBe(true);
  });

  it("code-only change updates; unchanged subject is a no-op", () => {
    const changed = planSubjectReconciliation([db(7, "Algorithms")], [ui("Algorithms", { subjectId: 7, code: "CS301" })]);
    expect(changed.updates).toEqual([{ id: 7, name: "Algorithms", code: "CS301" }]);

    const same = planSubjectReconciliation([db(7, "Algorithms", "CS301")], [ui("Algorithms", { subjectId: 7, code: "CS301" })]);
    expect(same.updates).toHaveLength(0);
    expect(same.deleteIds).toHaveLength(0);
  });

  it("case and whitespace changes stay the SAME identity (update only)", () => {
    const plan = planSubjectReconciliation([db(7, "algorithms ")], [ui("Algorithms", { subjectId: 7 })]);
    expect(plan.updates).toEqual([{ id: 7, name: "Algorithms", code: null }]);
    expect(plan.adds).toHaveLength(0);
    expect(plan.deleteIds).toHaveLength(0);
  });

  it("planner row without subjectId -> ADD; replaced subject with different name is genuinely deleted", () => {
    const plan = planSubjectReconciliation([db(1, "Maths")], [ui("Networks")]);
    expect(plan.adds).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
    // "Maths" is unclaimed AND its name matches no planner entry: the user
    // really removed it — deletion is correct, not a rename misfire.
    expect(plan.deleteIds).toEqual([1]);
  });

  it("new entry reusing an existing unclaimed subject's name -> preserved (rename/delete ambiguity)", () => {
    const plan = planSubjectReconciliation([db(1, "Networks")], [ui("Networks")]);
    expect(plan.adds).toHaveLength(1);
    expect(plan.deleteIds).toHaveLength(0);
    expect(plan.preservedIds).toEqual([1]);
  });

  it("genuine removal -> DELETE the unclaimed subject", () => {
    const plan = planSubjectReconciliation([db(1, "Maths"), db(2, "Networks")], [ui("Maths", { subjectId: 1 })]);
    expect(plan.deleteIds).toEqual([2]);
    expect(plan.preservedIds).toHaveLength(0);
  });

  it("stale hydrated id (subject deleted externally) recreates as new, deletes nothing else", () => {
    const plan = planSubjectReconciliation([], [ui("Algorithms", { subjectId: 42 })]);
    expect(plan.adds).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
    expect(plan.deleteIds).toHaveLength(0);
  });

  it("AMBIGUITY: unclaimed DB subject whose name matches a new planner entry is PRESERVED, not deleted", () => {
    // Planner renamed 7 away from "Algorithms"; a NEW entry reuses that name
    // while old subject 9 also still carries it. Deleting either would be a
    // guess — both must survive.
    const dbSubs = [db(7, "Distributed Systems"), db(9, "Algorithms")];
    const uiSubs = [
      ui("Distributed Systems", { subjectId: 7 }),
      ui("Algorithms"), // brand-new, no subjectId yet
    ];
    const plan = planSubjectReconciliation(dbSubs, uiSubs);
    expect(plan.updates).toHaveLength(0);
    expect(plan.adds).toContain(uiSubs[1]);
    expect(plan.preservedIds).toEqual([9]);
    expect(plan.deleteIds).toHaveLength(0);
  });

  it("duplicate legacy names in one semester: claimed id survives, twin preserved not destroyed", () => {
    const dbSubs = [db(11, "Algorithms"), db(12, "Algorithms")];
    const plan = planSubjectReconciliation(dbSubs, [ui("Algorithms", { subjectId: 11 })]);
    expect(plan.claimedIds.has(11)).toBe(true);
    expect(plan.preservedIds).toEqual([12]);
    expect(plan.deleteIds).toHaveLength(0);
  });

  it("multiple renames/reorders in one batch each keep their own identity", () => {
    const dbSubs = [db(1, "A"), db(2, "B"), db(3, "C")];
    const uiSubs = [ui("C2", { subjectId: 3 }), ui("A2", { subjectId: 1 }), ui("B2", { subjectId: 2 })];
    const plan = planSubjectReconciliation(dbSubs, uiSubs);
    expect(plan.updates.map((u) => u.id).sort()).toEqual([1, 2, 3]);
    expect(plan.deleteIds).toHaveLength(0);
    expect(plan.adds).toHaveLength(0);
  });
});
