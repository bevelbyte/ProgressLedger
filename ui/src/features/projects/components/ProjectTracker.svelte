<script>
  // Projects — the Spaces index for builds, and the owner of the two creation
  // dialogs (docs/DESIGN-ATLAS.md §5.2).
  //
  // Was: a wall of bordered cards, each with an inline task list, hand-rolled
  // modal markup duplicated twice, `✎` glyph buttons and a `confirmDialog` call
  // that passed two strings where the primitive takes one options object — so
  // every destructive prompt silently lost its title, its message and its
  // danger styling.
  //
  // Now: an index of Space rows, one shared dialog primitive, and a workspace
  // (ProjectSpace) that carries the tasks.
  import { Search, Plus, FolderKanban, CalendarDays } from "lucide-svelte";
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { Menu, Modal } from "../../../shared/components";
  import { projectsService } from "../services/projects.service.js";
  import ProjectSpace from "./ProjectSpace.svelte";

  let { profileId = null, onNavigate = () => {} } = $props();

  let projects = $state([]);
  let loading = $state(false);
  let openProjectId = $state(null);
  let scope = $state("all"); // all | active | completed
  let searchQuery = $state("");

  // Project dialog
  let projModalOpen = $state(false);
  let editingProj = $state(null);
  let formProjName = $state("");
  let formProjType = $state("mini-project");
  let formProjDeadline = $state("");
  let formProjDesc = $state("");
  let formProjStatus = $state("planning");

  // Task dialog
  let taskModalOpen = $state(false);
  let editingTask = $state(null);
  let activeProjectId = $state(null);
  let formTaskTitle = $state("");
  let formTaskPriority = $state("medium");
  let formTaskDueDate = $state("");
  let formTaskStatus = $state("todo");
  let formTaskNotes = $state("");

  const STATUS_TONE = {
    planning: "var(--atlas-warn)",
    "in-progress": "var(--atlas-signal)",
    "on-hold": "var(--atlas-ink-3)",
    completed: "var(--atlas-ok)",
  };

  const TODAY = new Date().toISOString().slice(0, 10);

  async function loadProjects() {
    if (profileId == null) {
      projects = [];
      return;
    }
    loading = true;
    try {
      const projs = await projectsService.listProjects(profileId);
      for (const p of projs) {
        p.tasks = await projectsService.listTasks(profileId, p.id);
      }
      projects = projs;
    } catch (e) {
      reportError(e, "Could not load projects");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void profileId;
    loadProjects();
  });

  $effect(() => {
    const onChanged = () => loadProjects();
    window.addEventListener("cf:data-changed", onChanged);
    return () => window.removeEventListener("cf:data-changed", onChanged);
  });

  let openProject = $derived(projects.find((p) => p.id === openProjectId) ?? null);

  let visibleProjects = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    return projects.filter((p) => {
      if (scope === "active" && p.status === "completed") return false;
      if (scope === "completed" && p.status !== "completed") return false;
      if (!query) return true;
      return (
        (p.name || "").toLowerCase().includes(query) ||
        (p.project_type || "").toLowerCase().includes(query) ||
        (p.description || "").toLowerCase().includes(query)
      );
    });
  });

  let doneProjects = $derived(projects.filter((p) => p.status === "completed").length);

  function taskCounts(p) {
    const list = p.tasks ?? [];
    return { done: list.filter((t) => t.status === "done").length, total: list.length };
  }

  function dueLabel(iso) {
    if (!iso) return null;
    const then = new Date(`${iso}T00:00:00`).valueOf();
    if (Number.isNaN(then)) return { text: iso, tone: "muted" };
    const d = Math.round((then - new Date(`${TODAY}T00:00:00`).valueOf()) / 86400000);
    if (d < 0) return { text: `${Math.abs(d)}d overdue`, tone: "bad" };
    if (d === 0) return { text: "today", tone: "warn" };
    if (d <= 7) return { text: `in ${d}d`, tone: "warn" };
    return { text: iso, tone: "muted" };
  }

  // --- Project dialog ---

  function openProjDialog(p = null) {
    editingProj = p;
    formProjName = p?.name ?? "";
    formProjStatus = p?.status ?? "planning";
    formProjDeadline = p?.deadline || "";
    formProjDesc = p?.description || "";
    formProjType = p?.project_type ?? "mini-project";
    projModalOpen = true;
  }

  function closeProjDialog() {
    projModalOpen = false;
    editingProj = null;
  }

  async function saveProject() {
    if (!formProjName.trim()) {
      toast.error("A project needs a name.");
      return;
    }
    try {
      if (editingProj) {
        await projectsService.updateProject(
          profileId,
          editingProj.id,
          formProjName.trim(),
          formProjStatus,
          formProjDeadline || null,
          formProjDesc || null
        );
        toast.success("Project updated");
      } else {
        await projectsService.addProject(
          profileId,
          formProjName.trim(),
          formProjType,
          formProjDeadline || null,
          formProjDesc || null
        );
        toast.success("Project added");
      }
      closeProjDialog();
      await loadProjects();
    } catch (e) {
      reportError(e, "Failed to save project");
    }
  }

  async function deleteProject(p) {
    const ok = await confirmDialog({
      title: "Delete project",
      message: `Delete “${p.name}”? Its ${p.tasks?.length ?? 0} task(s) go with it.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await projectsService.removeProject(profileId, p.id);
      if (openProjectId === p.id) openProjectId = null;
      toast.success("Project deleted");
      await loadProjects();
    } catch (e) {
      reportError(e, "Delete failed");
    }
  }

  // --- Task dialog (owned here: ProjectSpace asks, this container writes) ---

  function openTaskDialog(projectId, t = null) {
    activeProjectId = projectId;
    editingTask = t;
    formTaskTitle = t?.title ?? "";
    formTaskStatus = t?.status ?? "todo";
    formTaskPriority = t?.priority ?? "medium";
    formTaskDueDate = t?.due_date || "";
    formTaskNotes = t?.notes || "";
    taskModalOpen = true;
  }

  function closeTaskDialog() {
    taskModalOpen = false;
    editingTask = null;
    activeProjectId = null;
  }

  async function saveTask() {
    if (!formTaskTitle.trim()) {
      toast.error("A task needs a title.");
      return;
    }
    try {
      if (editingTask) {
        await projectsService.updateTask(
          profileId,
          editingTask.id,
          formTaskTitle.trim(),
          formTaskStatus,
          formTaskPriority,
          formTaskDueDate || null,
          formTaskNotes || null
        );
        toast.success("Task updated");
      } else {
        await projectsService.addTask(
          profileId,
          activeProjectId,
          formTaskTitle.trim(),
          formTaskPriority,
          formTaskDueDate || null
        );
        toast.success("Task added");
      }
      closeTaskDialog();
      await loadProjects();
    } catch (e) {
      reportError(e, "Failed to save task");
    }
  }

  /** ProjectSpace asks for either dialog; the container owns the forms. */
  function handleSpaceEdit(kind, payload) {
    const projectId = openProject?.id ?? activeProjectId;
    if (kind === "task") openTaskDialog(projectId, payload);
    else openProjDialog(payload);
  }
</script>

{#if openProject}
  <ProjectSpace
    {profileId}
    project={openProject}
    onBack={() => (openProjectId = null)}
    onEdit={handleSpaceEdit}
    onChanged={loadProjects}
    {onNavigate}
  />
{:else}
  <div class="projects-view atl-view">
    <header class="index-head">
      <div class="index-id">
        <h1>Projects</h1>
        <p class="standing">
          {projects.length} build{projects.length === 1 ? "" : "s"}
          · {projects.length - doneProjects} active
          · {doneProjects} complete
        </p>
      </div>
      <button class="cf-btn primary" onclick={() => openProjDialog()}><Plus size={14} /> New project</button>
    </header>

    <div class="scope-bar">
      <div class="scope-chips" role="group" aria-label="Scope">
        {#each [{ id: "all", label: "All" }, { id: "active", label: "Active" }, { id: "completed", label: "Completed" }] as chip (chip.id)}
          <button
            class="scope-chip"
            class:on={scope === chip.id}
            aria-pressed={scope === chip.id}
            onclick={() => (scope = chip.id)}
          >
            {chip.label}
          </button>
        {/each}
      </div>
      <div class="search-box">
        <Search size={14} aria-hidden="true" />
        <input class="cf-input search" type="text" placeholder="Search projects…" bind:value={searchQuery} />
      </div>
    </div>

    <div class="body">
      {#if loading && projects.length === 0}
        <div class="cf-skeleton skel"></div>
      {:else if visibleProjects.length === 0}
        <div class="cf-empty boxed">
          <FolderKanban size={26} />
          {#if projects.length === 0}
            <h3>No projects yet</h3>
            <p>Mini projects, a major project, a capstone or a hackathon — each becomes a Space here.</p>
            <button class="cf-btn" onclick={() => openProjDialog()}>New project</button>
          {:else}
            <h3>Nothing matches</h3>
            <p>No project matches this scope and search.</p>
          {/if}
        </div>
      {:else}
        <div class="rows">
          {#each visibleProjects as proj (proj.id)}
            {@const counts = taskCounts(proj)}
            {@const due = dueLabel(proj.deadline)}
            <div class="project-row">
              <button class="row-open" onclick={() => (openProjectId = proj.id)}>
                <span class="p-name">{proj.name}</span>
                <span class="p-type">{(proj.project_type || "project").replace("-", " ")}</span>
              </button>
              <span class="p-tasks mono">{counts.done}/{counts.total} tasks</span>
              {#if due}
                <span class="gutter" data-tone={due.tone}>
                  <CalendarDays size={11} aria-hidden="true" />
                  {due.text}
                </span>
              {:else}
                <span class="gutter" data-tone="muted">no deadline</span>
              {/if}
              <span class="p-status" style="color:{STATUS_TONE[proj.status] ?? "var(--atlas-ink-3)"}">
                <span class="dot" aria-hidden="true"></span>
                {(proj.status || "planning").replace("-", " ")}
              </span>
              <Menu
                label="Project options"
                items={[
                  { id: "open", label: "Open", onselect: () => (openProjectId = proj.id) },
                  { id: "edit", label: "Edit", onselect: () => openProjDialog(proj) },
                  { id: "sep", separator: true },
                  { id: "del", label: "Delete", danger: true, onselect: () => deleteProject(proj) },
                ]}
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<Modal
  open={projModalOpen}
  title={editingProj ? "Edit project" : "New project"}
  subtitle="A build you are carrying, with the tasks that finish it."
  width={520}
  onClose={closeProjDialog}
>
  {#snippet children()}
    <form class="form" onsubmit={(e) => { e.preventDefault(); saveProject(); }}>
      <label class="field">
        <span class="atl-label">Name</span>
        <input class="cf-input" type="text" bind:value={formProjName} placeholder="e.g. Distributed key-value store" />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="atl-label">Kind</span>
          <select class="cf-select" bind:value={formProjType} disabled={!!editingProj}>
            <option value="mini-project">Mini project</option>
            <option value="major-project">Major project</option>
            <option value="capstone">Capstone / thesis</option>
            <option value="hackathon">Hackathon</option>
          </select>
        </label>
        {#if editingProj}
          <label class="field">
            <span class="atl-label">Status</span>
            <select class="cf-select" bind:value={formProjStatus}>
              <option value="planning">Planning</option>
              <option value="in-progress">In progress</option>
              <option value="on-hold">On hold</option>
              <option value="completed">Completed</option>
            </select>
          </label>
        {/if}
      </div>
      <label class="field">
        <span class="atl-label">Deadline</span>
        <input class="cf-input" type="date" bind:value={formProjDeadline} />
      </label>
      <label class="field">
        <span class="atl-label">Brief</span>
        <textarea class="cf-textarea" bind:value={formProjDesc} rows="3" placeholder="What is this build for?"></textarea>
      </label>
      <div class="form-actions">
        <button type="button" class="cf-btn ghost sm" onclick={closeProjDialog}>Cancel</button>
        <button type="submit" class="cf-btn primary sm">{editingProj ? "Save changes" : "Create project"}</button>
      </div>
    </form>
  {/snippet}
</Modal>

<Modal
  open={taskModalOpen}
  title={editingTask ? "Edit task" : "New task"}
  subtitle="One unit of work. Priority and date are optional."
  width={500}
  onClose={closeTaskDialog}
>
  {#snippet children()}
    <form class="form" onsubmit={(e) => { e.preventDefault(); saveTask(); }}>
      <label class="field">
        <span class="atl-label">Title</span>
        <input class="cf-input" type="text" bind:value={formTaskTitle} placeholder="e.g. Write the WAL segment reader" />
      </label>
      <div class="field-row">
        {#if editingTask}
          <label class="field">
            <span class="atl-label">Status</span>
            <select class="cf-select" bind:value={formTaskStatus}>
              <option value="todo">To do</option>
              <option value="in-progress">In progress</option>
              <option value="done">Done</option>
            </select>
          </label>
        {/if}
        <label class="field">
          <span class="atl-label">Priority</span>
          <select class="cf-select" bind:value={formTaskPriority}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span class="atl-label">Due date</span>
        <input class="cf-input" type="date" bind:value={formTaskDueDate} />
      </label>
      <label class="field">
        <span class="atl-label">Notes</span>
        <textarea class="cf-textarea" bind:value={formTaskNotes} rows="2"></textarea>
      </label>
      <div class="form-actions">
        <button type="button" class="cf-btn ghost sm" onclick={closeTaskDialog}>Cancel</button>
        <button type="submit" class="cf-btn primary sm">{editingTask ? "Save changes" : "Add task"}</button>
      </div>
    </form>
  {/snippet}
</Modal>

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
  .standing { margin: 0; font-size: var(--text-md); color: var(--atlas-ink-3); font-variant-numeric: tabular-nums; }

  .scope-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--atlas-line);
  }
  .scope-chips { display: flex; align-items: center; gap: var(--space-2); }
  .scope-chip {
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
  .scope-chip.on { border-color: var(--atlas-signal); background: var(--atlas-signal-soft); color: var(--atlas-signal); font-weight: 550; }

  .search-box { display: inline-flex; align-items: center; gap: 6px; color: var(--atlas-ink-3); }
  .search { width: 210px; }

  .body { display: flex; flex-direction: column; gap: var(--space-4); }
  .rows { display: flex; flex-direction: column; }

  .project-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto auto;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
    border-top: 1px solid var(--atlas-line);
  }
  .project-row:hover { background: var(--atlas-wash); }

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
  .p-name {
    font-size: var(--text-md);
    font-weight: 550;
    color: var(--atlas-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-open:hover .p-name { color: var(--atlas-signal); }
  .p-type {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
    white-space: nowrap;
  }
  .p-tasks, .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .p-tasks { font-size: var(--text-sm); color: var(--atlas-ink-2); white-space: nowrap; }

  .gutter {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
    white-space: nowrap;
  }
  .gutter[data-tone="bad"] { color: var(--atlas-bad); }
  .gutter[data-tone="warn"] { color: var(--atlas-warn); }

  .p-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    text-transform: capitalize;
    white-space: nowrap;
  }
  .dot { width: 6px; height: 6px; border-radius: var(--radius-full); background: currentColor; }

  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
  .form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }

  .skel { height: 120px; }

  @media (max-width: 900px) {
    .project-row { grid-template-columns: minmax(0, 1fr) auto auto; }
    .p-tasks, .gutter { display: none; }
  }
</style>
