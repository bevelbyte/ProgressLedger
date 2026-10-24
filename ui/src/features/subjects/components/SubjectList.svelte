<script>
  // Subjects — the Spaces index (docs/DESIGN-ATLAS.md §5.2).
  //
  // This is the front door to every Space you are carrying. It was previously a
  // nested-tab dashboard that rendered each subject three different ways (a
  // "degree dashboard" table, a grouped list and a grid) with three copies of
  // the same overflow menu, plus a per-subject icon picked by hashing the
  // subject's name — fabricated identity dressed as design.
  //
  // Atlas structure, top to bottom:
  //   1. HEAD        — the view's name and honest standing counts.
  //   2. SCOPE BAR   — one scope control (degree · Continue Learning), search,
  //                    semester scope, density. Nothing is both a tab and a
  //                    filter.
  //   3. BODY        — ONE row renderer. Grouped by semester, hairlines only.
  //
  // A Space row shows what a Space *is*: name, code, state, and how recently it
  // was worked on. It does not show a progress percentage, because no such
  // number exists in the data.
  import {
    Search, List, Grid, Check, BookOpen, Library, Plus,
  } from "lucide-svelte";
  import {
    subjectStore,
    updateSubjectStatus
  } from "../stores/subject.svelte.js";
  import { statusLabel, formatLastStudied, cleanTrackName } from "../subject-view.js";
  import {
    buildObligations,
    obligationHeadline,
    obligationTone,
    obligationsTotals,
  } from "../subject-obligations.js";
  import { Menu } from "../../../shared/components";

  let { profileId = null, onSelect = null, onNavigate = () => {} } = $props();

  let searchQuery = $state("");
  let activeTab = $state(localStorage.getItem("cf_subject_hub_active_tab") || "All Subjects");
  let viewLayout = $state("list"); // "list" | "grid"
  let selectedSemesterFilter = $state("All Semesters");
  let collapsedGroups = $state(new Set());

  // ---- Owed-here strip (Space Bunny "OWED HERE") ---------------------------
  //
  // The index used to be a pure inventory: what exists, and its status. It
  // never said what any of that still OWED you. These three lists are the
  // profile-wide sources the obligation model folds into per-subject counts --
  // they are fetched once here rather than per subject, because the underlying
  // queries are each already profile-wide and carry subjectId on every row.
  //
  // settle-all, not fail-fast: a failed flashcards read must not blank the
  // deadline read-out. `obligationsFailed` is tracked so the strip can say
  // "partial" rather than silently rendering a shorter total as if it were
  // complete.
  let obligationDeadlines = $state([]);
  let obligationCards = $state([]);
  let obligationMistakes = $state([]);
  let obligationsFailed = $state(0);

  async function loadObligations(pid) {
    const results = await Promise.allSettled([
      window.progressLedger.deadlines.list(pid),
      window.progressLedger.cards.all(pid),
      // `mistakes.list` takes an OPTIONS OBJECT, not a bare profileId (see
      // shell/src/preload.cjs:76). Passing a bare id here resolves against
      // `profileId` of the destructured arg, which is undefined, so the query
      // would silently return nothing and the strip would quietly under-report
      // open mistakes forever.
      window.progressLedger.mistakes.list({ profileId: pid }),
    ]);
    const [d, c, m] = results;
    obligationDeadlines = d.status === "fulfilled" && Array.isArray(d.value) ? d.value : [];
    obligationCards = c.status === "fulfilled" && Array.isArray(c.value) ? c.value : [];
    obligationMistakes = m.status === "fulfilled" && Array.isArray(m.value) ? m.value : [];
    obligationsFailed = results.filter((r) => r.status === "rejected").length;
  }

  $effect(() => {
    if (profileId != null) {
      void loadObligations(profileId);
    } else {
      // No profile: clear, or the previous profile's obligations linger.
      obligationDeadlines = [];
      obligationCards = [];
      obligationMistakes = [];
      obligationsFailed = 0;
    }
  });

  // The subject tree, course marks and sessions already reload on
  // cf:data-changed; obligations must follow the same trigger or completing a
  // deadline elsewhere would leave the index still claiming it is owed.
  $effect(() => {
    const handler = () => {
      if (profileId != null) void loadObligations(profileId);
    };
    window.addEventListener("cf:data-changed", handler);
    return () => window.removeEventListener("cf:data-changed", handler);
  });

  let obligations = $derived(
    buildObligations({
      deadlines: obligationDeadlines,
      cards: obligationCards,
      mistakes: obligationMistakes,
    })
  );
  let obligationTotals = $derived(obligationsTotals(obligations));

  let degreeTabs = $derived.by(() => {
    const trackNames = Array.from(new Set(subjectStore.allSubjects.map((s) => s.trackName)));
    return trackNames.map((name) => {
      const subjects = subjectStore.allSubjects.filter((s) => s.trackName === name);
      const complete = subjects.length > 0 && subjects.every((s) => s.status === "done");
      return { id: name, label: cleanTrackName(name) + (complete ? " (Completed)" : " (Current)") };
    });
  });

  // A persisted scope can outlive the degree it pointed at (renamed or removed).
  // Falling back to All Subjects keeps the index from showing a permanently
  // empty list for a scope that no longer exists.
  let scope = $derived.by(() => {
    if (activeTab === "All Subjects" || activeTab === "Continue Learning") return activeTab;
    return degreeTabs.some((t) => t.id === activeTab) ? activeTab : "All Subjects";
  });

  let scopedToDegree = $derived(scope !== "All Subjects" && scope !== "Continue Learning");

  let continueLearningCount = $derived(
    subjectStore.allSubjects.filter((s) => s.status === "in_progress").length
  );

  let activeTrackSemesters = $derived.by(() => {
    if (!scopedToDegree) return [];
    const track = subjectStore.tree.find((t) => t.name === scope);
    return track?.semesters ?? [];
  });

  $effect(() => {
    localStorage.setItem("cf_subject_hub_active_tab", scope);
    const savedFilter = localStorage.getItem(`cf_subject_hub_sem_filter_${scope}`);
    selectedSemesterFilter = savedFilter || "All Semesters";
  });

  $effect(() => {
    localStorage.setItem(`cf_subject_hub_sem_filter_${scope}`, selectedSemesterFilter);
  });

  function isSemesterCompleted(semId) {
    const sem = activeTrackSemesters.find((s) => s.id === semId);
    if (!sem) return false;
    const semSubjects = (sem.milestones || []).flatMap((ms) => ms.subjects || []);
    if (semSubjects.length === 0) return false;
    return semSubjects.every((s) => s.status === "done");
  }

  function getSubjectMarks(subj) {
    // Structural identity first; legacy name-key fallback for unlinked rows.
    const key = subjectStore.courseMarks[`sid:${subj.id}`] ? `sid:${subj.id}`
      : `${subj.semesterName}::${subj.name.trim().toLowerCase()}`;
    const course = subjectStore.courseMarks[key];
    if (!course || course.maxMarks === null || course.maxMarks === undefined) return "—";
    return `${course.marksObtained ?? "—"} / ${course.maxMarks}`;
  }

  function statusTone(status) {
    if (status === "in_progress") return "var(--atlas-signal)";
    if (status === "done") return "var(--atlas-ok)";
    return "var(--atlas-ink-3)";
  }

  let scopedSubjects = $derived(subjectStore.allSubjects.filter((s) => {
    if (scope === "All Subjects") return true;
    if (scope === "Continue Learning") return s.status === "in_progress";
    return s.trackName === scope;
  }));

  let filteredSubjects = $derived(scopedSubjects.filter((s) => {
    if (selectedSemesterFilter !== "All Semesters" && s.semesterName !== selectedSemesterFilter) return false;
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return (s.name || "").toLowerCase().includes(query) || (s.code || "").toLowerCase().includes(query);
  }));

  let groupedSemesters = $derived.by(() => {
    const groupsMap = new Map();
    for (const subj of filteredSubjects) {
      const key = `${subj.trackName} - ${subj.semesterName}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          id: key,
          degree: cleanTrackName(subj.trackName),
          semester: subj.semesterName,
          subjects: [],
        });
      }
      groupsMap.get(key).subjects.push(subj);
    }
    return Array.from(groupsMap.values());
  });

  let doneCount = $derived(scopedSubjects.filter((s) => s.status === "done").length);
  let activeCount = $derived(scopedSubjects.filter((s) => s.status === "in_progress").length);
  let semestersRepresented = $derived(new Set(scopedSubjects.map((s) => s.semesterName)).size);

  let completionRate = $derived(
    scopedSubjects.length > 0 ? Math.round((doneCount / scopedSubjects.length) * 100) : 0
  );

  function toggleGroup(groupId) {
    const next = new Set(collapsedGroups);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    collapsedGroups = next;
  }

  function statusMenuItems(subj) {
    return [
      { id: "pending", label: "Not started", onselect: () => setSubjectStatusDirectly(subj, "pending") },
      { id: "in_progress", label: "In progress", onselect: () => setSubjectStatusDirectly(subj, "in_progress") },
      { id: "done", label: "Completed", onselect: () => setSubjectStatusDirectly(subj, "done") },
    ];
  }

  async function setSubjectStatusDirectly(subj, nextStatus) {
    await updateSubjectStatus(profileId, subj.id, nextStatus);
  }
</script>

<div class="subject-hub-v2 atl-view">
  <header class="index-head">
    <div class="index-id">
      <h1>Subjects</h1>
      <p class="standing">
        {scopedSubjects.length} space{scopedSubjects.length === 1 ? "" : "s"}
        · {activeCount} in progress
        · {doneCount} completed
        {#if semestersRepresented > 0}· {semestersRepresented} semester{semestersRepresented === 1 ? "" : "s"}{/if}
      </p>
    </div>
    <button class="cf-btn primary" onclick={() => onNavigate("cgpa")}>
      <Plus size={14} /> New subject
    </button>
  </header>

  <!-- OWED HERE -- the obligation-first band.

     SPACE BUNNY DIRECTION. In the reference, a Space leads with what it still
     owes you, not with an inventory of what it contains. Progress Ledger's subject
     index did the opposite: it listed subjects, their marks and their status,
     and never once mentioned that four of them had work outstanding. A student
     opening Spaces is usually asking "what is this costing me", so that is now
     the first question the surface answers.

     Every figure is counted from a real row by subject-obligations.js. There is
     no weighting, no score and no inferred urgency -- only lateness and dates
     that the database actually holds. -->
<section class="atl-section atl-section--stacked owed" aria-label="Owed here">
  <div class="atl-section-head">
    <div class="atl-section-lead">
      <h2 class="atl-section-name">Owed here</h2>
      <span class="atl-section-why">
        {#if obligationsFailed > 0}
          Partial — {obligationsFailed} of 3 sources could not be read
        {:else if obligationTotals.open === 0}
          Nothing outstanding across {scopedSubjects.length} subject{scopedSubjects.length === 1 ? "" : "s"}
        {:else}
          {obligationTotals.open} open item{obligationTotals.open === 1 ? "" : "s"} across {scopedSubjects.length} subject{scopedSubjects.length === 1 ? "" : "s"}
        {/if}
      </span>
    </div>
    <aside class="atl-section-aside">
      {#if obligationTotals.late > 0}
        <span class="cf-badge danger">{obligationTotals.late} late</span>
      {/if}
      {#if obligationTotals.dueToday > 0}
        <span class="cf-badge warning">{obligationTotals.dueToday} due today</span>
      {/if}
    </aside>
  </div>

  <div class="atl-metrics">
    <div class="atl-metric">
      <span class="atl-metric-label">Late</span>
      <span class="atl-metric-value {obligationTotals.late > 0 ? 'tone-bad' : 'tone-machine'}">{obligationTotals.late}</span>
    </div>
    <div class="atl-metric">
      <span class="atl-metric-label">Due today</span>
      <span class="atl-metric-value {obligationTotals.dueToday > 0 ? 'tone-warn' : 'tone-machine'}">{obligationTotals.dueToday}</span>
    </div>
    <div class="atl-metric">
      <span class="atl-metric-label">Open</span>
      <span class="atl-metric-value">{obligationTotals.open}</span>
    </div>
    <div class="atl-metric">
      <span class="atl-metric-label">In progress</span>
      <span class="atl-metric-value tone-ok">{activeCount}</span>
      <span class="atl-metric-note">of {scopedSubjects.length}</span>
    </div>
  </div>
</section>

  <div class="scope-bar">
    <div class="scope-chips" role="group" aria-label="Scope">
      <button
        class="scope-chip"
        class:on={scope === "All Subjects"}
        aria-pressed={scope === "All Subjects"}
        onclick={() => (activeTab = "All Subjects")}
      >
        All
      </button>
      {#each degreeTabs as tab (tab.id)}
        <button
          class="scope-chip"
          class:on={scope === tab.id}
          aria-pressed={scope === tab.id}
          onclick={() => (activeTab = tab.id)}
        >
          {tab.label}
        </button>
      {/each}
      <button
        class="scope-chip"
        class:on={scope === "Continue Learning"}
        aria-pressed={scope === "Continue Learning"}
        onclick={() => (activeTab = "Continue Learning")}
      >
        Continue learning
        {#if continueLearningCount > 0}
          <span class="cf-badge tally">{continueLearningCount}</span>
        {/if}
      </button>
    </div>

    <div class="scope-tools">
      <div class="search-box">
        <Search size={14} aria-hidden="true" />
        <input class="cf-input search" type="text" placeholder="Search subjects…" bind:value={searchQuery} />
      </div>
      <div class="density" role="group" aria-label="Density">
        <button
          class="density-btn"
          class:on={viewLayout === "list"}
          aria-pressed={viewLayout === "list"}
          title="List"
          aria-label="List view"
          onclick={() => (viewLayout = "list")}
        >
          <List size={14} />
        </button>
        <button
          class="density-btn"
          class:on={viewLayout === "grid"}
          aria-pressed={viewLayout === "grid"}
          title="Grid"
          aria-label="Grid view"
          onclick={() => (viewLayout = "grid")}
        >
          <Grid size={14} />
        </button>
      </div>
    </div>
  </div>

  {#if scopedToDegree}
    <div class="standing">
      <div class="stat">
        <span class="stat-num">{activeTrackSemesters.length}</span>
        <span class="atl-label">Semesters</span>
      </div>
      <div class="stat">
        <span class="stat-num">{scopedSubjects.length}</span>
        <span class="atl-label">Subjects</span>
      </div>
      <div class="stat">
        <span class="stat-num">{doneCount}</span>
        <span class="atl-label">Completed</span>
      </div>
      <div class="stat">
        <span class="stat-num">{completionRate}%</span>
        <span class="atl-label">Complete</span>
      </div>
    </div>

    {#if activeTrackSemesters.length > 1}
      <div class="scope-chips sem" role="group" aria-label="Semester scope">
        <button
          class="scope-chip"
          class:on={selectedSemesterFilter === "All Semesters"}
          aria-pressed={selectedSemesterFilter === "All Semesters"}
          onclick={() => (selectedSemesterFilter = "All Semesters")}
        >
          All semesters
        </button>
        {#each activeTrackSemesters as sem (sem.id)}
          <button
            class="scope-chip"
            class:on={selectedSemesterFilter === sem.name}
            aria-pressed={selectedSemesterFilter === sem.name}
            onclick={() => (selectedSemesterFilter = sem.name)}
          >
            {sem.name.replace("Semester ", "Sem ")}
            {#if isSemesterCompleted(sem.id)}
              <Check size={11} strokeWidth={3} aria-hidden="true" />
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  <div class="body">
    {#if groupedSemesters.length === 0}
      <div class="cf-empty boxed">
        {#if scope === "Continue Learning"}
          <Library size={26} />
          <h3>Nothing in progress</h3>
          <p>Set a subject's status to <strong>In progress</strong> to track it here.</p>
        {:else if searchQuery.trim()}
          <Search size={26} />
          <h3>No match</h3>
          <p>No subject matches “{searchQuery.trim()}”.</p>
        {:else}
          <BookOpen size={26} />
          <h3>No subjects yet</h3>
          <p>Subjects are created inside the Degree planner, under a semester.</p>
          <button class="cf-btn" onclick={() => onNavigate("cgpa")}>Open Degree planner</button>
        {/if}
      </div>
    {:else}
      {#each groupedSemesters as group (group.id)}
        <section class="group">
          <div class="atl-band-head">
            <button class="group-toggle" onclick={() => toggleGroup(group.id)} aria-expanded={!collapsedGroups.has(group.id)}>
              <span class="group-name">{group.degree}</span>
              <span class="group-sep">›</span>
              <span class="group-sem">{group.semester}</span>
            </button>
            <p class="atl-band-note">
              {group.subjects.length} subject{group.subjects.length === 1 ? "" : "s"}
              · {group.subjects.filter((s) => s.status === "done").length} completed
            </p>
          </div>

          {#if !collapsedGroups.has(group.id)}
            {#if viewLayout === "list"}
              <div class="rows">
                {#each group.subjects as subj (subj.id)}
                  <div class="subject-row">
                    <button class="row-open" onclick={() => onSelect?.(subj)}>
                      <span class="s-name">{subj.name}</span>
                      {#if subj.code}<span class="s-code">{subj.code}</span>{/if}
                    </button>
                    <span class="s-marks mono">{getSubjectMarks(subj)}</span>
                    <span class="s-studied">{formatLastStudied(subjectStore.lastStudiedAt[subj.id])}</span>
                    <span class="s-owed" data-tone={obligationTone(obligations.get(subj.id))}>
                      {#if obligationHeadline(obligations.get(subj.id))}
                        {obligationHeadline(obligations.get(subj.id))}
                      {:else if obligations.get(subj.id)?.cardsDue}
                        {obligations.get(subj.id).cardsDue} to review
                      {:else}
                        <span class="cf-sr-only">Nothing outstanding</span>
                      {/if}
                    </span>
                    <span class="s-status" style="color:{statusTone(subj.status)}">
                      <span class="dot" aria-hidden="true"></span>
                      {statusLabel(subj.status)}
                    </span>
                    <Menu
                      label="Subject options"
                      items={statusMenuItems(subj)}
                    />
                  </div>
                {/each}
              </div>
            {:else}
              <div class="grid">
                {#each group.subjects as subj (subj.id)}
                  <div class="subject-card">
                    <button class="card-open" onclick={() => onSelect?.(subj)}>
                      <span class="s-name">{subj.name}</span>
                      <span class="card-meta">
                        {subj.code || "no code"} · studied {formatLastStudied(subjectStore.lastStudiedAt[subj.id]).toLowerCase()}
                      </span>
                    </button>
                    <span class="s-status" style="color:{statusTone(subj.status)}">
                      <span class="dot" aria-hidden="true"></span>
                      {statusLabel(subj.status)}
                    </span>
                    <Menu label="Subject options" items={statusMenuItems(subj)} />
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
  .index-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .index-id { display: flex; flex-direction: column; gap: 4px; }
  .index-head h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }
  .standing {
    margin: 0;
    font-size: var(--text-md);
    color: var(--atlas-ink-3);
    font-variant-numeric: tabular-nums;
  }

  .scope-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--atlas-line);
  }
  .scope-chips {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .scope-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 11px;
    border-radius: var(--radius-full);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
    cursor: pointer;
  }
  .scope-chip:hover { color: var(--atlas-ink); border-color: var(--atlas-line-2); }
  .scope-chip.on {
    border-color: var(--atlas-signal);
    background: var(--atlas-signal-soft);
    color: var(--atlas-signal);
    font-weight: 550;
  }
  .tally { background: var(--atlas-wash-2); color: var(--atlas-ink-2); }

  .scope-tools { display: flex; align-items: center; gap: var(--space-2); }
  .search-box {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--atlas-ink-3);
  }
  .search { width: 210px; }
  .density {
    display: inline-flex;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .density-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: calc(var(--ctl-h) - 2px);
    border: 0;
    background: var(--atlas-raise);
    color: var(--atlas-ink-3);
    cursor: pointer;
  }
  .density-btn + .density-btn { border-left: 1px solid var(--atlas-line); }
  .density-btn:hover { color: var(--atlas-ink); }
  .density-btn.on { background: var(--atlas-wash-2); color: var(--atlas-ink); }

  .standing {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
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

  .body { display: flex; flex-direction: column; gap: var(--space-5); }
  .group { display: flex; flex-direction: column; gap: var(--space-2); }

  .group-toggle {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    color: var(--atlas-ink);
  }
  .group-name { font-size: var(--text-lg); font-weight: 600; }
  .group-sep { color: var(--atlas-ink-3); }
  .group-sem { font-size: var(--text-lg); font-weight: 500; color: var(--atlas-ink-2); }

  .rows { display: flex; flex-direction: column; }

  .subject-row {
    display: grid;
    /* Six tracks: name | marks | studied | OWED | status | menu.
       The owed track was added with the obligation strip; without widening
       this the sixth child is dropped from the grid entirely and the read-out
       silently never renders. */
    grid-template-columns: minmax(0, 1fr) auto auto minmax(84px, auto) auto auto;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
    border-top: 1px solid var(--atlas-line);
  }
  .subject-row:hover { background: var(--atlas-wash); }

  .row-open {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    background: none;
    border: 0;
    padding: 6px 0;
    text-align: left;
    cursor: pointer;
  }
  .s-name {
    font-size: var(--text-md);
    font-weight: 550;
    color: var(--atlas-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-open:hover .s-name { color: var(--atlas-signal); }
  .s-code {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    letter-spacing: 0.04em;
    color: var(--atlas-ink-3);
  }
  .s-marks {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--atlas-ink-2);
    font-variant-numeric: tabular-nums;
  }
  .s-studied {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    white-space: nowrap;
  }
  .s-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    white-space: nowrap;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: currentColor;
    flex: 0 0 auto;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--space-3);
  }
  .subject-card {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    background: var(--atlas-panel);
  }
  .subject-card:hover { border-color: var(--atlas-line-2); }
  .card-open {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .card-meta { font-size: var(--text-sm); color: var(--atlas-ink-3); }

  @media (max-width: 900px) {
    /* Four tracks: name | OWED | status | menu. Marks and studied are dropped
       first; the owed read-out is the last thing to go, because it is the
       reason the row exists. */
    .subject-row { grid-template-columns: minmax(0, 1fr) minmax(72px, auto) auto auto; }
    .s-marks, .s-studied { display: none; }
  }
</style>
