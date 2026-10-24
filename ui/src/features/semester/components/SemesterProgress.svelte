<script>
  // Semester Progress — "how is this semester actually going?" from one bounded
  // aggregate read. It owns nothing: subjects, marks, study time and deadlines
  // stay their features'. Actions hand off.
  //
  // Atlas structure: identity strip, a persistent four-column readout, then one
  // hairline subject table. Previously four bordered cards sat above a bordered
  // section inside a bordered page — three nested borders for one idea.
  //
  // E2E contracts preserved: `.semester-progress`, `.card` with `.card-head` /
  // `.card-main` / `.card-sub`, and the exact study strings.
  import { ChevronLeft, GraduationCap, Timer, CalendarDays, BookOpen, ArrowRight } from "lucide-svelte";
  import { reportError } from "../../../shared/utils/errors.js";
  import { semesterService } from "../services/semester.service.js";
  import {
    formatStudyTime, formatSgpa, gradedText, completedText,
    deadlineSummary, formatDeadlineDate, subjectStatusLabel,
  } from "../semester-view.js";

  let { profileId = null, semesterId = null, onOpenSubject = () => {}, onNavigate = () => {}, onBack = null } = $props();

  let overview = $state(null);
  let loading = $state(false);
  let loadingId = $state(null);
  let loadGeneration = 0;

  async function load(id) {
    if (id == null) { overview = null; return; }
    const generation = ++loadGeneration;
    loadingId = id;
    loading = true;
    try {
      const ov = await semesterService.getOverview(profileId, id);
      if (generation === loadGeneration && loadingId === id) overview = ov;
    } catch (e) {
      if (generation === loadGeneration && loadingId === id) { overview = null; reportError(e, "Could not load semester progress"); }
    } finally {
      if (generation === loadGeneration && loadingId === id) loading = false;
    }
  }

  $effect(() => { load(semesterId); });

  // Refresh when academic/course/study/deadline data changes elsewhere.
  $effect(() => {
    const onChanged = () => load(semesterId);
    window.addEventListener("cf:data-changed", onChanged);
    return () => window.removeEventListener("cf:data-changed", onChanged);
  });

  const sgpa = $derived(formatSgpa(overview?.academic));
  const dlSummary = $derived(deadlineSummary(overview?.deadlines));
</script>

<div class="semester-progress">
  {#if onBack}
    <button class="back-btn" onclick={onBack}><ChevronLeft size={15} /> Back</button>
  {/if}

  {#if semesterId == null}
    <div class="cf-empty">
      <GraduationCap size={30} />
      <h3>No semester in scope</h3>
      <p>Pick a semester in the Structure face to see its progress.</p>
    </div>
  {:else if loading && !overview}
    <div class="cf-skeleton skel"></div>
  {:else if overview}
    <header class="sp-head">
      <div class="sp-id">
        <p class="atl-label trail">{overview.trackName}</p>
        <h2>
          {overview.name}
          <span class="status-badge {overview.status.toLowerCase().replace(' ', '-')}">{overview.status}</span>
        </h2>
      </div>
      <button class="cf-btn ghost" onclick={() => onNavigate("cgpa")}>
        <GraduationCap size={13} /> Edit in Degree planner
      </button>
    </header>

    <div class="readout">
      <div class="card">
        <div class="card-head"><GraduationCap size={13} /> Academic</div>
        {#if sgpa}
          <div class="card-main">SGPA {sgpa}</div>
          <div class="card-sub">{overview.academic.gradedCredits} credits graded · {gradedText(overview.completion)}</div>
        {:else}
          <div class="card-main muted">No graded subjects yet</div>
          <div class="card-sub">{gradedText(overview.completion)}</div>
        {/if}
      </div>

      <div class="card">
        <div class="card-head"><BookOpen size={13} /> Completion</div>
        <div class="card-main">{completedText(overview.completion)}</div>
        <div class="card-sub">
          {overview.completion.inProgressSubjects} in progress · {overview.completion.pendingSubjects} pending
        </div>
      </div>

      <div class="card">
        <div class="card-head"><Timer size={13} /> Study</div>
        {#if overview.study.sessionCount > 0}
          <div class="card-main">{formatStudyTime(overview.study.totalMinutes)}</div>
          <div class="card-sub">{formatStudyTime(overview.study.minutesLast7)} in last 7 days · {overview.study.sessionCount} sessions</div>
        {:else}
          <div class="card-main muted">No study logged yet</div>
          <div class="card-sub">Log time against a subject to see it here.</div>
        {/if}
        <button class="card-action" onclick={() => onNavigate("sessions")}><Timer size={13} /> Log study</button>
      </div>

      <div class="card">
        <div class="card-head"><CalendarDays size={13} /> Deadlines</div>
        {#if dlSummary}
          <div class="card-main" class:urgent={overview.deadlines.overdue > 0}>{dlSummary}</div>
          {#if overview.deadlines.nextTitle}
            <button class="card-sub link" onclick={() => onOpenSubject(overview.deadlines.nextSubjectId)}>
              Next: {overview.deadlines.nextTitle} · {formatDeadlineDate(overview.deadlines.nextDate)}
            </button>
          {:else}
            <div class="card-sub">Nothing further scheduled.</div>
          {/if}
        {:else}
          <div class="card-main muted">No deadlines</div>
          <div class="card-sub">Nothing scheduled in this semester yet.</div>
        {/if}
        <button class="card-action" onclick={() => onNavigate("deadlines")}><CalendarDays size={13} /> Manage</button>
      </div>
    </div>

    <section class="atl-band">
      <div class="atl-band-head">
        <h3>Subjects</h3>
        <p class="atl-band-note">
          {overview.subjects.length} subject{overview.subjects.length === 1 ? "" : "s"} · attention flags are
          derived, never guessed
        </p>
      </div>
      {#if overview.subjects.length === 0}
        <div class="cf-empty">
          <BookOpen size={26} />
          <h3>No subjects yet</h3>
          <p>Subjects are created in the Degree planner, under a semester.</p>
        </div>
      {:else}
        <div class="subject-list">
          {#each overview.subjects as s (s.subjectId)}
            <button class="subject-row" onclick={() => onOpenSubject(s.subjectId)} title="Open subject workspace">
              <span class="s-name">{s.name}{#if s.code} <span class="s-code">{s.code}</span>{/if}</span>
              <span class="s-grade">
                {#if s.graded}{s.gradePoint.toFixed(1)} GP{:else}<span class="muted">ungraded</span>{/if}
              </span>
              <span class="s-status {s.status}">{subjectStatusLabel(s.status)}</span>
              <span class="s-attention">
                {#each s.attention as flag}<span class="flag">{flag}</span>{/each}
              </span>
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .semester-progress { display: flex; flex-direction: column; gap: var(--space-5); min-width: 0; }

  .back-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 0;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    cursor: pointer;
  }
  .back-btn:hover { color: var(--atlas-ink); }

  .sp-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .sp-id { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .trail { text-transform: uppercase; }
  .sp-head h2 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .status-badge {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 1px 7px;
    border-radius: var(--radius-full);
    white-space: nowrap;
  }
  .status-badge.completed { background: var(--atlas-ok-bg); color: var(--atlas-ok); }
  .status-badge.in-progress { background: var(--atlas-signal-soft); color: var(--atlas-signal); }
  .status-badge.upcoming { background: var(--atlas-wash-2); color: var(--atlas-ink-3); }

  .readout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    background: var(--atlas-panel);
    overflow: hidden;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: var(--space-3) var(--space-4);
    min-width: 0;
  }
  .card + .card { border-left: 1px solid var(--atlas-line); }

  .card-head {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
  }
  .card-main {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--atlas-ink);
    font-variant-numeric: tabular-nums;
  }
  .card-main.urgent { color: var(--atlas-bad); }
  .card-main.muted { color: var(--atlas-ink-3); font-weight: 500; font-size: var(--text-md); }
  .card-sub {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    font-variant-numeric: tabular-nums;
    text-align: left;
  }
  .card-sub.link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--atlas-signal);
    cursor: pointer;
  }
  .card-sub.link:hover { text-decoration: underline; }
  .card-action {
    align-self: flex-start;
    margin-top: var(--space-2);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 9px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .card-action:hover { color: var(--atlas-ink); border-color: var(--atlas-line-2); }

  .atl-band-head h3 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--atlas-ink); }

  .subject-list { display: flex; flex-direction: column; }

  .subject-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto minmax(0, 1.4fr) auto;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    text-align: left;
    background: none;
    border: 0;
    border-top: 1px solid var(--atlas-line);
    border-radius: var(--radius-xs);
    color: var(--atlas-ink-2);
    cursor: pointer;
    font: inherit;
  }
  .subject-row:hover { background: var(--atlas-wash); }

  .s-name {
    color: var(--atlas-ink);
    font-size: var(--text-md);
    font-weight: 550;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .s-code { color: var(--atlas-ink-3); font-family: var(--font-mono); font-size: var(--text-micro); }
  .s-grade { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--atlas-ink-2); font-variant-numeric: tabular-nums; }
  .s-status {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 1px 7px;
    border-radius: var(--radius-full);
    white-space: nowrap;
  }
  .s-status.done { background: var(--atlas-ok-bg); color: var(--atlas-ok); }
  .s-status.in_progress { background: var(--atlas-signal-soft); color: var(--atlas-signal); }
  .s-status.pending { background: var(--atlas-wash-2); color: var(--atlas-ink-3); }

  .s-attention { display: flex; gap: 6px; flex-wrap: wrap; }
  .flag {
    font-size: var(--text-xs);
    padding: 1px 7px;
    border-radius: var(--radius-full);
    background: var(--atlas-warn-bg);
    color: var(--atlas-warn);
    white-space: nowrap;
  }
  .muted { color: var(--atlas-ink-3); }
  .skel { height: 140px; }

  @media (max-width: 900px) {
    .card + .card { border-left: 0; border-top: 1px solid var(--atlas-line); }
    .subject-row { grid-template-columns: minmax(0, 1fr) auto auto; }
    .s-attention, .s-grade { display: none; }
  }
</style>
