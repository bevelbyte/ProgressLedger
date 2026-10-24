<script>
  // Study Sessions — the Plan surface for logged study time.
  //
  // Was: a title, four bordered stat cards, three bordered panels (timer,
  // manual log, recent sessions) — four boxes where the user needed one strip
  // and one list, and the two logging tools treated as separate features.
  //
  // Atlas structure (§5.2 grammar):
  //   1. HEAD      — view name + honest standing counts.
  //   2. READOUT   — one instrument strip (today / streak / total / sessions).
  //   3. BODY      — the log as the primary object: one band whose header holds
  //                  both logging tools inline (timer + manual entry), with the
  //                  session history as hairline rows beneath.
  //
  // "Study Sessions" stays an h2 heading — e2e/today.spec.js deep-links here
  // and asserts that exact heading.
  import { onDestroy } from "svelte";
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { sessionsService } from "../services/sessions.service.js";
  import { formatDuration, formatSessionStart, flattenSubjects, elapsedMinutes } from "../sessions-view.js";
  import { toLocalTimestamp } from "../../../shared/utils/local-date.js";
  import { Play, Square, Plus, Trash2, Clock, Flame, CalendarDays } from "lucide-svelte";

  let { profileId = null } = $props();

  let subjects = $state([]);
  let sessions = $state([]);
  let stats = $state({ totalSessions: 0, totalMinutes: 0, minutesToday: 0, activeDays: 0 });
  let loading = $state(false);

  // Timer state (local UI).
  let selectedSubjectId = $state(null);
  let timerStartMs = $state(null);
  let nowMs = $state(Date.now());
  let timerInterval = null;
  const running = $derived(timerStartMs !== null);
  const liveMinutes = $derived(running ? elapsedMinutes(timerStartMs, nowMs) : 0);

  // Manual entry state (local UI).
  let manualSubjectId = $state(null);
  let manualMinutes = $state(null);
  let manualNotes = $state("");

  async function load() {
    if (!profileId) {
      subjects = [];
      sessions = [];
      stats = { totalSessions: 0, totalMinutes: 0, minutesToday: 0, activeDays: 0 };
      return;
    }
    loading = true;
    try {
      subjects = flattenSubjects(await sessionsService.getTree(profileId));
      if (selectedSubjectId == null) selectedSubjectId = subjects[0]?.id ?? null;
      if (manualSubjectId == null) manualSubjectId = subjects[0]?.id ?? null;
      sessions = await sessionsService.list(profileId, 50);
      stats = await sessionsService.stats(profileId);
    } catch (e) {
      reportError(e, "Could not load study sessions");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    profileId;
    load();
  });

  // Refresh when another surface logs a session. This view used to only emit
  // `cf:data-changed` and never listen, so time logged from the Subject Workspace
  // or a Focus Session did not show up in Recent Sessions until a manual reload.
  $effect(() => {
    const onChanged = () => load();
    window.addEventListener("cf:data-changed", onChanged);
    return () => window.removeEventListener("cf:data-changed", onChanged);
  });

  onDestroy(() => {
    if (timerInterval) clearInterval(timerInterval);
  });

  function startTimer() {
    if (selectedSubjectId == null) {
      toast.warning("Add a subject in the Degree planner first.");
      return;
    }
    timerStartMs = Date.now();
    nowMs = Date.now();
    timerInterval = setInterval(() => (nowMs = Date.now()), 1000);
  }

  async function stopTimer() {
    if (!running) return;
    const startedMs = timerStartMs;
    const minutes = elapsedMinutes(startedMs, Date.now());
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    timerStartMs = null;

    if (minutes < 1) {
      toast.info("Session under a minute was not logged.");
      return;
    }
    await logSession(selectedSubjectId, minutes, toLocalTimestamp(new Date(startedMs)), toLocalTimestamp(new Date()), "");
  }

  async function addManual() {
    const mins = Number(manualMinutes);
    if (manualSubjectId == null) {
      toast.warning("Choose a subject.");
      return;
    }
    if (!Number.isFinite(mins) || mins <= 0) {
      toast.error("Enter a duration greater than zero.");
      return;
    }
    await logSession(manualSubjectId, Math.round(mins), null, null, manualNotes.trim());
    manualMinutes = null;
    manualNotes = "";
  }

  async function logSession(subjectId, minutes, startedAt, endedAt, notes) {
    try {
      await sessionsService.add(profileId, subjectId, minutes, startedAt, endedAt, notes);
      // Study activity affects the dashboard streak. This also refreshes this
      // view — the cf:data-changed listener above — so no explicit reload.
      window.dispatchEvent(new Event("cf:data-changed"));
      toast.success(`Logged ${formatDuration(minutes)} of study.`);
    } catch (e) {
      reportError(e, "Could not save session");
    }
  }

  async function removeSession(s) {
    const ok = await confirmDialog({
      title: "Delete session",
      message: `Delete the ${formatDuration(s.durationMinutes)} session for ${s.subjectName}?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await sessionsService.remove(profileId, s.id);
      window.dispatchEvent(new Event("cf:data-changed"));
      await load();
    } catch (e) {
      reportError(e, "Could not delete session");
    }
  }

  function liveClock(min) {
    return formatDuration(min);
  }
</script>

<div class="study-sessions atl-view">
  <header class="page-head">
    <div class="head-id">
      <h2>Study Sessions</h2>
      <p class="standing">
        {formatDuration(stats.minutesToday)} today · {stats.activeDays} active day{stats.activeDays === 1 ? "" : "s"}
        · {stats.totalSessions} session{stats.totalSessions === 1 ? "" : "s"}
      </p>
    </div>
  </header>

  {#if !profileId}
    <div class="cf-empty">
      <Clock size={30} />
      <h3>No profile selected</h3>
      <p>Select a profile to track study time.</p>
    </div>
  {:else}
    <div class="readout">
      <div class="stat">
        <span class="stat-num">{formatDuration(stats.minutesToday)}</span>
        <span class="atl-label">Today</span>
      </div>
      <div class="stat">
        <span class="stat-num">{stats.activeDays}</span>
        <span class="atl-label">Active days</span>
      </div>
      <div class="stat">
        <span class="stat-num">{formatDuration(stats.totalMinutes)}</span>
        <span class="atl-label">Total</span>
      </div>
      <div class="stat">
        <span class="stat-num">{stats.totalSessions}</span>
        <span class="atl-label">Sessions</span>
      </div>
    </div>

    {#if subjects.length === 0}
      <div class="cf-empty boxed">
        <Clock size={26} />
        <h3>Nothing to log against</h3>
        <p>Subjects are created in the Degree planner. Study time always belongs to one.</p>
      </div>
    {:else}
      <section class="atl-band">
        <div class="atl-band-head">
          <h3>Log a session</h3>
          <p class="atl-band-note">Run the timer while you study, or add the time afterwards.</p>
        </div>

        <div class="log-tools">
          <div class="tool timer" class:running>
            <span class="atl-label">Timer</span>
            <div class="tool-row">
              <select class="cf-select" bind:value={selectedSubjectId} disabled={running} aria-label="Timer subject">
                {#each subjects as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
              </select>
              <span class="live-clock mono" aria-live="off">{liveClock(liveMinutes)}</span>
              {#if running}
                <button class="cf-btn danger" onclick={stopTimer}><Square size={14} /> Stop &amp; log</button>
              {:else}
                <button class="cf-btn primary" onclick={startTimer}><Play size={14} /> Start</button>
              {/if}
            </div>
          </div>

          <div class="tool-divider" role="separator" aria-hidden="true"></div>

          <div class="tool">
            <span class="atl-label">Manual entry</span>
            <div class="tool-row">
              <select class="cf-select" bind:value={manualSubjectId} aria-label="Manual entry subject">
                {#each subjects as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
              </select>
              <input class="cf-input minutes" type="number" min="1" placeholder="Minutes" bind:value={manualMinutes} />
              <input class="cf-input notes" type="text" placeholder="Notes (optional)" bind:value={manualNotes} />
              <button class="cf-btn" onclick={addManual}><Plus size={14} /> Add</button>
            </div>
          </div>
        </div>
      </section>

      <section class="atl-band">
        <div class="atl-band-head">
          <h3>Recent Sessions</h3>
          <p class="atl-band-note">{sessions.length} shown · newest first</p>
        </div>
        {#if loading}
          <div class="cf-skeleton skel"></div>
        {:else if sessions.length === 0}
          <p class="cf-empty">No study sessions logged yet.</p>
        {:else}
          <div class="session-list">
            {#each sessions as s (s.id)}
              <div class="session-row">
                <span class="session-subject">{s.subjectName}</span>
                <span class="session-meta mono">{formatSessionStart(s.startedAt)}</span>
                {#if s.notes}<span class="session-note">{s.notes}</span>{/if}
                <span class="session-dur mono">{formatDuration(s.durationMinutes)}</span>
                <button class="icon-btn" title="Delete" aria-label="Delete {s.subjectName} session" onclick={() => removeSession(s)}>
                  <Trash2 size={14} />
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .head-id { display: flex; flex-direction: column; gap: 4px; }
  .page-head h2 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }
  .standing { margin: 0; font-size: var(--text-md); color: var(--atlas-ink-3); font-variant-numeric: tabular-nums; }

  .readout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    background: var(--atlas-panel);
  }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat-num {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--atlas-ink);
    font-variant-numeric: tabular-nums;
  }

  .atl-band-head h3 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--atlas-ink); }

  .log-tools {
    display: flex;
    align-items: stretch;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .tool { flex: 1; min-width: 340px; display: flex; flex-direction: column; gap: var(--space-2); }
  .tool.running .live-clock { color: var(--atlas-signal); }
  .tool-divider { width: 1px; background: var(--atlas-line); flex: 0 0 auto; }
  .tool-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .tool-row select { flex: 1; min-width: 170px; }

  .live-clock {
    font-family: var(--font-mono);
    font-size: var(--text-xl);
    font-weight: 650;
    color: var(--atlas-ink-3);
    min-width: 72px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .mono { font-family: var(--font-mono); }
  .minutes { width: 92px; }
  .notes { flex: 1; min-width: 150px; }

  .cf-btn.danger {
    background: var(--atlas-bad-bg);
    color: var(--atlas-bad);
    border: 1px solid var(--atlas-bad);
    font-weight: 600;
  }

  .session-list { display: flex; flex-direction: column; }

  .session-row {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
    border-top: 1px solid var(--atlas-line);
    font-size: var(--text-md);
  }
  .session-row:hover { background: var(--atlas-wash); }

  .session-subject {
    font-weight: 550;
    color: var(--atlas-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-meta {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .session-note {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-dur {
    font-weight: 600;
    color: var(--atlas-ink-2);
    font-variant-numeric: tabular-nums;
    min-width: 6ch;
    text-align: right;
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: none;
    border: 0;
    border-radius: var(--radius-xs);
    color: var(--atlas-ink-3);
    cursor: pointer;
  }
  .icon-btn:hover { color: var(--atlas-bad); background: var(--atlas-wash-2); }

  .skel { height: 120px; }

  @media (max-width: 900px) {
    .session-row { grid-template-columns: minmax(0, 1fr) auto auto; }
    .session-meta, .session-note { display: none; }
    .tool-divider { display: none; }
  }
</style>
