/**
 * Pure subject-identity reconciliation for the Degree Planner -> SQLite sync.
 *
 * INVARIANT: subjects.id is the permanent identity of a subject. Renaming,
 * recasing, or re-spacing a subject must never create, destroy, or re-point
 * that identity — only its editable metadata changes.
 *
 * Inputs mirror the hydrated planner model: every persisted planner row carries
 * the real SQLite `subjectId`; a row without one is genuinely NEW. Name
 * equality is deliberately NOT used to decide identity here — it is used only
 * to detect AMBIGUITY, where this module preserves data instead of guessing:
 *
 *   - rename            -> same subjectId, UPDATE name/code
 *   - unchanged         -> no-op
 *   - new               -> ADD (planner-assigned temp id has no subjectId)
 *   - genuine removal   -> planner row gone => DELETE the unclaimed subject
 *   - ambiguous mapping -> PRESERVE the unmatched DB subject, never delete
 *
 * No IO, no Svelte — fully unit-testable.
 */

export function planSubjectReconciliation(dbSubjects, uiSubjects) {
  const updates = [];
  const adds = [];
  const claimedIds = new Set();

  for (const sub of uiSubjects) {
    const sid = sub.subjectId;
    if (sid != null) {
      const db = dbSubjects.find((d) => d.id === sid);
      if (!db) {
        // The hydrated subject disappeared outside this session. Recreating
        // under the new name treats it as what it now is — a new subject.
        // Nothing else is touched, so nothing can be silently destroyed.
        adds.push(sub);
        continue;
      }
      claimedIds.add(sid);
      if (db.name.trim() !== sub.name || (db.code ?? null) !== (sub.code ?? null)) {
        updates.push({ id: sid, name: sub.name, code: sub.code ?? null });
      }
    } else {
      adds.push(sub);
    }
  }

  // Deletion requires a DB subject that is BOTH unclaimed by any planner row
  // AND whose name matches no current planner entry. That second condition is
  // the ambiguity brake: if a name collision exists we cannot tell whether we
  // are looking at a rename target or a leftover, so the row is preserved and
  // reported to the caller instead of destroyed.
  const deleteIds = [];
  const preservedIds = [];
  const uiNames = new Set(uiSubjects.map((s) => s.name.trim().toLowerCase()));
  for (const db of dbSubjects) {
    if (claimedIds.has(db.id)) continue;
    if (uiNames.has(db.name.trim().toLowerCase())) preservedIds.push(db.id);
    else deleteIds.push(db.id);
  }

  return { updates, adds, deleteIds, preservedIds, claimedIds };
}
