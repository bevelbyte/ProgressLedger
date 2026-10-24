<script>
  // Subject Workspace — a Space in the Atlas sense (docs/DESIGN-ATLAS.md §5.2).
  //
  // Structure, top to bottom:
  //   1. IDENTITY   — name, code, trail, status control. Always visible, so the
  //                   user always knows which Space they are inside.
  //   2. READOUT    — three instrument columns (Academic / Study / Upcoming).
  //                   Always visible: orientation is not a face.
  //   3. FACES      — Overview · Work · Knowledge · Sessions · Research ·
  //                   Operator. One body at a time.
  //
  // The readout and identity are persistent by design. A user sweeping faces is
  // changing the *working body*, never losing the numbers that tell them how
  // this subject is doing.
  //
  // Numbers come from one Rust overview call; lists reuse the existing
  // per-feature services. This component composes + quick-logs only — it never
  // reimplements a feature engine.
  import {
    ChevronLeft, FileText, Paperclip, Trash2, Clock, CheckCircle2, Circle,
    GraduationCap, Timer, CalendarDays, Brain, AlertTriangle, StickyNote,
    FlaskConical, Link2, TerminalSquare, ListChecks, CalendarPlus,
  } from "lucide-svelte";
  import { subjectService } from "../services/subject.service.js";
  import { sessionsService } from "../../study-sessions";
  import { labsService } from "../../labs";
  import { updateSubjectStatus } from "../stores/subject.svelte.js";
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { SubjectLinks } from "../../subject-links";
  import { FaceStrip } from "../../../shared/components";
  import { operator, operatorSummary } from "../../../shell/operator.svelte.js";
  import { formatStudyTime, formatGrade, formatCredits, statusLabel, cleanTrackName } from "../subject-view.js";
  import { formatSessionStart } from "../../study-sessions/sessions-view.js";

  // onNavigate(view) lets the workspace hand off to the owning feature
  // (Degree Planner, Study Sessions, Deadlines, Flashcards, Mistakes) instead of
  // duplicating their engines here.
  let { profileId = null, selectedSubject = $bindable(null), onOpenNote = null, onBack = null, onNavigate = () => {}, onStartFocus = null } = $props();

  let activeFace = $state("overview");
  let overview = $state(null);
  let quickMinutes = $state(null);
  let quickBusy = $state(false);
  let resources = $state([]);
  let deadlines = $state([]);
  let cards = $state([]);
  let mistakes = $state([]);
  let labs = $state([]);
  let sessions = $state([]);
  let loading = $state(false);
  let attachBusy = $state(false);
  let loadingId = $state(null);
  let loadGeneration = 0;

  const STATUS_CONFIG = {
    pending: { label: "Pending", color: "var(--atlas-warn)", bg: "var(--atlas-warn-bg)", icon: Circle },
    in_progress: { label: "In Progress", color: "var(--atlas-signal)", bg: "var(--atlas-signal-soft)", icon: Clock },
    done: { label: "Done", color: "var(--atlas-ok)", bg: "var(--atlas-ok-bg)", icon: CheckCircle2 },
  };

  const TODAY = new Date().toISOString().slice(0, 10);

  $effect(() => {
    if (selectedSubject) loadAll(selectedSubject.id);
  });

  async function loadAll(subjectId) {
    const generation = ++loadGeneration;
    loadingId = subjectId;
    loading = true;
    try {
      const [ov, res, dls, cds, mis, labRows, sessionRows] = await Promise.all([
        subjectService.getOverview(profileId, subjectId),
        subjectService.listResources(profileId, subjectId),
        subjectService.listSubjectDeadlines(profileId, subjectId),
        subjectService.listSubjectCards(profileId, subjectId),
        subjectService.listSubjectMistakes(profileId, subjectId),
        labsService.list(profileId, subjectId),
        sessionsService.list(profileId, 500),
      ]);
      if (generation !== loadGeneration || loadingId !== subjectId) return; // a newer load superseded this one
      overview = ov;
      resources = res;
      deadlines = dls;
      cards = cds;
      mistakes = mis;
      labs = labRows ?? [];
      sessions = (sessionRows ?? []).filter((s) => s.subjectId === subjectId);
    } catch (e) {
      if (generation === loadGeneration && loadingId === subjectId) reportError(e, "Could not load subject workspace");
    } finally {
      if (generation === loadGeneration && loadingId === subjectId) loading = false;
    }
  }

  function reload() {
    if (selectedSubject) loadAll(selectedSubject.id);
  }

  // Refresh when notes/resources or any academic/course data changes elsewhere.
  $effect(() => {
    const onResChanged = (e) => {
      if (selectedSubject && e.detail?.subjectId === selectedSubject.id) reload();
    };
    const onDataChanged = () => reload();
    window.addEventListener("cf:resources-changed", onResChanged);
    window.addEventListener("cf:data-changed", onDataChanged);
    return () => {
      window.removeEventListener("cf:resources-changed", onResChanged);
      window.removeEventListener("cf:data-changed", onDataChanged);
    };
  });

  async function cycleStatus() {
    const order = ["pending", "in_progress", "done"];
    const next = order[(order.indexOf(selectedSubject.status) + 1) % order.length];
    try {
      await updateSubjectStatus(profileId, selectedSubject.id, next);
      selectedSubject.status = next;
      reload();
    } catch (e) {
      reportError(e, "Failed to update status");
    }
  }

  async function attachFile() {
    attachBusy = true;
    try {
      const res = await subjectService.attachFile(profileId, selectedSubject.id);
      if (res?.added) reload();
    } catch (e) {
      reportError(e, "Attach failed");
    } finally {
      attachBusy = false;
    }
  }

  // Quick-log study time against this subject. Reuses the Study Sessions
  // engine — this is a shortcut, not a second timer implementation.
  async function quickLogStudy() {
    const mins = Number(quickMinutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      toast.error("Enter minutes greater than zero.");
      return;
    }
    quickBusy = true;
    try {
      await sessionsService.add(profileId, selectedSubject.id, Math.round(mins));
      quickMinutes = null;
      window.dispatchEvent(new Event("cf:data-changed")); // refresh dashboard streak
      toast.success(`Logged ${formatStudyTime(Math.round(mins))} of study.`);
      reload();
    } catch (e) {
      reportError(e, "Could not log study time");
    } finally {
      quickBusy = false;
    }
  }

  async function openResource(r) {
    if (r.kind === "note") onOpenNote?.(r.id, r.subjectId);
    else {
      // Pass the resource id; the main process resolves the file path from
      // the database (the path is a path the user previously attached).
      try { await subjectService.openFile(profileId, r.id); }
      catch (e) { reportError(e, "Could not open file"); }
    }
  }

  async function deleteResource(r) {
    const ok = await confirmDialog({ title: "Delete", message: `Delete "${r.title}"?`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try { await subjectService.deleteResource(profileId, r.id); reload(); }
    catch (e) { reportError(e, "Could not delete"); }
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.valueOf()) ? iso : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
  }

  function daysFromToday(iso) {
    if (!iso) return null;
    const then = new Date(`${iso}T00:00:00`).valueOf();
    if (Number.isNaN(then)) return null;
    const now = new Date(`${TODAY}T00:00:00`).valueOf();
    return Math.round((then - now) / 86400000);
  }

  /** Human date gutter: what matters is how close it is, not the digits. */
  function dueLabel(iso) {
    const d = daysFromToday(iso);
    if (d === null) return { text: iso ?? "", tone: "muted" };
    if (d < 0) return { text: `${Math.abs(d)}d overdue`, tone: "bad" };
    if (d === 0) return { text: "today", tone: "warn" };
    if (d === 1) return { text: "tomorrow", tone: "warn" };
    if (d <= 7) return { text: `in ${d}d`, tone: "warn" };
    return { text: formatDate(iso), tone: "muted" };
  }

  let overdue = $derived(deadlines.filter((d) => (daysFromToday(d.deadlineDate) ?? 0) < 0));

  /**
   * The honest "what needs attention" statement. Every clause is a fact read
   * from the overview; when nothing is wrong it says so rather than inventing
   * encouragement.
   */
  let attention = $derived.by(() => {
    if (!overview) return [];
    const out = [];
    if (overdue.length > 0) {
      out.push({ tone: "bad", text: `${overdue.length} deadline${overdue.length === 1 ? "" : "s"} overdue` });
    }
    if ((overview.flashcardDue ?? 0) > 0) {
      out.push({ tone: "warn", text: `${overview.flashcardDue} card${overview.flashcardDue === 1 ? "" : "s"} due` });
    }
    if (overview.percentage === null || overview.percentage === undefined) {
      out.push({ tone: "muted", text: "No marks recorded yet" });
    }
    if ((overview.studyMinutesTotal ?? 0) === 0) {
      out.push({ tone: "muted", text: "No study logged yet" });
    }
    return out;
  });

  let faces = $derived([
    { id: "overview", label: "Overview", icon: ListChecks },
    { id: "work", label: "Work", icon: CalendarDays, count: deadlines.length },
    { id: "knowledge", label: "Knowledge", icon: FileText, count: resources.length },
    { id: "sessions", label: "Sessions", icon: Timer, count: sessions.length },
    { id: "research", label: "Research", icon: Link2 },
    { id: "operator", label: "Operator", icon: TerminalSquare },
  ]);

  let operatorLine = $derived(operatorSummary());
</script>

{#if selectedSubject}
  {@const cfg = STATUS_CONFIG[selectedSubject.status] || STATUS_CONFIG.pending}
  {@const StatusIcon = cfg.icon}
  <div class="space-ws">
    <button class="back-btn" onclick={onBack}><ChevronLeft size={15} /> Subjects</button>

    <!-- 1. IDENTITY — where am I, and in what state. -->
    <header class="space-head">
      <div class="space-id">
        <h2>
          {selectedSubject.name}
          {#if selectedSubject.code}<span class="code">{selectedSubject.code}</span>{/if}
        </h2>
        <p class="atl-label trail">
          {cleanTrackName(selectedSubject.trackName)} › {selectedSubject.semesterName}
        </p>
      </div>
      <button
        class="status-ctl"
        style="--tone:{cfg.color}; --tone-bg:{cfg.bg}"
        onclick={cycleStatus}
        title="Change status"
      >
        <StatusIcon size={13} strokeWidth={2} aria-hidden="true" />
        {cfg.label}
      </button>
    </header>

    <!-- 2. READOUT — orientation, persistent across every face. -->
    <div class="readout">
      <div class="summary-card">
        <div class="sc-head"><GraduationCap size={13} /> Academic</div>
        <div class="sc-main">{formatGrade(overview)}</div>
        <div class="sc-sub">
          Credits {formatCredits(overview?.credits)} · {statusLabel(selectedSubject.status)}
        </div>
        <button class="sc-action" onclick={() => onNavigate("cgpa")}>
          Degree planner
        </button>
      </div>

      <div class="summary-card">
        <div class="sc-head"><Timer size={13} /> Study</div>
        <div class="sc-main">{formatStudyTime(overview?.studyMinutesToday)} today</div>
        <div class="sc-sub">
          {formatStudyTime(overview?.studyMinutesTotal)} total · {overview?.studySessionCount ?? 0} sessions
        </div>
        <button class="sc-action sc-focus" onclick={() => onStartFocus?.(selectedSubject.id)}>
          <Timer size={13} /> Start Focus
        </button>
      </div>

      <div class="summary-card">
        <div class="sc-head"><CalendarDays size={13} /> Upcoming</div>
        <div class="sc-main">{overview?.upcomingDeadlineCount ?? 0} deadline{(overview?.upcomingDeadlineCount ?? 0) === 1 ? "" : "s"}</div>
        <div class="sc-sub">
          {overview?.flashcardDue ?? 0} card{(overview?.flashcardDue ?? 0) === 1 ? "" : "s"} due
        </div>
        <button class="sc-action" onclick={() => (activeFace = "work")}>
          Open work
        </button>
      </div>
    </div>

    <!-- 3. FACES — the working body. -->
    <FaceStrip {faces} bind:active={activeFace} label="{selectedSubject.name} workspace" />

    <div class="face-body">
      {#if activeFace === "overview"}
        {#if attention.length > 0}
          <ul class="attention" aria-label="Attention">
            {#each attention as a (a.text)}
              <li class="chip" data-tone={a.tone}>{a.text}</li>
            {/each}
          </ul>
        {/if}

        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Upcoming Deadlines</h3>
            <div class="atl-band-actions">
              <button class="cf-btn ghost" onclick={() => onNavigate("deadlines")}>
                <CalendarPlus size={13} /> Add / Manage
              </button>
            </div>
          </div>
          {#if deadlines.length === 0}
            <p class="cf-empty">No upcoming deadlines for this subject.</p>
          {:else}
            <div class="rows">
              {#each deadlines.slice(0, 4) as d (d.id)}
                {@const label = dueLabel(d.deadlineDate)}
                <div class="line-row">
                  <span class="gutter" data-tone={label.tone}>{label.text}</span>
                  <span class="line-title">{d.title}</span>
                  <span class="cf-badge">{d.category}</span>
                </div>
              {/each}
            </div>
            {#if deadlines.length > 4}
              <button class="link-btn" onclick={() => (activeFace = "work")}>
                {deadlines.length - 4} more in Work
              </button>
            {/if}
          {/if}
        </section>

        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Recently Added</h3>
            <div class="atl-band-actions">
              <button class="cf-btn ghost" onclick={() => onOpenNote?.(null, selectedSubject.id)}>
                <FileText size={13} /> New note
              </button>
            </div>
          </div>
          {#if loading}
            <div class="cf-skeleton skel"></div>
          {:else if resources.length === 0}
            <p class="cf-empty">No notes or files yet.</p>
          {:else}
            <div class="rows">
              {#each resources.slice(0, 4) as r (r.id)}
                <div class="line-row">
                  <span class="r-icon" aria-hidden="true">
                    {#if r.kind === "pdf"}<FileText size={13} />{:else}<StickyNote size={13} />{/if}
                  </span>
                  <button class="line-title" onclick={() => openResource(r)}>{r.title}</button>
                </div>
              {/each}
            </div>
            {#if resources.length > 4}
              <button class="link-btn" onclick={() => (activeFace = "knowledge")}>
                All {resources.length} resources in Knowledge
              </button>
            {/if}
          {/if}
        </section>
      {:else if activeFace === "work"}
        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Deadlines</h3>
            <p class="atl-band-note">Active deadlines for this subject, soonest first.</p>
            <div class="atl-band-actions">
              <button class="cf-btn ghost" onclick={() => onNavigate("deadlines")}>
                <CalendarPlus size={13} /> Add / Manage
              </button>
            </div>
          </div>
          {#if deadlines.length === 0}
            <p class="cf-empty">No upcoming deadlines for this subject.</p>
          {:else}
            <div class="rows">
              {#each deadlines as d (d.id)}
                {@const label = dueLabel(d.deadlineDate)}
                <div class="line-row">
                  <span class="gutter" data-tone={label.tone}>{label.text}</span>
                  <span class="line-title">{d.title}</span>
                  <span class="cf-badge">{d.category}</span>
                  <span class="line-date">{formatDate(d.deadlineDate)}</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Labs</h3>
            <p class="atl-band-note">
              {labs.length} experiment{labs.length === 1 ? "" : "s"} recorded
            </p>
            <div class="atl-band-actions">
              <button class="cf-btn ghost" onclick={() => onNavigate("labs")}>
                <FlaskConical size={13} /> Lab tracker
              </button>
            </div>
          </div>
          {#if labs.length === 0}
            <p class="cf-empty">No experiments recorded for this subject.</p>
          {:else}
            <div class="rows">
              {#each labs as lab (lab.id)}
                <div class="line-row">
                  <span class="gutter">#{lab.experimentNo ?? "—"}</span>
                  <span class="line-title">{lab.title}</span>
                  <span class="cf-badge" data-tone={lab.recordSubmitted ? "ok" : "muted"}>
                    {lab.recordSubmitted ? "Record in" : "Record out"}
                  </span>
                  <span class="cf-badge" data-tone={lab.vivaDone ? "ok" : "muted"}>
                    {lab.vivaDone ? "Viva done" : "Viva"}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else if activeFace === "knowledge"}
        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Notes &amp; Files</h3>
            <p class="atl-band-note">{resources.length} item{resources.length === 1 ? "" : "s"}</p>
            <div class="atl-band-actions">
              <button class="cf-btn ghost" onclick={() => onOpenNote?.(null, selectedSubject.id)}>
                <FileText size={13} /> New note
              </button>
              <button class="cf-btn ghost" onclick={attachFile} disabled={attachBusy}>
                <Paperclip size={13} /> {attachBusy ? "Extracting…" : "Attach file"}
              </button>
            </div>
          </div>
          {#if loading}
            <div class="cf-skeleton skel"></div>
          {:else if resources.length === 0}
            <p class="cf-empty">No notes or files yet.</p>
          {:else}
            <div class="rows">
              {#each resources as r (r.id)}
                <div class="line-row">
                  <span class="r-icon" aria-hidden="true">
                    {#if r.kind === "pdf"}<FileText size={13} />{:else}<StickyNote size={13} />{/if}
                  </span>
                  <button class="line-title" onclick={() => openResource(r)}>{r.title}</button>
                  <span class="cf-badge">{r.kind}</span>
                  <button class="icon-btn" onclick={() => deleteResource(r)} title="Delete" aria-label="Delete {r.title}">
                    <Trash2 size={14} />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <div class="pair">
          <section class="atl-band">
            <div class="atl-band-head">
              <h3>Flashcards</h3>
              <p class="atl-band-note">
                {overview?.flashcardTotal ?? 0} total · {overview?.flashcardDue ?? 0} due
              </p>
              <div class="atl-band-actions">
                <button class="cf-btn ghost" onclick={() => onNavigate("flashcards")}>
                  <Brain size={13} /> Review
                </button>
              </div>
            </div>
            {#if cards.length === 0}
              <p class="cf-empty">No flashcards for this subject yet.</p>
            {:else}
              <div class="rows">
                {#each cards.slice(0, 3) as c (c.id)}
                  <div class="line-row"><span class="line-title">{c.front}</span></div>
                {/each}
              </div>
            {/if}
          </section>

          <section class="atl-band">
            <div class="atl-band-head">
              <h3>Mistakes</h3>
              <p class="atl-band-note">{overview?.mistakeCount ?? 0} logged</p>
              <div class="atl-band-actions">
                <button class="cf-btn ghost" onclick={() => onNavigate("mistakes")}>
                  <AlertTriangle size={13} /> Open ledger
                </button>
              </div>
            </div>
            {#if mistakes.length === 0}
              <p class="cf-empty">No mistakes logged for this subject yet.</p>
            {:else}
              <div class="rows">
                {#each mistakes.slice(0, 3) as m (m.id)}
                  <div class="line-row">
                    <span class="line-title">{m.questionText}</span>
                    {#if m.mistakeType}<span class="cf-badge">{m.mistakeType}</span>{/if}
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        </div>
      {:else if activeFace === "sessions"}
        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Study Sessions</h3>
            <p class="atl-band-note">
              {formatStudyTime(overview?.studyMinutesTotal)} total across {overview?.studySessionCount ?? 0} session{(overview?.studySessionCount ?? 0) === 1 ? "" : "s"}
            </p>
            <div class="atl-band-actions">
              <input
                class="cf-input minutes"
                type="number"
                min="1"
                placeholder="min"
                bind:value={quickMinutes}
                aria-label="Minutes to log"
              />
              <button class="cf-btn" onclick={quickLogStudy} disabled={quickBusy}>Log</button>
              <button class="cf-btn ghost" onclick={() => onNavigate("sessions")}>All sessions</button>
            </div>
          </div>
          {#if sessions.length === 0}
            <p class="cf-empty">No study time logged for this subject yet.</p>
          {:else}
            <div class="rows">
              {#each sessions.slice(0, 12) as s (s.id)}
                <div class="line-row">
                  <span class="gutter mono">{formatSessionStart(s.startedAt)}</span>
                  <span class="line-title">{formatStudyTime(s.durationMinutes)}</span>
                  {#if s.notes}<span class="line-note">{s.notes}</span>{/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else if activeFace === "research"}
        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Saved Places</h3>
            <p class="atl-band-note">Links kept against this subject for research runs.</p>
          </div>
          <SubjectLinks subjectId={selectedSubject.id} subjectName={selectedSubject.name} {profileId} />
        </section>
      {:else if activeFace === "operator"}
        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Operator</h3>
            <p class="atl-band-note">{operatorLine.text}</p>
          </div>
          <dl class="facts">
            <div class="fact"><dt>Live this session</dt><dd>{operator.live ? "yes" : "no events yet"}</dd></div>
            <div class="fact"><dt>Runs in flight</dt><dd>{operator.runs.filter((r) => !["completed", "failed", "cancelled"].includes(r.state)).length}</dd></div>
            <div class="fact"><dt>Waiting on you</dt><dd>{operator.approvals.length}</dd></div>
          </dl>
          <p class="honest">
            Agent runs attach to <strong>Projects</strong>, not Subjects — this workspace hosts no
            runs of its own, so nothing is listed here. The readout above is the real global
            operator state.
          </p>
          <div class="band-actions-left">
            <button class="cf-btn" onclick={() => onNavigate("project")}><TerminalSquare size={13} /> Open Runs console</button>
          </div>
        </section>
      {/if}
    </div>
  </div>
{/if}

<style>
  .space-ws {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

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

  .space-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .space-id { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .space-head h2 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .code {
    font-family: var(--font-mono);
    font-size: var(--text-md);
    font-weight: 500;
    color: var(--atlas-ink-3);
  }
  .trail { text-transform: uppercase; }

  .status-ctl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--ctl-h);
    padding: 0 11px;
    border-radius: var(--radius-full);
    border: 1px solid var(--tone);
    background: var(--tone-bg);
    color: var(--tone);
    font-size: var(--text-md);
    font-weight: 550;
    cursor: pointer;
  }
  .status-ctl:hover { filter: brightness(1.12); }

  /* ---- Readout: three instrument columns, hairline-separated ---- */
  .readout {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    background: var(--atlas-panel);
    overflow: hidden;
  }
  .summary-card {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: var(--space-3) var(--space-4);
    min-width: 0;
  }
  .summary-card + .summary-card { border-left: 1px solid var(--atlas-line); }
  .sc-head {
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
  .sc-main {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--atlas-ink);
    font-variant-numeric: tabular-nums;
  }
  .sc-sub {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    font-variant-numeric: tabular-nums;
  }
  .sc-action {
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
    font-weight: 500;
    cursor: pointer;
  }
  .sc-action:hover { color: var(--atlas-ink); border-color: var(--atlas-line-2); }

  /* ---- Face body ---- */
  .face-body { display: flex; flex-direction: column; gap: var(--space-5); }

  .attention {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: var(--radius-full);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    font-size: var(--text-sm);
    color: var(--atlas-ink-2);
  }
  .chip[data-tone="bad"] { color: var(--atlas-bad); border-color: var(--atlas-bad); background: var(--atlas-bad-bg); }
  .chip[data-tone="warn"] { color: var(--atlas-warn); border-color: var(--atlas-warn-line); background: var(--atlas-warn-bg); }

  .atl-band-head h3 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--atlas-ink);
  }

  .rows { display: flex; flex-direction: column; }

  .line-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
    font-size: var(--text-md);
    color: var(--atlas-ink-2);
  }
  .line-row + .line-row { border-top: 1px solid var(--atlas-line); }
  .line-row:hover { background: var(--atlas-wash); }

  .line-title {
    flex: 1;
    min-width: 0;
    color: var(--atlas-ink);
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    cursor: default;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.line-title { cursor: pointer; }
  button.line-title:hover { color: var(--atlas-signal); }

  .line-note {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gutter {
    flex: 0 0 auto;
    min-width: 8.5ch;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
    font-variant-numeric: tabular-nums;
  }
  .gutter[data-tone="bad"] { color: var(--atlas-bad); }
  .gutter[data-tone="warn"] { color: var(--atlas-warn); }
  .gutter.mono { min-width: 14ch; }

  .line-date {
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-ink-3);
    font-variant-numeric: tabular-nums;
  }

  .r-icon {
    flex: 0 0 auto;
    display: inline-flex;
    color: var(--atlas-ink-3);
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-xs);
    border: 0;
    background: none;
    color: var(--atlas-ink-3);
    cursor: pointer;
  }
  .icon-btn:hover { color: var(--atlas-bad); background: var(--atlas-wash-2); }

  .link-btn {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 0;
    color: var(--atlas-signal);
    font-size: var(--text-md);
    cursor: pointer;
  }
  .link-btn:hover { text-decoration: underline; }

  .cf-badge[data-tone="ok"] { color: var(--atlas-ok); background: var(--atlas-ok-bg); }
  .cf-badge[data-tone="muted"] { color: var(--atlas-ink-3); }

  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-5);
    align-items: start;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: var(--space-3);
    margin: 0;
  }
  .fact { display: flex; flex-direction: column; gap: 2px; }
  .fact dt {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
  }
  .fact dd { margin: 0; font-size: var(--text-xl); font-weight: 600; color: var(--atlas-ink); }

  .honest {
    margin: 0;
    max-width: 68ch;
    font-size: var(--text-md);
    line-height: 1.6;
    color: var(--atlas-ink-3);
  }
  .honest strong { color: var(--atlas-ink-2); font-weight: 600; }

  .band-actions-left { display: flex; gap: var(--space-2); }

  .skel { height: 68px; }
  .minutes { width: 84px; }

  @media (max-width: 900px) {
    .readout { grid-template-columns: 1fr; }
    .summary-card + .summary-card { border-left: 0; border-top: 1px solid var(--atlas-line); }
    .pair { grid-template-columns: 1fr; }
  }
</style>
