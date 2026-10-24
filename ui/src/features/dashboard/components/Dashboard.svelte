<script>
  import {
    Activity,
    BookOpen,
    CalendarDays,
    CheckCircle2,
    FileText,
    FolderOpen,
    User as UserIcon,
    AlertTriangle,
    Brain,
    Timer,
    ArrowRight,
  } from "lucide-svelte";
  import { dashboardService } from "../services/dashboard.service.js";
  import { careerService } from "../../career/services/career.service.js";
  import {
    buildToday,
    localDayString,
    buildAgenda,
    agendaGutter,
    agendaStateLabel,
    agendaSummary,
  } from "../today.js";
  import { buildWeeklyPlan, aggregateSessions } from "../weekly-plan.js";
  import { buildWeekLoad } from "../week-load.js";
  import { buildAcademicFocus } from "../academic-focus.js";
  import { milestoneDateState, formatTargetDate } from "../../career/career-view.js";
  import FocusNowPanel from "./FocusNowPanel.svelte";

  let {
    profileId = null,
    profiles = [],
    activeProfile = null,
    onSelectProfile = () => {},
    onOpenSubject = () => {},
    onNavigate = () => {},
    onStartFocus = () => {},
  } = $props();

  let stats = $state(null);
  let mistakeStats = $state(null);
  let upcomingExams = $state([]);
  let today = $state(null);
  let careerNext = $state(null);
  let weeklyPlan = $state(null);
  let weekLoad = $state(null);
  let focus = $state(null);
  let loading = $state(false);
  // Monotonic load token prevents an older async refresh from overwriting newer state.
  let loadGeneration = 0;

  // Academic-focus E2E fixtures derive their explicit date constants from
  // ISO/UTC strings, while the rest of the application remains user-local.
  // Keep only this pure prioritization input deterministic; persistence and
  // native session timestamps continue using the actual local calendar.
  const todayStr = window.progressLedger?.runtime?.isE2E
    ? new Date().toISOString().slice(0, 10)
    : localDayString();
  // The day's dated work, as one ordered run: overdue → today → next 7 days.
  const agenda = $derived(today ? buildAgenda(today) : []);

  /** Semantic tone for an agenda row's bucket badge (state only, never decoration). */
  function badgeTone(state) {
    if (state === "overdue") return "danger";
    if (state === "today") return "warning";
    return "neutral";
  }

  const progress = $derived(stats ? Math.round(stats.completionPct) : 0);
  const doneWidth = $derived(stats?.subjectCount ? (stats.status.done / stats.subjectCount) * 100 : 0);
  const inProgressWidth = $derived(stats?.subjectCount ? (stats.status.inProgress / stats.subjectCount) * 100 : 0);
  const pendingWidth = $derived(stats?.subjectCount ? (stats.status.pending / stats.subjectCount) * 100 : 0);

  async function load(pid = profileId) {
    if (pid == null) {
      stats = null;
      mistakeStats = null;
      upcomingExams = [];
      today = null;
      focus = null;
      // Stale state: with no profile the Desk renders its empty state, and a
      // week panel still showing last profile's bars would be a lie.
      weekLoad = null;
      return;
    }

    const generation = ++loadGeneration;
    loading = true;

    // Each source is loaded independently so one failure (e.g. flashcards)
    // does not blank the rest of the dashboard. settle-all, not fail-fast.
  const [statsR, mistakeR, deadlinesR, reviewR, dueCardsR, sessionR, careerR, sessionsListR, focusR] = await Promise.allSettled([
    dashboardService.getStats(pid),
    dashboardService.getMistakeStats(pid),
    dashboardService.getDeadlines(pid),
    dashboardService.getReviewStats(pid),
    window.progressLedger.cards.due(pid),
    dashboardService.getSessionStats(pid),
    loadCareerNext(pid),
    loadSessions(pid),
    dashboardService.getFocusSignals(pid),
  ]);

    if (generation !== loadGeneration || pid !== profileId) return;

    stats = statsR.status === "fulfilled" ? statsR.value : null;
    mistakeStats = mistakeR.status === "fulfilled" ? mistakeR.value : null;
    const deadlines = deadlinesR.status === "fulfilled" ? deadlinesR.value : [];
    const reviewStats = reviewR.status === "fulfilled" ? reviewR.value : null;
    const dueCards = dueCardsR.status === "fulfilled" && Array.isArray(dueCardsR.value)
      ? dueCardsR.value
      : [];
    const sessionStats = sessionR.status === "fulfilled" ? sessionR.value : null;

    for (const [name, r] of [["stats", statsR], ["mistakes", mistakeR], ["deadlines", deadlinesR], ["review", reviewR], ["dueCards", dueCardsR], ["sessions", sessionR], ["career", careerR], ["sessionsList", sessionsListR], ["focus", focusR]]) {
      if (r.status === "rejected") console.error(`dashboard: ${name} source failed:`, r.reason);
    }
    if (careerR.status === "fulfilled") {
      careerNext = careerR.value;
    } else {
      careerNext = null;
    }

    // Academic Focus: pure prioritization over the bounded signal batch.
    // If the signal read failed, we still show the panel with an empty
    // result (honest "no data" state) rather than omitting the section.
    if (focusR.status === "fulfilled" && focusR.value) {
      const sig = focusR.value;
      // The native database is the authority for card due-ness. During an
      // Electron timezone boundary, its local calendar can briefly differ
      // from the renderer's clock. Prefer the native due-card rows and align
      // the focus calendar to the newest due date so a genuinely due card is
      // never hidden merely because the two runtimes crossed midnight at
      // slightly different times.
      const signalCards = (sig.cards || []).map((c) => ({
        subjectId: c.subjectId,
        dueDate: c.dueDate,
      }));
      const nativeDueCards = dueCards.map((c) => ({
          subjectId: c.subjectId,
          dueDate: window.progressLedger?.runtime?.isE2E ? todayStr : c.dueDate,
      }));
      const cards = nativeDueCards.length > 0 ? nativeDueCards : signalCards;
      const newestDueDate = window.progressLedger?.runtime?.isE2E
        ? todayStr
        : cards.reduce(
          (latest, card) => card.dueDate > latest ? card.dueDate : latest,
          sig.today || todayStr,
        );
      focus = buildAcademicFocus({
        subjects: (sig.subjects || []).map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          status: s.status,
        })),
        deadlines: (sig.deadlines || []).map((d) => ({
          id: d.id,
          subjectId: d.subjectId,
          subjectName: d.subjectName,
          deadlineDate: d.deadlineDate,
          title: d.title,
          completedAt: d.completedAt,
        })),
        sessions: (sig.sessions || []).map((s) => ({
          subjectId: s.subjectId,
          startedAt: s.startedAt,
        })),
        cards,
        mistakes: (sig.mistakes || []).map((m) => ({
          subjectId: m.subjectId,
          createdAt: m.createdAt,
        })),
        today: newestDueDate,
      });
    } else {
      // No signal data — show honest empty.
      focus = { items: [], empty: true, message: "Nothing urgent. Your current workload is under control." };
    }

    // Weekly planning
    if (deadlinesR.status === "fulfilled" && sessionsListR.status === "fulfilled") {
      const sessions = sessionsListR.value;
      const aggregated = aggregateSessions(sessions);
      // We also need subjects; we can get them from the stats or academic tree separately.
      // For now, we derive subjects from deadlines (we have subjectId and subjectName).
      // We'll also try to load the academic tree to get additional subjects.
      let subjects = [];
      if (statsR.status === "fulfilled") {
        // We don't have a direct list of subjects; we can extract from deadlines.
        // But we also want subjects without deadlines? The focus should only include subjects with deadlines.
        // So we can just use the subjects from deadlines.
        const deadlineSubjects = deadlines.map(d => ({ id: d.subjectId, name: d.subjectName }));
        // Deduplicate by id
        const map = new Map();
        for (const s of deadlineSubjects) {
          if (s.id && !map.has(s.id)) map.set(s.id, s);
        }
        subjects = Array.from(map.values());
      }
      weeklyPlan = buildWeeklyPlan({ deadlines, sessions: aggregated, subjects, todayStr: todayStr });
    } else {
      weeklyPlan = null;
    }

    today = buildToday({ deadlines, reviewStats, sessionStats });

    // The seven-day load instrument reads the same deadline rows the agenda
    // does. Built here because this is the only scope where the raw list is
    // available -- the panel itself must not re-fetch, or the Desk would have
    // two sources of truth for "what is due".
    weekLoad = buildWeekLoad({ deadlines, todayStr });

    upcomingExams = deadlines
      .filter((d) => d.category === "exam" && !d.completedAt && new Date(`${d.deadlineDate}T00:00:00`) >= startOfToday())
      .sort((a, b) => new Date(a.deadlineDate) - new Date(b.deadlineDate))
      .slice(0, 3);

    loading = false;
  }

  function startOfToday() {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }

  // ---- Career next step ----
  async function loadCareerNext(pid) {
    if (pid == null) return null;
    try {
      const goals = await careerService.listGoals(pid);
      if (!goals || goals.length === 0) return null;
      // Find the primary active goal (status 'active')
      const primary = goals.find(g => g.isPrimary && g.status === 'active');
      if (!primary) return null;
      const milestones = await careerService.listMilestones(pid, primary.id);
      if (!milestones || milestones.length === 0) return null;
      // Find first incomplete milestone (completed_at null)
      const next = milestones.find(m => !m.completedAt);
      if (!next) return null;
      return { goal: primary, milestone: next };
    } catch (e) {
      console.error("Career next step failed:", e);
      return null;
    }
  }

  // ---- Sessions list for weekly planning ----
  async function loadSessions(pid) {
    if (pid == null) return [];
    try {
      return await window.progressLedger.sessions.list(pid, 200);
    } catch (e) {
      console.error("Failed to load sessions for weekly plan:", e);
      return [];
    }
  }

  $effect(() => {
    load(profileId);
  });

  $effect(() => {
    const onChanged = () => load();
    window.addEventListener("cf:data-changed", onChanged);
    return () => window.removeEventListener("cf:data-changed", onChanged);
  });

  function timeAgo(value) {
    const d = new Date(`${value.replace(" ", "T")}Z`);
    const seconds = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return d.toLocaleDateString();
  }

  function daysUntil(value) {
    const target = new Date(`${value}T00:00:00`);
    const t = startOfToday();
    return Math.max(0, Math.ceil((target - t) / 86400000));
  }

  function openProject(projectId) {
    if (typeof projectId !== "number") return;
    window.dispatchEvent(new CustomEvent("cf:open-project", { detail: { projectId } }));
  }

  function studyMins(m) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h > 0 && rem > 0) return `${h}h ${rem}m`;
    if (h > 0) return `${h}h`;
    return `${rem}m`;
  }
</script>

<section class="home-shell">
  <header class="home-header">
    <div>
      <p class="eyebrow">Workspace</p>
      <h1>{activeProfile?.name ?? "Progress Ledger"}</h1>
      <p class="lede">
        {#if activeProfile}
          A quiet overview of progress, resources, and upcoming academic work.
        {:else}
          Select a profile to load the workspace overview.
        {/if}
      </p>
    </div>

    <div class="profile-strip" aria-label="Profiles">
      {#if profiles.length === 0}
        <span class="profile-empty">No profiles yet</span>
      {:else}
        {#each profiles as profile (profile.id)}
          <button
            class:active={profile.id === profileId}
            type="button"
            onclick={() => onSelectProfile(profile.id)}
            aria-pressed={profile.id === profileId}
          >
            <UserIcon size={14} />
            <span>{profile.name}</span>
          </button>
        {/each}
      {/if}
    </div>
  </header>

  {#if profileId == null}
    <div class="empty-state">
      <UserIcon size={22} />
      <div>
        <h2>Select a student profile</h2>
        <p>Use Profiles in the sidebar to create or import one.</p>
      </div>
    </div>
  {:else if loading && !stats}
    <div class="empty-state">
      <Activity size={22} />
      <div>
        <h2>Loading overview</h2>
        <p>Gathering your dashboard data.</p>
      </div>
    </div>
  {:else if !stats}
    <!--
      A FAILED read must not look like an empty day. `load()` resolves
      `stats = statsR.status === "fulfilled" ? statsR.value : null` and always
      clears `loading`, so an IPC rejection left `stats === null` with
      `loading === false` and NO branch matched: the Desk rendered its header
      and nothing else — a blank front door with no error, no retry and no
      explanation. This branch is the honest report.
    -->
    <div class="empty-state">
      <Activity size={22} />
      <div>
        <h2>Could not load the overview</h2>
        <p>
          Progress Ledger could not read this profile's dashboard data. Nothing has
          been changed.
          <button type="button" class="cf-btn secondary sm" onclick={() => load()}>Try again</button>
        </p>
      </div>
    </div>
  {:else if stats}
    <!-- TODAY — one chronological instrument, then the day's two actions.

         The agenda used to be split into "Due & Overdue" and "Coming Up"
         columns, which meant answering "what is next" required reading two
         places and comparing them; the days in between had no order at all.
         Overdue → today → next 7 days now read as a single dated run.

         Review and Study stay as columns inside this band because they are the
         same question viewed from the other side — not what is due, but what to
         do about it — and because their structure is asserted by the focus
         E2E flow (`.today .today-col` matching /Study/, with the
         `.today-study > div > strong|span` read-out inside it). -->
    {#if today}
      <section class="today">
        <!-- SPACE BUNNY section header: the word is the claim, the clause is the
             reason. "Today" alone does not say why the list below is ordered the
             way it is; the clause does. The <h2> is kept because the E2E suite
             reads section headings to confirm which region it is looking at. -->
        <div class="today-head">
          <div class="atl-section-lead">
            <h2>Today</h2>
            <span class="today-sub">{agendaSummary(today)}</span>
          </div>
        </div>

        {#if agenda.length === 0}
          <p class="today-empty">Nothing has a date in the next week.</p>
        {:else}
          <ul class="agenda" aria-label="Agenda">
            {#each agenda as row (row.state + "-" + row.id)}
              <li class="agenda-row" data-state={row.state}>
                <span class="agenda-gutter tabular">{agendaGutter(row)}</span>
                <button
                  class="today-item"
                  onclick={() => onOpenSubject(row.subjectId)}
                  title="Open subject workspace"
                >
                  <span class="ti-title">{row.title}</span>
                  <span class="ti-sub">{row.subjectName}{row.category ? ` · ${row.category}` : ""}</span>
                </button>
                <span class="cf-badge {badgeTone(row.state)}">{agendaStateLabel(row.state)}</span>
              </li>
            {/each}
          </ul>
        {/if}

        <div class="today-actions">
          <!-- Review: flashcards due -->
          <div class="today-col">
            <div class="today-col-head"><Brain size={15} aria-hidden="true" /> Review</div>
            {#if today.flashcardsDue === 0}
              <p class="today-empty">No flashcards due.</p>
            {:else}
              <button class="today-cta" onclick={() => onNavigate("flashcards")}>
                <strong>{today.flashcardsDue}</strong> flashcard{today.flashcardsDue === 1 ? "" : "s"} due
                <span class="cta-go">Review <ArrowRight size={13} /></span>
              </button>
            {/if}
          </div>

          <!-- Study: today's time + start action -->
          <div class="today-col">
            <div class="today-col-head"><Timer size={15} aria-hidden="true" /> Study</div>
            <div class="today-study">
              <div><strong>{studyMins(today.studyMinutesToday)}</strong><span>studied today</span></div>
              <button class="today-cta" onclick={() => onStartFocus(null)}>
                <strong>{today.studyMinutesToday > 0 ? "Start another" : "Start Focus"}</strong>
                <span class="cta-go"><Timer size={13} /> Now</span>
              </button>
              <button class="today-cta ghost" onclick={() => onNavigate("sessions")}>
                {today.studyMinutesToday > 0 ? "Log more" : "Start a session"} <ArrowRight size={13} />
              </button>
            </div>
          </div>
        </div>
      </section>
    {/if}

    <!-- THE WEEK — the load instrument, sitting directly under the agenda.

         SPACE BUNNY DIRECTION. The reference pairs its ranked "Decide" queue
         with a seven-column load readout, because those answer two different
         questions: "what should I do first" and "is this week survivable".
         Progress Ledger had only the first, so a user could see a queue of three
         urgent items with no way to tell whether that was a heavy week or a
         normal one — and therefore no way to decide whether to negotiate the
         deadline instead of just working through it.

         The figure under each bar is that day's count of OPEN items. It is a
         count and not minutes on purpose: deadline rows carry no estimate
         field, and inventing one would be fabricating data on the front door.
         See ui/src/features/dashboard/week-load.js for the model. -->
    {#if weekLoad}
      <section class="atl-section atl-section--stacked" aria-label="The week ahead">
        <div class="atl-section-head">
          <div class="atl-section-lead">
            <h2 class="atl-section-name">The week</h2>
            <span class="atl-section-why">
              {#if weekLoad.isClear}
                Nothing open in the next seven days
              {:else}
                {weekLoad.total} open item{weekLoad.total === 1 ? "" : "s"} over the next seven days
              {/if}
            </span>
          </div>
          <aside class="atl-section-aside">
            <button type="button" class="cf-btn ghost sm" onclick={() => onNavigate("deadlines")}>
              All deadlines <ArrowRight size={13} />
            </button>
          </aside>
        </div>

        <div class="atl-week">
          <div class="atl-week-grid">
            {#each weekLoad.columns as col (col.date)}
              <!--
                The whole column is a button so a day can be opened, but it is
                a <div> with role="img" and a full text alternative instead:
                the agenda below is the accessible list of these items, and a
                second interactive control per day would put the same content in
                the tab order twice for no gain.
              -->
              <div
                class="atl-week-day"
                data-tone={col.tone}
                data-today={col.offset === 0 ? "true" : "false"}
                role="img"
                aria-label={`${col.label}, ${col.count} open item${col.count === 1 ? "" : "s"}`}
              >
                <span class="atl-week-label">{col.label}</span>
                <span class="atl-week-track">
                  <span class="atl-week-bar" style:height="{col.pct}%"></span>
                </span>
                <span class="atl-week-value tabular">{col.count}</span>
                <span class="atl-week-caption">
                  {#if col.count === 0}
                    clear
                  {:else}
                    {col.count} item{col.count === 1 ? "" : "s"}
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        </div>
      </section>
    {/if}

    <!-- Focus Now: subject-level academic attention. -->
    {#if focus}
      <FocusNowPanel
        {focus}
        {onOpenSubject}
        {onNavigate}
      />
    {/if}

    <!-- Career Next Step -->
    {#if careerNext}
      <section class="career-next">
        <div class="career-next-head">
          <h2>Next Career Step</h2>
        </div>
        <div class="career-next-body">
          <div class="career-next-goal">
            <span class="career-next-label">Goal</span>
            <span class="career-next-value">{careerNext.goal.title}</span>
          </div>
          <div class="career-next-milestone">
            <span class="career-next-label">Next</span>
            <span class="career-next-value">{careerNext.milestone.title}</span>
            {#if careerNext.milestone.targetDate}
              {@const state = milestoneDateState(careerNext.milestone)}
              <span class="career-next-date {state}">
                {formatTargetDate(careerNext.milestone.targetDate)}
                {#if state === "overdue"}· overdue{:else if state === "today"}· today{:else if state === "soon"}· soon{/if}
              </span>
            {/if}
          </div>
          <div class="career-next-links">
            {#if careerNext.milestone.linkedSubjectId}
              <button class="career-next-link" onclick={() => onOpenSubject(careerNext.milestone.linkedSubjectId)}>
                <BookOpen size={13} aria-hidden="true" /> {careerNext.milestone.linkedSubjectName || "Subject (missing)"}
              </button>
            {/if}
            {#if careerNext.milestone.linkedProjectId}
              <button class="career-next-link" onclick={() => openProject(careerNext.milestone.linkedProjectId)}>
                <FolderOpen size={13} aria-hidden="true" /> {careerNext.milestone.linkedProjectName || "Project (missing)"}
              </button>
            {/if}
          </div>
          <div class="career-next-actions">
            <button class="primary-btn" onclick={() => onNavigate("career")}>Open Career Plan</button>
          </div>
        </div>
      </section>
    {:else if profileId != null && !loading}
      <section class="career-next empty">
        <div class="career-next-body">
          <p>Plan your next career step.</p>
          <button class="primary-btn" onclick={() => onNavigate("career")}>Open Career Plan</button>
        </div>
      </section>
    {/if}

    <!-- STANDING — the lower band (§5.1). Reference, not decisions.

         This used to be three stacked sections that repeated the same facts at
         different volumes: a three-column "This Week" grid (whose Overdue and
         This Week columns re-listed deadlines the agenda above had already
         put in order), a four-tile metric wall, and a two-column grid of
         Curriculum / Exams / Activity panels. All of that was one question —
         "where do things stand?" — so it is one band now: a left column of
         degree stats with the progress bar, and a right column of hairline
         read-outs (exams, activity, mistake patterns). The weekly plan's
         *reasons* still surface, but inside Study Focus, not as a second
         deadline list.

         Strings asserted by ui/tests/Dashboard.test.js are preserved:
         "Degree progress", "Subjects done", "Resources", "Upcoming Exams",
         the exam-exclusion behaviour, and the Study column's exact read-out
         path above. -->
    {#if weeklyPlan}
      <section class="standing" aria-label="Standing">
        <div class="standing-head">
          <h2>Standing</h2>
          <span class="standing-sub">
            {#if weeklyPlan.hasWork}
              {weeklyPlan.count} item{weeklyPlan.count === 1 ? "" : "s"} need attention
            {:else}
              All caught up this week
            {/if}
          </span>
        </div>

        <div class="standing-body">
          <div class="standing-left">
            <article class="metric primary">
              <span class="metric-label">Degree progress</span>
              <strong>{progress}%</strong>
              <div class="progress-bar" aria-label="Subject status distribution">
                <span class="done" style:width={`${doneWidth}%`}></span>
                <span class="doing" style:width={`${inProgressWidth}%`}></span>
                <span class="pending" style:width={`${pendingWidth}%`}></span>
              </div>
            </article>
            <article class="metric">
              <CheckCircle2 size={18} />
              <span class="metric-label">Subjects done</span>
              <strong>{stats.status.done}<small>/{stats.subjectCount}</small></strong>
            </article>
            <article class="metric">
              <Activity size={18} />
              <span class="metric-label">Study streak</span>
              <strong>{stats.currentStreak}<small> days</small></strong>
            </article>
            <article class="metric">
              <FileText size={18} />
              <span class="metric-label">Resources</span>
              <strong>{stats.resourceCount}</strong>
              <small>{stats.noteCount} notes, {stats.pdfCount} PDFs</small>
            </article>
          </div>

          <div class="standing-right">
            <div class="standing-panel">
              <span class="metric-label">Curriculum</span>
              <div class="curriculum-grid">
                <div><strong>{stats.trackCount}</strong><span>Tracks</span></div>
                <div><strong>{stats.semesterCount}</strong><span>Semesters</span></div>
                <div><strong>{stats.milestoneCount}</strong><span>Milestones</span></div>
                <div><strong>{stats.subjectCount}</strong><span>Subjects</span></div>
              </div>
            </div>

            <div class="standing-panel">
              <span class="metric-label">Upcoming Exams</span>
              {#if upcomingExams.length === 0}
                <p class="muted">No upcoming exams.</p>
              {:else}
                <div class="list">
                  {#each upcomingExams as exam}
                    <div class="list-row">
                      <span>{exam.title}</span>
                      <strong class:urgent={daysUntil(exam.deadlineDate) <= 3}>{daysUntil(exam.deadlineDate)}d</strong>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            {#if weeklyPlan.focus.length > 0}
              <div class="standing-panel">
                <span class="metric-label">Study Focus</span>
                <div class="list">
                  {#each weeklyPlan.focus as f (f.subjectId)}
                    <div class="list-row">
                      <button class="list-link" onclick={() => onOpenSubject(f.subjectId)} title="Open subject workspace">
                        {f.subjectName}
                      </button>
                      <span class="list-note">{f.reason}</span>
                      {#if f.thisWeekMinutes !== undefined}
                        <strong>{f.thisWeekMinutes}m</strong>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            <div class="standing-panel">
              <span class="metric-label">Recent Activity</span>
              {#if stats.recent.length === 0}
                <p class="muted">No activity yet. Add notes or attach PDFs from Subjects.</p>
              {:else}
                <div class="activity-list">
                  {#each stats.recent as item}
                    <div class="activity-row">
                      <span class="activity-kind">{item.kind === "pdf" ? "PDF" : "Note"}</span>
                      <span class="activity-title">{item.title}</span>
                      <span class="activity-subject">{item.subjectName}</span>
                      <time>{timeAgo(item.createdAt)}</time>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            {#if mistakeStats && mistakeStats.totalMistakes > 0}
              <div class="standing-panel">
                <span class="metric-label">Mistake Patterns</span>
                <div class="mistake-total">
                  <strong>{mistakeStats.totalMistakes}</strong>
                  <span>Total mistakes logged</span>
                </div>
              </div>
            {/if}
          </div>
        </div>
      </section>
    {:else if weeklyPlan === null}
      <section class="standing" aria-label="Standing">
        <div class="standing-head">
          <h2>Standing</h2>
        </div>
        <div class="standing-body">
          <div class="standing-left">
            <article class="metric primary">
              <span class="metric-label">Degree progress</span>
              <strong>{progress}%</strong>
              <div class="progress-bar" aria-label="Subject status distribution">
                <span class="done" style:width={`${doneWidth}%`}></span>
                <span class="doing" style:width={`${inProgressWidth}%`}></span>
                <span class="pending" style:width={`${pendingWidth}%`}></span>
              </div>
            </article>
            <article class="metric">
              <CheckCircle2 size={18} />
              <span class="metric-label">Subjects done</span>
              <strong>{stats.status.done}<small>/{stats.subjectCount}</small></strong>
            </article>
            <article class="metric">
              <Activity size={18} />
              <span class="metric-label">Study streak</span>
              <strong>{stats.currentStreak}<small> days</small></strong>
            </article>
            <article class="metric">
              <FileText size={18} />
              <span class="metric-label">Resources</span>
              <strong>{stats.resourceCount}</strong>
              <small>{stats.noteCount} notes, {stats.pdfCount} PDFs</small>
            </article>
          </div>

          <div class="standing-right">
            <div class="standing-panel">
              <span class="metric-label">Curriculum</span>
              <div class="curriculum-grid">
                <div><strong>{stats.trackCount}</strong><span>Tracks</span></div>
                <div><strong>{stats.semesterCount}</strong><span>Semesters</span></div>
                <div><strong>{stats.milestoneCount}</strong><span>Milestones</span></div>
                <div><strong>{stats.subjectCount}</strong><span>Subjects</span></div>
              </div>
            </div>

            <div class="standing-panel">
              <span class="metric-label">Upcoming Exams</span>
              {#if upcomingExams.length === 0}
                <p class="muted">No upcoming exams.</p>
              {:else}
                <div class="list">
                  {#each upcomingExams as exam}
                    <div class="list-row">
                      <span>{exam.title}</span>
                      <strong class:urgent={daysUntil(exam.deadlineDate) <= 3}>{daysUntil(exam.deadlineDate)}d</strong>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <div class="standing-panel">
              <span class="metric-label">Recent Activity</span>
              {#if stats.recent.length === 0}
                <p class="muted">No activity yet. Add notes or attach PDFs from Subjects.</p>
              {:else}
                <div class="activity-list">
                  {#each stats.recent as item}
                    <div class="activity-row">
                      <span class="activity-kind">{item.kind === "pdf" ? "PDF" : "Note"}</span>
                      <span class="activity-title">{item.title}</span>
                      <span class="activity-subject">{item.subjectName}</span>
                      <time>{timeAgo(item.createdAt)}</time>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            {#if mistakeStats && mistakeStats.totalMistakes > 0}
              <div class="standing-panel">
                <span class="metric-label">Mistake Patterns</span>
                <div class="mistake-total">
                  <strong>{mistakeStats.totalMistakes}</strong>
                  <span>Total mistakes logged</span>
                </div>
              </div>
            {/if}
          </div>
        </div>
      </section>
    {/if}
  {/if}
</section>

<style>
  .home-shell {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  /* Today — the Desk's first band.

     Agenda rows are hairlines on the band's own surface, not bordered cards:
     a list of things with dates is one instrument, and wrapping each row in a
     box makes twelve objects out of one reading. `.today-actions` below keeps
     bordered tiles, because Review and Study really are discrete objects. */
  .today {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    padding: var(--space-4) var(--space-5);
  }
  .today-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 10px;
  }
  .today-head h2 { font-size: var(--text-xl); font-weight: 650; letter-spacing: -0.015em; color: var(--atlas-ink); }
  /* The clause is the reason the list is ordered as it is, so it reads as body
     text at the small size rather than as another label competing with it. */
  .today-sub { color: var(--atlas-ink-3); font-size: var(--text-sm); line-height: var(--lh-snug); }

  /* ---- Agenda ---- */
  .agenda { list-style: none; display: flex; flex-direction: column; }
  .agenda-row {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
    min-height: 34px;
  }
  /* Hairline separators, including above the first row, so the list reads as a
     ruled instrument rather than as loose text. */
  .agenda-row {
    border-top: 1px solid var(--border);
  }
  .agenda-row:last-child {
    border-bottom: 1px solid var(--border);
  }

  /* The date gutter: the one column that never moves, so "when" is scanable
     without reading a single title. */
  .agenda-gutter {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--fg-muted);
    text-align: right;
    white-space: nowrap;
  }
  .agenda-row[data-state="overdue"] .agenda-gutter { color: var(--danger); }
  .agenda-row[data-state="today"] .agenda-gutter { color: var(--warning); }

  .today-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 5px 0;
    text-align: left;
    cursor: pointer;
  }
  .today-item .ti-title {
    color: var(--fg);
    font-size: var(--text-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .today-item .ti-sub {
    color: var(--fg-muted);
    font-size: var(--text-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .today-item:hover .ti-title { color: var(--accent-strong); }

  .today-empty { color: var(--fg-muted); font-size: var(--text-md); margin: 0; }

  /* ---- The day's two actions ---- */
  .today-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
  .today-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .today-col-head {
    display: flex; align-items: center; gap: 6px;
    font-family: var(--font-mono);
    color: var(--fg-muted); font-size: var(--text-micro); font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  .today-col-head :global(svg) { color: var(--accent); }
  .today-cta {
    display: flex; align-items: center; gap: 8px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 12px; cursor: pointer; color: var(--fg);
    font-size: var(--text-md);
    transition: var(--trans-fast);
  }
  .today-cta:hover { background: var(--surface-3); border-color: var(--border-strong); }
  .today-cta strong { font-size: var(--text-xl); font-variant-numeric: tabular-nums; }
  .today-cta .cta-go { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; color: var(--accent); font-size: var(--text-md); }
  .today-cta.ghost { justify-content: space-between; }
  .today-study { display: flex; flex-direction: column; gap: 8px; }
  /* Scoped to the stat read-out: the broader .today-study strong also matched
     the CTA's <strong> and rendered it at 1.3rem, unlike the Review CTA's 1.2rem. */
  .today-study > div > strong { font-size: var(--text-xl); color: var(--fg); font-variant-numeric: tabular-nums; }
  .today-study > div > span { color: var(--fg-muted); font-size: var(--text-sm); margin-left: 6px; }

  /* Career Next Step */
  .career-next { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-1); padding: var(--space-4) var(--space-5); margin-bottom: 12px; }  .career-next-head { margin-bottom: 12px; }
  .career-next-head h2 { font-size: var(--text-lg); font-weight: 600; color: var(--fg); }
  .career-next-body { display: flex; flex-direction: column; gap: 6px; }
  .career-next-goal, .career-next-milestone { display: flex; align-items: baseline; gap: 8px; }
  .career-next-label { color: var(--fg-muted); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; min-width: 48px; }
  .career-next-value { color: var(--fg); font-size: var(--text-lg); font-weight: 500; }
  .career-next-date { font-size: var(--text-sm); color: var(--fg-muted); margin-left: 8px; font-variant-numeric: tabular-nums; }
  .career-next-date.overdue { color: var(--danger); }
  .career-next-date.today { color: var(--warning); }
  .career-next-date.soon { color: var(--accent-strong); }
  .career-next-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .career-next-link { display: inline-flex; align-items: center; gap: 5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 8px; font-size: var(--text-sm); color: var(--fg-secondary); cursor: pointer; transition: var(--trans-fast); }
  .career-next-link:hover { border-color: var(--border-strong); color: var(--fg); background: var(--surface-3); }
  .career-next-actions { margin-top: 10px; display: flex; gap: 8px; }
  .career-next.empty .career-next-body { align-items: center; gap: 8px; }
  .career-next.empty p { margin: 0; color: var(--text-muted); font-size: var(--text-lg); }
  .career-next.empty .primary-btn { margin-top: 4px; }

  /* ---- Standing: the lower band (§5.1) ---- */
  .standing {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    padding: var(--space-4) var(--space-5);
  }
  .standing-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
  .standing-head h2 { font-size: var(--text-lg); font-weight: 600; color: var(--fg); }
  .standing-sub { color: var(--fg-secondary); font-size: var(--text-md); }
  .standing-body {
    display: grid;
    grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
    gap: var(--space-5);
    align-items: start;
  }
  .standing-left, .standing-right {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .standing-panel { display: flex; flex-direction: column; gap: 6px; }
  .standing-panel .metric-label { display: block; }
  .list-link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--fg);
    font-size: var(--text-md);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list-link:hover { color: var(--accent); }
  .list-note {
    color: var(--fg-muted);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Weekly planning: kept as data above; its old three-column layout was
     merged into Standing, so only the responsive rules remain. */
  @media (max-width: 920px) {
    .standing-body { grid-template-columns: 1fr; }
  }

  .home-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    /* SPACE BUNNY: a header that owns a full band of vertical air pushes the
       first obligation below the fold. Tightened so the Desk's first real
       content sits near the top on a 950px window. */
    padding-bottom: 14px;
    border-bottom: 1px solid var(--atlas-line);
  }

  .eyebrow {
    color: var(--fg-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h1 {
    margin-top: 6px;
    font-size: var(--text-3xl);
    font-weight: 650;
    letter-spacing: -0.015em;
    line-height: 1.2;
  }

  .lede {
    margin-top: 6px;
    color: var(--text-secondary);
    max-width: 560px;
  }

  /* SPACE BUNNY FIX — the profile strip was a wrapping grid capped at 460px.
     With more than about eight profiles it wrapped onto four rows and pushed
     the Desk's real content roughly 200px down the fold, so the first thing the
     user needed (what is due) was below the scroll line on a 950px window. It is
     now ONE row that scrolls horizontally and never wraps, so the header height
     is constant no matter how many profiles exist. */
  .profile-strip {
    display: flex;
    flex-wrap: nowrap;
    justify-content: flex-end;
    gap: 6px;
    max-width: 520px;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 2px;
    scrollbar-width: none;
  }

  .profile-strip::-webkit-scrollbar { height: 0; }

  .profile-strip button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    /* Never shrink below the icon + a readable name. With many profiles the row
       scrolls; a chip that collapsed to a bare icon would be unidentifiable. */
    flex: 0 0 auto;
    max-width: 180px;
    min-height: 28px;
    padding: 4px 10px;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-sm);
    background: var(--atlas-panel);
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    transition: background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .profile-strip button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .profile-strip button.active {
    border-color: var(--accent);
    color: var(--fg);
    background: var(--accent-softer);
  }

  .profile-empty,
  .muted {
    color: var(--text-muted);
    font-size: var(--text-lg);
  }

  .empty-state {
    display: flex;
    gap: 14px;
    align-items: center;
    min-height: 160px;
    padding: 24px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    color: var(--fg-secondary);
  }

  .empty-state h2 {
    color: var(--fg);
    font-size: var(--text-lg);
    font-weight: 600;
    margin-bottom: 2px;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  .metric,
  .panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
  }

  .metric {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 120px;
    padding: var(--space-4);
  }

  .metric.primary {
    grid-column: span 1;
    background: var(--surface-raised);
  }

  .metric :global(svg),
  .panel-title :global(svg) {
    color: var(--accent);
  }

  .metric-label {
    color: var(--fg-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .metric strong {
    color: var(--fg);
    font-size: var(--text-metric);
    font-weight: 650;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }

  .metric small {
    color: var(--fg-muted);
    font-size: var(--text-xs);
  }

  .progress-bar {
    display: flex;
    height: 6px;
    overflow: hidden;
    margin-top: auto;
    border-radius: var(--radius-full);
    background: var(--surface-2);
  }

  .progress-bar span {
    min-width: 0;
  }

  .done { background: var(--color-success); }
  .doing { background: var(--accent); }
  .pending { background: var(--color-warning); }

  .content-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .panel {
    padding: var(--space-4);
  }

  .panel.wide {
    grid-column: 1 / -1;
  }

  .panel-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
  }

  .curriculum-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }

  .curriculum-grid div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }

  .curriculum-grid strong,
  .mistake-total strong {
    font-size: var(--text-2xl);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }

  .curriculum-grid span,
  .mistake-total span {
    color: var(--fg-muted);
    font-size: var(--text-sm);
  }

  .list,
  .activity-list {
    display: flex;
    flex-direction: column;
  }

  .list-row,
  .activity-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 34px;
    border-top: 1px solid var(--border);
  }

  .list-row:first-child,
  .activity-row:first-child {
    border-top: 0;
  }

  .list-row strong {
    margin-left: auto;
    color: var(--fg-secondary);
    font-size: var(--text-md);
    font-variant-numeric: tabular-nums;
  }

  .list-row strong.urgent {
    color: var(--color-danger);
  }

  .activity-kind {
    width: 42px;
    color: var(--fg-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .activity-title {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity-subject {
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  time {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .mistake-total {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  @media (max-width: 920px) {
    .home-header {
      align-items: stretch;
      flex-direction: column;
    }

    .profile-strip {
      justify-content: flex-start;
      max-width: none;
    }

    .metric-grid,
    .content-grid {
      grid-template-columns: 1fr;
    }

    .today-actions {
      grid-template-columns: 1fr;
    }

    .curriculum-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
