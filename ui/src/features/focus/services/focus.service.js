/**
 * Focus service — composition over the services Focus already has.
 *
 * There is deliberately no IPC here. Focus needs exactly three things that all
 * already exist end-to-end:
 *   subjects            academic.tree        (profile -> subject tree)
 *   context             resources.overview   (one call: study minutes, flashcards due)
 *                       deadlines.list
 *   finish session      sessions.add         -> Rust add_study_session -> session_states
 *   quick note          resources.addNote    (the fixed subject-scoped note path)
 *
 * Study Sessions remains the source of truth for study records; Focus only calls
 * into it. No second engine, no new table, no new channel.
 */

import { sessionsService } from "../../study-sessions";
import { subjectService } from "../../subjects";
import { noteService } from "../../notes";

export const focusService = {
  /**
   * Read-only context for a subject. Settles everything: a failed overview or
   * deadline fetch must never block or kill the timer, so each source degrades
   * to an empty value instead of rejecting.
   */
  async context({ profileId, subjectId }) {
    const [overview, deadlines] = await Promise.allSettled([
      subjectId != null ? subjectService.getOverview(profileId, subjectId) : Promise.resolve(null),
      profileId != null && subjectId != null
        ? subjectService.listSubjectDeadlines(profileId, subjectId)
        : Promise.resolve([]),
    ]);
    return {
      overview: overview.status === "fulfilled" ? overview.value || null : null,
      deadlines: deadlines.status === "fulfilled" ? deadlines.value || [] : [],
    };
  },

  /** Log exactly one Study Session (subject-scoped). Durations must be > 0. */
  addSession(profileId, subjectId, durationMinutes, startedAt = null, endedAt = null, notes = null) {
    return sessionsService.add(profileId, subjectId, durationMinutes, startedAt, endedAt, notes);
  },

  /**
   * A subject-scoped quick note. This is the fixed path QuickNote already uses;
   * Focus must never synthesize a subject or route a note anywhere else, because
   * the old auto-created "Quick Notes" inbox was silently deleted by the next
   * Degree Planner sync.
   */
  addQuickNote(profileId, subjectId, title, content) {
    return noteService.addNote(profileId, subjectId, title, content);
  },
};
