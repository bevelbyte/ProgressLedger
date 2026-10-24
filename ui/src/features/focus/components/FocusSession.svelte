<script>
  // Focus Session — "I have decided to study now, what happens next?"
  //
  // A focused surface: timer + optional objective + read-only context, over a
  // real subject. It has NO persistence of its own and NO second engine —
  // finishing calls sessionsService.add() exactly once into the existing
  // `session_states` table, so Study Sessions stays the source of truth and the
  // objective lives in that record's existing `notes` column (no schema change).
  //
  // There is no persisted "active session". Abandoning a running focus — Escape,
  // Discard, navigating away, switching profile, closing the app — logs nothing.
  // That is deliberate and stated to the user rather than silently invented.
  import { onDestroy } from "svelte";
  import { toast, toastState, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { toLocalTimestamp } from "../../../shared/utils/local-date.js";
  import { focusService } from "../services/focus.service.js";
  import {
    formatClock,
    elapsedWholeMinutes,
    focusSubjects,
    buildFocusContext,
    contextIsEmpty,
    deadlinePhrase,
    resolveFinish,
  } from "../focus-view.js";
  import { formatDuration } from "../../study-sessions/sessions-view.js";
  import { Timer, Flag, CalendarClock, Layers, StickyNote, X } from "lucide-svelte";

  let { open = false, profileId = null, academicTree = [], initialSubjectId = null, onClose = () => {} } = $props();

  let subjectId = $state(null);
  let objective = $state("");
  let startedMs = $state(null);
  let nowMs = $state(Date.now());
  let timerInterval = null;
  let saving = $state(false);
  // The profile the running timer was started under. A running focus belongs to
  // that profile, not to whichever profile happens to be active on close.
  let sessionProfileId = $state(null);
  let context = $state({ overview: null, deadlines: [] });
  let contextLoading = $state(false);
  // Invalidation counter for in-flight context fetches. Not reactive: it only
  // distinguishes a fresh fetch from a superseded one.
  let contextGeneration = 0;
  let noteText = $state("");
  let noteBusy = $state(false);

  // The subject list comes from the academic tree App already loads for the
  // active profile. A pre-selected subject that is no longer in the tree
  // (deleted while the modal was open) falls back to the chooser instead of
  // silently logging against an id that no longer exists.
  let subjects = $derived(focusSubjects(academicTree));
  let chosenSubject = $derived(subjects.find((s) => s.id === subjectId) || null);
  const choosing = $derived(subjectId == null);
  const running = $derived(startedMs !== null);
  const elapsedMinutes = $derived(running ? elapsedWholeMinutes(startedMs, nowMs) : 0);
  const clock = $derived(running ? formatClock(startedMs, nowMs) : "00:00:00");
  const focusContext = $derived(
    buildFocusContext({
      subjectName: chosenSubject?.name,
      path: chosenSubject?.path,
      overview: context.overview,
      deadlines: context.deadlines,
      minutesToday: context.overview?.studyMinutesToday ?? null,
    })
  );

  function clearTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
  }

  onDestroy(clearTimer);

  // Reset and open. A subject passed in by the caller starts the clock
  // immediately; otherwise the user chooses one and the clock starts with it.
  $effect(() => {
    if (!open) return;
    objective = "";
    noteText = "";
    saving = false;
    noteBusy = false;
    clearTimer();
    // Invalidate any in-flight fetch and clear the previous session's strip
    // before rendering. Without this, reopening with a preselected subject
    // showed the last session's context under the new subject's name until the
    // new fetch resolved.
    contextGeneration++;
    context = { overview: null, deadlines: [] };
    contextLoading = false;
    sessionProfileId = null;

    if (initialSubjectId != null && subjects.some((s) => s.id === initialSubjectId)) {
      subjectId = initialSubjectId;
      beginTimer();
      loadContext(initialSubjectId);
    } else {
      subjectId = null;
      startedMs = null;
    }
    focusFirstControl();
  });

  // A running focus belongs to the profile it was started under. Replacing it
  // with a different profile — not just dropping to none — would keep a clock
  // and a subject strip from the old profile while the shell shows the new one,
  // so the session ends and nothing is recorded: loudly, not silently.
  $effect(() => {
    profileId;
    if (!open || !running || saving) return;
    if (profileId === sessionProfileId) return;
    endDiscarded("Focus ended — the profile changed. Time was not logged.");
  });

  // Move focus into the dialog. The button that opened it is covered by the
  // backdrop but still holds keyboard focus; left alone, pressing Enter again
  // re-activates it, and Tab can walk out of the dialog onto the backdrop.
  function focusFirstControl() {
    setTimeout(() => {
      const modal = document.querySelector(".focus-modal");
      if (!modal) return;
      modal.querySelector(".subject-select, .objective-input, .cancel-btn")?.focus();
    }, 0);
  }

  function beginTimer() {
    sessionProfileId = profileId;
    const t = Date.now();
    startedMs = t;
    nowMs = t;
    clearTimer();
    timerInterval = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  }

  function chooseSubject(id) {
    if (id == null) return;
    subjectId = id;
    beginTimer();
    loadContext(id);
  }

  async function loadContext(id) {
    // A subject can be replaced while a fetch is in flight; a superseded
    // response must not overwrite the newer subject's strip or clear its
    // loading state out from under it.
    const generation = ++contextGeneration;
    contextLoading = true;
    try {
      // A failed context fetch must never block or kill the timer: degrade to
      // an empty strip.
      const ctx = await focusService.context({ profileId, subjectId: id });
      if (generation !== contextGeneration) return;
      context = ctx;
    } catch (e) {
      if (generation !== contextGeneration) return;
      context = { overview: null, deadlines: [] };
    } finally {
      if (generation === contextGeneration) contextLoading = false;
    }
  }

  function handleKeydown(e) {
    // A discard prompt is already open, so let Escape through to Toaster's
    // window-level handler and let the user cancel it. Stopping propagation
    // here made Escape look broken: the second press re-entered discard() and
    // re-opened the identical prompt.
    if (e.key === "Escape" && toastState.confirm) return;
    // Everything else is swallowed: the backdrop is an ancestor and treats
    // Enter/Space as "discard", so a stray key from the objective or note
    // field would otherwise end the session.
    e.stopPropagation();
    if (e.key === "Escape") {
      discard();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish();
  }

  // Discard / cancel: never fabricates a session. Confirms when a real amount of
  // time was spent, so an accidental close is visible rather than invisible.
  async function discard() {
    if (saving) return;
    if (running && elapsedMinutes >= 1) {
      const ok = await confirmDialog({
        title: "Discard this session?",
        message: `${formatDuration(elapsedMinutes)} was studied. Nothing will be logged.`,
        confirmLabel: "Discard",
      });
      if (!ok) return;
    }
    endDiscarded(null);
  }

  function endDiscarded(message) {
    if (!open) return; // superseded: the session already ended and onClose ran
    clearTimer();
    startedMs = null;
    subjectId = null;
    sessionProfileId = null;
    objective = "";
    noteText = "";
    onClose();
    if (message) toast.info(message);
  }

  // Finish: exactly one Study Session record, via the existing service. The
  // objective is optional and rides in the session's existing notes field.
  async function finish() {
    if (saving || !running) return;
    saving = true;
    try {
      // Measure against real wall time, not the last interval tick. `nowMs` can
      // lag Date.now() by up to a second, which could reject a session that
      // genuinely crossed 60s as "under a minute", and the persisted ended_at
      // is taken from real time regardless.
      const finishedAtMs = Date.now();
      const result = resolveFinish({
        startedMs,
        finishedAtMs,
        minutes: elapsedWholeMinutes(startedMs, finishedAtMs),
        objective,
      });
      if (!result.ok) {
        if (result.reason === "too-short") {
          toast.info("Sessions under a minute are not logged — keep going or discard.");
        }
        return;
      }
      await focusService.addSession(
        sessionProfileId,
        subjectId,
        result.minutes,
        toLocalTimestamp(new Date(startedMs)),
        toLocalTimestamp(new Date(finishedAtMs)),
        result.objective
      );
      // Clear the session before anything else runs. If a listener or the toast
      // throws after the INSERT lands, the clock must not stay live — a second
      // Finish would otherwise log the same minutes again.
      clearTimer();
      startedMs = null;
      subjectId = null;
      sessionProfileId = null;
      objective = "";
      noteText = "";
      // Study activity affects the dashboard streak, weekly plan, semester
      // progress and this subject's workspace.
      window.dispatchEvent(new Event("cf:data-changed"));
      onClose();
      toast.success(`Logged ${formatDuration(result.minutes)} of focused study.`);
    } catch (e) {
      reportError(e, "Could not save focus session");
    } finally {
      saving = false;
    }
  }

  // A thought that shouldn't be lost mid-session becomes a real subject-scoped
  // note. This reuses the fixed QuickNote path (resources.addNote) — never a
  // synthetic inbox, which the Degree Planner would silently delete.
  async function saveNote() {
    const text = noteText.trim();
    if (!text) {
      toast.warning("Write something to save as a note.");
      return;
    }
    if (subjectId == null) return;
    noteBusy = true;
    try {
      await focusService.addQuickNote(sessionProfileId, subjectId, `Focus note — ${chosenSubject?.name || "Study"}`, text);
      noteText = "";
      window.dispatchEvent(new Event("cf:data-changed"));
      toast.success("Note saved to subject.");
    } catch (e) {
      reportError(e, "Could not save quick note");
    } finally {
      noteBusy = false;
    }
  }
</script>

{#if open}
  <div
    class="focus-backdrop"
    role="button"
    tabindex="0"
    aria-label="Discard focus session"
    onclick={() => discard()}
    onkeydown={(e) => (e.key === "Enter" || e.key === " ") && discard()}
  >
    <div
      class="focus-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Focus Session"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={handleKeydown}
    >
      <header>
        <div class="head-left">
          <span class="head-icon"><Timer size={16} /></span>
          <h2>Focus Session</h2>
        </div>
        <button class="close-btn" onclick={() => discard()} aria-label="Discard" title="Discard" disabled={saving}
          ><X size={13} strokeWidth={2} aria-hidden="true" /></button>
      </header>

      <div class="body">
        <!-- PHASE 1 — choose a subject -->
        {#if choosing}
          <div class="choose">
            <p class="choose-lede">Pick what you're studying. The clock starts when you choose.</p>
            {#if academicTree.length === 0}
              <p class="hint">
                This profile has no subjects yet. Focus needs a real subject — add one in the Degree Planner first.
              </p>
            {:else}
              <select
                class="subject-select"
                bind:value={subjectId}
                aria-label="Study subject"
                onchange={() => chooseSubject(subjectId)}
              >
                {#each subjects as s (s.id)}
                  <option value={s.id}>{s.path} › {s.name}</option>
                {/each}
              </select>
            {/if}
          </div>
        {:else}
          <!-- PHASE 2 — the session -->
          <div class="subject-strip">
            <div class="subject-name">{chosenSubject.name}</div>
            {#if chosenSubject.path}
              <div class="subject-path">{chosenSubject.path}</div>
            {/if}
          </div>

          <div class="clock" aria-label="Elapsed time" role="timer">{clock}</div>

          <label class="objective-label" for="focus-objective">Session objective</label>
          <!-- Enter is deliberately inert in the objective field. It used to save
               the quick note, which here means either warning about an empty note
               the user never meant to save, or writing one while they type an
               objective. The quick note has its own input and save button. -->
          <input
            id="focus-objective"
            type="text"
            class="objective-input"
            placeholder="What are you going to finish? (optional)"
            bind:value={objective}
          />

          <div class="context">
            <div class="context-head">Current context</div>
            {#if contextLoading}
              <div class="context-row muted">Loading…</div>
            {:else if contextIsEmpty(focusContext)}
              <div class="context-row muted">Nothing pending for this subject.</div>
            {:else}
              {#if focusContext.nearestDeadline}
                <div class="context-row">
                  <CalendarClock size={14} />
                  <span class="ctx-text">{focusContext.nearestDeadline.title}</span>
                  <span class="ctx-tag">{deadlinePhrase(focusContext.nearestDeadline)}</span>
                </div>
              {/if}
              {#if focusContext.flashcardsDue != null && focusContext.flashcardsDue > 0}
                <div class="context-row">
                  <Layers size={14} />
                  <span class="ctx-text">{focusContext.flashcardsDue} flashcard{focusContext.flashcardsDue === 1 ? "" : "s"} due</span>
                </div>
              {/if}
              {#if focusContext.minutesToday != null}
                <div class="context-row">
                  <Timer size={14} />
                  <span class="ctx-text">{formatDuration(focusContext.minutesToday)} studied today</span>
                </div>
              {/if}
            {/if}
          </div>

          <div class="capture">
            <div class="capture-head">
              <StickyNote size={13} /> Quick note
            </div>
            <div class="capture-row">
              <input
                type="text"
                class="capture-input"
                placeholder="Add quick note"
                bind:value={noteText}
                aria-label="Quick note"
                onkeydown={(e) => e.key === "Enter" && !e.ctrlKey && !e.metaKey && saveNote()}
              />
              <button class="capture-btn" onclick={saveNote} disabled={noteBusy || !noteText.trim()}>
                {noteBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        {/if}
      </div>

      <footer>
        <div class="hints">
          {#if running}
            <span class="hint">Ctrl+Enter to finish</span>
            <span class="hint">Esc to discard</span>
          {/if}
        </div>
        <div class="actions">
          <button class="cancel-btn" onclick={() => discard()} disabled={saving}>Cancel</button>
          {#if running}
            <button class="finish-btn" onclick={finish} disabled={saving}>
              <Flag size={14} />
              {saving ? "Saving…" : "Finish Session"}
            </button>
          {/if}
        </div>
      </footer>
    </div>
  </div>
{/if}

<style>
  .focus-backdrop {
    position: fixed;
    inset: 0;
    background: var(--atlas-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1200;
    backdrop-filter: blur(5px);
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(20px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .focus-modal {
    width: min(560px, 92vw);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line-2);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-3), var(--lift);
    animation: slideUp 0.2s ease-out;
  }

  .focus-modal > * { min-width: 0; }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--atlas-line);
  }

  .head-left { display: flex; align-items: center; gap: 10px; }
  .head-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-lg);
    background: var(--atlas-signal-soft);
    color: var(--atlas-signal);
  }
  header h2 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 650;
    color: var(--atlas-ink);
    letter-spacing: -0.01em;
  }

  .close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    background: transparent;
    border: none;
    color: var(--atlas-ink-3);
    cursor: pointer;
    padding: 0;
    border-radius: var(--radius-md);
  }
  .close-btn:hover:not(:disabled) {
    background: var(--atlas-wash);
    color: var(--atlas-ink);
  }
  .close-btn:disabled { opacity: 0.45; cursor: default; }

  .body {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    overflow-y: auto;
  }

  /* Choose phase */
  .choose { display: flex; flex-direction: column; gap: 12px; }
  .choose-lede {
    margin: 0;
    color: var(--atlas-ink-2);
    font-size: var(--text-lg);
    line-height: 1.5;
  }

  .subject-select {
    width: 100%;
    background: var(--atlas-raise);
    border: 1px solid var(--atlas-line-2);
    border-radius: var(--radius-lg);
    padding: 11px 12px;
    color: var(--atlas-ink);
    font-size: var(--text-lg);
  }

  /* Session phase */
  .subject-strip { display: flex; flex-direction: column; gap: 2px; }
  .subject-name {
    font-size: var(--text-2xl);
    font-weight: 650;
    color: var(--atlas-ink);
    letter-spacing: -0.01em;
  }
  .subject-path {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
  }

  .clock {
    font-family: var(--font-mono);
    font-size: var(--text-metric);
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: 0.01em;
    color: var(--atlas-signal);
    font-variant-numeric: tabular-nums;
    text-align: center;
    padding: 6px 0 2px;
  }

  .objective-label {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
  }
  .objective-input {
    width: 100%;
    background: var(--atlas-raise);
    border: 1px solid var(--atlas-line-2);
    border-radius: var(--radius-lg);
    padding: 11px 12px;
    color: var(--atlas-ink);
    font-size: var(--text-lg);
  }

  .context {
    border-top: 1px solid var(--atlas-line);
    border-bottom: 1px solid var(--atlas-line);
    padding: var(--space-3) 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .context-head {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
  }
  .context-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-md);
    color: var(--atlas-ink-2);
  }
  .context-row :global(svg) { color: var(--atlas-ink-3); flex-shrink: 0; }
  .ctx-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx-tag {
    flex-shrink: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--atlas-warn);
    background: var(--atlas-warn-bg);
    border-radius: var(--radius-full);
    padding: 2px 9px;
  }

  .capture { display: flex; flex-direction: column; gap: 8px; }
  .capture-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
  }
  .capture-row { display: flex; gap: 8px; }
  .capture-input {
    flex: 1;
    min-width: 0;
    background: var(--atlas-raise);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    padding: 9px 11px;
    color: var(--atlas-ink);
    font-size: var(--text-lg);
  }
  .capture-btn {
    background: var(--atlas-raise);
    border: 1px solid var(--atlas-line-2);
    color: var(--atlas-ink-2);
    border-radius: var(--radius-lg);
    padding: 9px 14px;
    font-size: var(--text-md);
    font-weight: 600;
    cursor: pointer;
  }
  .capture-btn:hover:not(:disabled) {
    border-color: var(--atlas-signal);
    color: var(--atlas-ink);
  }
  .capture-btn:disabled { opacity: 0.5; cursor: default; }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--atlas-line);
  }

  .hints { display: flex; gap: 8px; flex-wrap: wrap; }
  .hint {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--atlas-ink-3);
    background: var(--atlas-raise);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-full);
    padding: 3px 9px;
    white-space: nowrap;
  }

  .actions { display: flex; gap: 8px; flex-shrink: 0; }

  .cancel-btn {
    background: transparent;
    border: 1px solid var(--atlas-line-2);
    color: var(--atlas-ink-2);
    border-radius: var(--radius-lg);
    padding: 10px 16px;
    font-size: var(--text-md);
    font-weight: 600;
    cursor: pointer;
  }
  .cancel-btn:hover:not(:disabled) {
    border-color: var(--atlas-bad);
    color: var(--atlas-bad);
  }
  .cancel-btn:disabled { opacity: 0.5; cursor: default; }

  .finish-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: var(--atlas-signal);
    border: none;
    color: var(--atlas-signal-ink);
    border-radius: var(--radius-lg);
    padding: 10px 18px;
    font-size: var(--text-md);
    font-weight: 650;
    cursor: pointer;
  }
  .finish-btn:hover:not(:disabled) { background: var(--atlas-signal-2); }
  .finish-btn:disabled { opacity: 0.5; cursor: default; }

  p.hint {
    margin: 0;
    color: var(--atlas-ink-3);
    font-size: var(--text-lg);
    line-height: 1.5;
  }

  @media (max-width: 560px) {
    .clock { font-size: var(--text-metric); }
    .body { padding: 16px; }
    header, footer { padding: 14px 16px; }
    .actions { width: 100%; }
    .actions button { flex: 1; justify-content: center; }
  }
</style>
