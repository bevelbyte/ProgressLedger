<script>
  // Degree — the academic structure surface (docs/DESIGN-ATLAS.md §5.2).
  //
  // Degree is where the *structure* lives: profile → track → semester →
  // milestone → subject. Subjects are the Spaces; this view is the scaffolding
  // that creates them, so its mental model is "the shape of my programme",
  // not "another dashboard".
  //
  // Three faces of one object:
  //   Structure — degrees, years, semesters, evaluation patterns, subject marks
  //   Progress  — how the semester you are looking at is actually going
  //   Career    — the roadmap those subjects feed (kept here as before)
  //
  // `faceClass="section-tab-btn"` preserves the class the E2E suite drives this
  // surface with; the *interaction* is now identical to every other Space.
  //
  // This file owns local UI state only. Persistence, GPA math and mapping live
  // in the store, services, degree-mapper and the Rust domain.
  import {
    GraduationCap, Plus, Check, Hourglass, CalendarDays, ListChecks, Compass,
  } from "lucide-svelte";
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import {
    cgpaStore,
    loadCgpa,
    persist,
    saveDegree,
    deleteDegree,
    addSemester,
    deleteSemester,
    setSemesterStatus,
    saveSubject,
    deleteSubject,
    copySubjectsFrom,
  } from "../stores/cgpa.svelte.js";
  import { yearFilters, filterSemestersByYear } from "../cgpa-view.js";
  import DegreeFormModal from "./DegreeFormModal.svelte";
  import SubjectFormModal from "./SubjectFormModal.svelte";
  import SemesterDetail from "./SemesterDetail.svelte";
  import { SemesterProgress } from "../../semester";
  import { CareerPlan } from "../../career";
  import { FaceStrip, Menu } from "../../../shared/components";

  let { profileId = null, onOpenSubject = () => {}, onNavigate = () => {} } = $props();

  // ---- Local UI state (owned here) ----
  let activeSemesterNum = $state(1);
  let activeFace = $state("structure");
  let activeYearFilter = $state("All Semesters");
  let activePatternName = $state("Internal - I");
  let degreeModal = $state({ open: false, editing: null });
  let subjectModal = $state({ open: false, editing: null });

  // ---- Derived view state from the store ----
  const activeDegree = $derived(cgpaStore.activeDegree);
  const filters = $derived(activeDegree ? yearFilters(activeDegree.semesters.length) : []);
  const filteredSemesters = $derived(
    activeDegree ? filterSemestersByYear(activeDegree.semesters, activeYearFilter) : []
  );
  const activeSemester = $derived(activeDegree?.semesters.find((s) => s.number === activeSemesterNum) ?? null);

  function semesterSgpa(sem) {
    const entry = cgpaStore.summary.semesters?.find((s) => s.label === `Semester ${sem.number}`);
    if (!entry || entry.credits <= 0) return "—";
    return entry.sgpa.toFixed(2);
  }

  let completedSemesters = $derived(
    (activeDegree?.semesters ?? []).filter((s) => s.status === "Completed").length
  );

  let faces = $derived([
    { id: "structure", label: "My Degrees", icon: ListChecks },
    { id: "progress", label: "Progress", icon: GraduationCap },
    { id: "career", label: "Career", icon: Compass },
  ]);

  // ---- Lifecycle ----
  $effect(() => {
    profileId;
    loadCgpa(profileId);
  });

  // ---- Degree interactions ----
  function openAddDegree() {
    degreeModal = { open: true, editing: null };
  }
  function openEditDegree(degree) {
    degreeModal = { open: true, editing: degree };
  }
  function selectDegree(id) {
    if (cgpaStore.activeDegreeId === id) return;
    cgpaStore.activeDegreeId = id;
    activeSemesterNum = 1;
    activeYearFilter = "All Semesters";
  }
  async function onSaveDegree(input) {
    if (!input.name) {
      toast.error("A degree needs a name.");
      return;
    }
    const editingId = degreeModal.editing?.id ?? null;
    saveDegree(input, editingId);
    if (!editingId) {
      activeSemesterNum = 1;
      activePatternName = "Internal - I";
    }
    degreeModal = { open: false, editing: null };
    if (await persist(profileId)) {
      toast.success(editingId ? "Degree updated." : "Degree added.");
    }
  }
  async function handleDeleteDegree(id) {
    const ok = await confirmDialog({
      title: "Delete degree",
      message: "This removes the degree with all its semesters, subjects and marks.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    deleteDegree(id);
    activeSemesterNum = 1;
    if (await persist(profileId)) toast.success("Degree deleted.");
  }

  // ---- Semester interactions ----
  async function handleAddSemester() {
    const n = addSemester();
    if (n && (await persist(profileId))) toast.success(`Semester ${n} added.`);
  }
  async function handleSetStatus(semNum, status) {
    setSemesterStatus(semNum, status);
    if (await persist(profileId)) toast.success(`Semester ${semNum} set to ${status}.`);
  }
  async function handleDeleteSemester(semNumber) {
    const result = deleteSemester(semNumber);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    if (activeSemesterNum === semNumber) {
      activeSemesterNum = cgpaStore.activeDegree?.semesters[0]?.number ?? 1;
    }
    if (await persist(profileId)) toast.success(`Semester ${semNumber} removed.`);
  }

  function semesterMenu(sem) {
    const items = [
      { id: "completed", label: "Completed", onselect: () => handleSetStatus(sem.number, "Completed") },
      { id: "in-progress", label: "In progress", onselect: () => handleSetStatus(sem.number, "In Progress") },
      { id: "upcoming", label: "Upcoming", onselect: () => handleSetStatus(sem.number, "Upcoming") },
    ];
    if ((activeDegree?.semesters.length ?? 0) > 1 && sem.status === "Upcoming") {
      items.push({ id: "sep", separator: true });
      items.push({
        id: "del",
        label: "Delete semester",
        danger: true,
        onselect: () => handleDeleteSemester(sem.number),
      });
    }
    return items;
  }

  // ---- Subject interactions ----
  function openAddSubject() {
    subjectModal = { open: true, editing: null };
  }
  function openEditSubject(sub) {
    subjectModal = { open: true, editing: sub };
  }
  async function onSaveSubject(value) {
    const editing = subjectModal.editing;
    saveSubject({ semesterNum: activeSemesterNum, patternName: activePatternName, editingSubject: editing, value });
    subjectModal = { open: false, editing: null };
    if (await persist(profileId)) toast.success(editing ? "Subject updated." : "Subject added.");
  }
  async function handleDeleteSubject(subId) {
    const ok = await confirmDialog({
      title: "Delete subject",
      message: "This deletes the subject with its marks and every record attached to it.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    deleteSubject(activeSemesterNum, activePatternName, subId);
    if (await persist(profileId)) toast.success("Subject deleted.");
  }
  async function handleCopyFrom(sourcePattern) {
    const ok = await confirmDialog({
      title: "Copy subjects",
      message: `Copy every subject from ${sourcePattern} into ${activePatternName}? Subjects already in ${activePatternName} are replaced.`,
      confirmLabel: "Copy",
    });
    if (!ok) return;
    const n = copySubjectsFrom(activeSemesterNum, activePatternName, sourcePattern);
    if (n > 0 && (await persist(profileId))) toast.success(`Copied ${n} subjects from ${sourcePattern}.`);
  }
</script>

{#if !profileId}
  <div class="cf-empty">
    <GraduationCap size={30} />
    <h3>No profile selected</h3>
    <p>Select or create a profile to plan your degree.</p>
  </div>
{:else if !activeDegree}
  <div class="cf-empty">
    <GraduationCap size={30} />
    <h3>No degree configured</h3>
    <p>A degree gives your subjects a semester to live in.</p>
    <button class="cf-btn primary" onclick={openAddDegree}><Plus size={14} /> Add degree</button>
  </div>
{:else}
  <div class="degree-view atl-view">
    <header class="hub-head">
      <div class="hub-id">
        <h1>Degree</h1>
        <p class="atl-label trail">
          {activeDegree.name}{#if activeDegree.specialization} · {activeDegree.specialization}{/if}
        </p>
      </div>
      <div class="hub-actions">
        <button class="cf-btn ghost" onclick={handleAddSemester}><Plus size={14} /> Add semester</button>
        <button class="cf-btn primary" onclick={openAddDegree}><Plus size={14} /> Add degree</button>
      </div>
    </header>

    <FaceStrip {faces} bind:active={activeFace} label="Degree sections" faceClass="section-tab-btn" />

    {#if activeFace === "structure"}
      {#if cgpaStore.degrees.length > 1}
        <div class="scope-chips" role="group" aria-label="Degree">
          {#each cgpaStore.degrees as d (d.id)}
            <button
              class="scope-chip"
              class:on={d.id === cgpaStore.activeDegreeId}
              aria-pressed={d.id === cgpaStore.activeDegreeId}
              onclick={() => selectDegree(d.id)}
            >
              {d.name}
            </button>
          {/each}
        </div>
      {/if}

      <div class="readout">
        <div class="stat">
          <span class="stat-num">{activeDegree.semesters.length}</span>
          <span class="atl-label">Semesters</span>
        </div>
        <div class="stat">
          <span class="stat-num">{completedSemesters}</span>
          <span class="atl-label">Completed</span>
        </div>
        {#if cgpaStore.summary?.cgpa}
          <div class="stat">
            <span class="stat-num">{cgpaStore.summary.cgpa.toFixed(2)}</span>
            <span class="atl-label">CGPA</span>
          </div>
        {/if}
        {#if cgpaStore.summary?.credits}
          <div class="stat">
            <span class="stat-num">{cgpaStore.summary.credits}</span>
            <span class="atl-label">Credits graded</span>
          </div>
        {/if}
      </div>

      <div class="split">
        <section class="rail">
          <div class="atl-band-head">
            <h2>Semesters</h2>
            {#if filters.length > 1}
              <div class="atl-band-actions">
                {#each filters as filterName}
                  <button
                    class="scope-chip"
                    class:on={activeYearFilter === filterName}
                    aria-pressed={activeYearFilter === filterName}
                    onclick={() => (activeYearFilter = filterName)}
                  >
                    {filterName}
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <div class="rows">
            {#each filteredSemesters as sem (sem.number)}
              {@const tone = sem.status === "Completed" ? "ok" : sem.status === "In Progress" ? "live" : "muted"}
              <!-- The row is a pointer convenience over the real control: the
                   `.sem-open` button carries focus and keyboard behaviour, and
                   the row's own click only ever selects what is already
                   visible. -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="sem-row-card"
                class:selected={sem.number === activeSemesterNum}
                data-tone={tone}
                onclick={() => (activeSemesterNum = sem.number)}
              >
                <button class="sem-open" onclick={() => (activeSemesterNum = sem.number)}>
                  <span class="sem-mark" aria-hidden="true">
                    {#if sem.status === "Completed"}<Check size={11} strokeWidth={3} />
                    {:else if sem.status === "In Progress"}<CalendarDays size={11} />
                    {:else}<Hourglass size={11} />{/if}
                  </span>
                  <span class="sem-name">Semester {sem.number}</span>
                </button>
                <span class="sem-sgpa mono">{semesterSgpa(sem)}</span>
                <span class="status-badge {sem.status.toLowerCase().replace(' ', '-')}">{sem.status}</span>
                <span onclick={(e) => e.stopPropagation()} role="presentation">
                  <Menu label="Semester options" items={semesterMenu(sem)} />
                </span>
              </div>
            {/each}
          </div>

          <button class="link-btn" onclick={handleAddSemester}><Plus size={13} /> Add semester</button>
        </section>

        <SemesterDetail
          semester={activeSemester}
          {activePatternName}
          onSelectPattern={(p) => (activePatternName = p)}
          onSetStatus={(status) => handleSetStatus(activeSemesterNum, status)}
          onAddSubject={openAddSubject}
          onEditSubject={openEditSubject}
          onDeleteSubject={handleDeleteSubject}
          onCopyFrom={handleCopyFrom}
        />
      </div>
    {:else if activeFace === "progress"}
      <SemesterProgress
        {profileId}
        semesterId={activeSemester?.semesterId ?? null}
        {onOpenSubject}
        {onNavigate}
      />
    {:else if activeFace === "career"}
      <CareerPlan {profileId} {onNavigate} {onOpenSubject} />
    {/if}
  </div>
{/if}

<DegreeFormModal
  open={degreeModal.open}
  editing={degreeModal.editing}
  onSave={onSaveDegree}
  onClose={() => (degreeModal = { open: false, editing: null })}
/>
<SubjectFormModal
  open={subjectModal.open}
  editing={subjectModal.editing}
  onSave={onSaveSubject}
  onClose={() => (subjectModal = { open: false, editing: null })}
/>

<style>
  .hub-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .hub-id { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .hub-head h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }
  .trail { text-transform: uppercase; }
  .hub-actions { display: flex; align-items: center; gap: var(--space-2); }

  .scope-chips { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .scope-chip {
    height: 26px;
    padding: 0 10px;
    border-radius: var(--radius-full);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
    font-size: var(--text-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  .scope-chip:hover { color: var(--atlas-ink); border-color: var(--atlas-line-2); }
  .scope-chip.on { border-color: var(--atlas-signal); background: var(--atlas-signal-soft); color: var(--atlas-signal); font-weight: 550; }

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

  .split {
    display: grid;
    grid-template-columns: 360px minmax(0, 1fr);
    gap: var(--space-5);
    align-items: start;
  }
  .rail { display: flex; flex-direction: column; gap: var(--space-3); }
  .atl-band-head h2 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--atlas-ink); }

  .rows { display: flex; flex-direction: column; }

  .sem-row-card {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
    border-top: 1px solid var(--atlas-line);
    cursor: pointer;
  }
  .sem-row-card:hover { background: var(--atlas-wash); }
  .sem-row-card.selected {
    background: var(--atlas-wash-2);
    box-shadow: inset 2px 0 0 var(--atlas-signal);
  }

  .sem-open {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    padding: 6px 0;
    text-align: left;
    cursor: pointer;
  }
  .sem-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex: 0 0 auto;
    border-radius: var(--radius-full);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink-3);
  }
  .sem-row-card[data-tone="ok"] .sem-mark { color: var(--atlas-ok); border-color: var(--atlas-ok); }
  .sem-row-card[data-tone="live"] .sem-mark { color: var(--atlas-signal); border-color: var(--atlas-signal); }

  .sem-name { font-size: var(--text-md); font-weight: 550; color: var(--atlas-ink); }
  .sem-sgpa { font-size: var(--text-sm); color: var(--atlas-ink-2); }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

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

  .link-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 0;
    color: var(--atlas-signal);
    font-size: var(--text-md);
    cursor: pointer;
  }
  .link-btn:hover { text-decoration: underline; }

  @media (max-width: 1000px) {
    .split { grid-template-columns: 1fr; }
  }
</style>
