<script>
  // Project Space — the workspace half of the Projects surface
  // (docs/DESIGN-ATLAS.md §5.2).
  //
  // A build is a Space with the same skeleton as a Subject: persistent identity,
  // a persistent readout, then a face strip. Its faces are the four that make
  // sense for the data that actually exists — Overview, Tasks, Deadlines and
  // Operator. Knowledge/Sessions/Research are deliberately absent: a mini
  // project has no notes, no study time and no saved places, and inventing
  // empty rooms for them would be decoration, not design.
  import {
    ChevronLeft, Check, Circle, CirclePlay, CalendarDays, Plus, Pencil, Trash2,
    TerminalSquare, ListChecks, FolderKanban,
  } from "lucide-svelte";
  import { FaceStrip, Menu } from "../../../shared/components";
  import { projectsService } from "../services/projects.service.js";
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null, project = null, onBack = null, onEdit = null, onChanged = () => {}, onNavigate = () => {} } = $props();

  let activeFace = $state("overview");
  let tasks = $state([]);
  let loading = $state(false);

  const TODAY = new Date().toISOString().slice(0, 10);

  const STATUS_TONE = {
    planning: "var(--atlas-warn)",
    "in-progress": "var(--atlas-signal)",
    "on-hold": "var(--atlas-ink-3)",
    completed: "var(--atlas-ok)",
  };

  const TASK_STATE = [
    { id: "todo", label: "To do" },
    { id: "in-progress", label: "In progress" },
    { id: "done", label: "Done" },
  ];

  $effect(() => {
    if (project) loadTasks();
  });

  async function loadTasks() {
    if (!project || profileId == null) return;
    loading = true;
    try {
      tasks = await projectsService.listTasks(profileId, project.id);
    } catch (e) {
      reportError(e, "Could not load tasks");
      tasks = [];
    } finally {
      loading = false;
    }
  }

  function daysFromToday(iso) {
    if (!iso) return null;
    const then = new Date(`${iso}T00:00:00`).valueOf();
    if (Number.isNaN(then)) return null;
    const now = new Date(`${TODAY}T00:00:00`).valueOf();
    return Math.round((then - now) / 86400000);
  }

  function dueLabel(iso) {
    const d = daysFromToday(iso);
    if (d === null) return { text: "no date", tone: "muted" };
    if (d < 0) return { text: `${Math.abs(d)}d overdue`, tone: "bad" };
    if (d === 0) return { text: "today", tone: "warn" };
    if (d === 1) return { text: "tomorrow", tone: "warn" };
    if (d <= 7) return { text: `in ${d}d`, tone: "warn" };
    return { text: iso, tone: "muted" };
  }

  let doneCount = $derived(tasks.filter((t) => t.status === "done").length);
  let openTasks = $derived(tasks.filter((t) => t.status !== "done"));
  let datedTasks = $derived(
    [...tasks].filter((t) => t.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date))
  );
  let nextDue = $derived(datedTasks.find((t) => (daysFromToday(t.due_date) ?? 0) >= 0) ?? null);
  let overdueTasks = $derived(datedTasks.filter((t) => (daysFromToday(t.due_date) ?? 0) < 0 && t.status !== "done"));

  let progressPct = $derived(tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0);

  let attention = $derived.by(() => {
    const out = [];
    if (overdueTasks.length > 0) {
      out.push({ tone: "bad", text: `${overdueTasks.length} task${overdueTasks.length === 1 ? "" : "s"} overdue` });
    }
    const projectDue = daysFromToday(project?.deadline);
    if (projectDue !== null && projectDue < 0) out.push({ tone: "bad", text: "Project deadline passed" });
    if (tasks.length === 0) out.push({ tone: "muted", text: "No tasks yet" });
    else if (openTasks.length === 0) out.push({ tone: "ok", text: "Every task complete" });
    return out;
  });

  let faces = $derived([
    { id: "overview", label: "Overview", icon: FolderKanban },
    { id: "tasks", label: "Tasks", icon: ListChecks, count: openTasks.length },
    { id: "deadlines", label: "Deadlines", icon: CalendarDays, count: datedTasks.length },
    { id: "operator", label: "Operator", icon: TerminalSquare },
  ]);

  async function cycleTaskStatus(t) {
    const order = ["todo", "in-progress", "done"];
    const next = order[(order.indexOf(t.status) + 1) % order.length];
    try {
      await projectsService.updateTask(profileId, t.id, t.title, next, t.priority, t.due_date, t.notes);
      await loadTasks();
      onChanged();
    } catch (e) {
      reportError(e, "Status update failed");
    }
  }

  async function setTask(t, patch) {
    try {
      await projectsService.updateTask(
        profileId,
        t.id,
        patch.title ?? t.title,
        patch.status ?? t.status,
        patch.priority ?? t.priority,
        patch.due_date ?? t.due_date,
        patch.notes ?? t.notes
      );
      await loadTasks();
      onChanged();
    } catch (e) {
      reportError(e, "Could not update task");
    }
  }

  async function deleteTask(t) {
    const ok = await confirmDialog({
      title: "Delete task",
      message: `Delete “${t.title}”?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await projectsService.removeTask(profileId, t.id);
      toast.success("Task deleted");
      await loadTasks();
      onChanged();
    } catch (e) {
      reportError(e, "Delete failed");
    }
  }

  function taskMenu(t) {
    const items = [
      { id: "edit", label: "Edit task", onselect: () => onEdit?.("task", t) },
      { id: "sep", separator: true },
    ];
    for (const s of TASK_STATE) {
      if (s.id !== t.status) {
        items.push({ id: s.id, label: `Mark ${s.label.toLowerCase()}`, onselect: () => setTask(t, { status: s.id }) });
      }
    }
    items.push({ id: "sep2", separator: true });
    items.push({ id: "del", label: "Delete task", danger: true, onselect: () => deleteTask(t) });
    return items;
  }
</script>

{#if project}
  {@const projectDue = dueLabel(project.deadline)}
  <div class="space-ws">
    <button class="back-btn" onclick={onBack}><ChevronLeft size={15} /> Projects</button>

    <header class="space-head">
      <div class="space-id">
        <h2>{project.name}</h2>
        <p class="atl-label trail">{(project.project_type || "project").replace("-", " ")}</p>
      </div>
      <div class="head-actions">
        <span class="status-ctl" style="--tone:{STATUS_TONE[project.status] ?? "var(--atlas-ink-3)"}">
          <span class="dot" aria-hidden="true"></span>
          {(project.status || "planning").replace("-", " ")}
        </span>
        <Menu
          label="Project options"
          items={[
            { id: "edit", label: "Edit project", onselect: () => onEdit?.("project", project) },
          ]}
        />
      </div>
    </header>

    <div class="readout">
      <div class="summary-card">
        <div class="sc-head"><ListChecks size={13} /> Progress</div>
        <div class="sc-main">{doneCount} / {tasks.length} tasks</div>
        <div class="sc-sub">{progressPct}% complete{openTasks.length > 0 ? ` · ${openTasks.length} open` : ""}</div>
      </div>
      <div class="summary-card">
        <div class="sc-head"><CalendarDays size={13} /> Next due</div>
        <div class="sc-main">{nextDue ? dueLabel(nextDue.due_date).text : "—"}</div>
        <div class="sc-sub">{nextDue ? nextDue.title : "No dated task ahead"}</div>
      </div>
      <div class="summary-card">
        <div class="sc-head"><CalendarDays size={13} /> Project deadline</div>
        <div class="sc-main">{project.deadline || "—"}</div>
        <div class="sc-sub">{project.deadline ? projectDue.text : "No deadline set"}</div>
      </div>
    </div>

    <FaceStrip {faces} bind:active={activeFace} label="{project.name} workspace" />

    <div class="face-body">
      {#if activeFace === "overview"}
        {#if attention.length > 0}
          <ul class="attention" aria-label="Attention">
            {#each attention as a (a.text)}
              <li class="chip" data-tone={a.tone}>{a.text}</li>
            {/each}
          </ul>
        {/if}

        {#if project.description}
          <section class="atl-band">
            <div class="atl-band-head"><h3>Brief</h3></div>
            <p class="brief">{project.description}</p>
          </section>
        {/if}

        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Next up</h3>
            <p class="atl-band-note">{openTasks.length} open task{openTasks.length === 1 ? "" : "s"}</p>
            <div class="atl-band-actions">
              <button class="cf-btn ghost" onclick={() => onEdit?.("task", null)}><Plus size={13} /> Add task</button>
            </div>
          </div>
          {#if loading}
            <div class="cf-skeleton skel"></div>
          {:else if openTasks.length === 0}
            <p class="cf-empty">
              {tasks.length === 0 ? "No tasks on this project yet." : "Every task on this project is complete."}
            </p>
          {:else}
            <div class="rows">
              {#each openTasks.slice(0, 5) as t (t.id)}
                <div class="task-row">
                  <button class="task-check" onclick={() => cycleTaskStatus(t)} title="Advance status" aria-label="Advance {t.title}">
                    {#if t.status === "in-progress"}<CirclePlay size={14} />{:else}<Circle size={14} />{/if}
                  </button>
                  <span class="task-title">{t.title}</span>
                  {#if t.priority && t.priority !== "medium"}
                    <span class="cf-badge" data-pri={t.priority}>{t.priority}</span>
                  {/if}
                  {#if t.due_date}
                    {@const label = dueLabel(t.due_date)}
                    <span class="gutter" data-tone={label.tone}>{label.text}</span>
                  {/if}
                </div>
              {/each}
            </div>
            {#if openTasks.length > 5}
              <button class="link-btn" onclick={() => (activeFace = "tasks")}>
                {openTasks.length - 5} more in Tasks
              </button>
            {/if}
          {/if}
        </section>
      {:else if activeFace === "tasks"}
        {#each [{ id: "todo", label: "To do" }, { id: "in-progress", label: "In progress" }, { id: "done", label: "Done" }] as column (column.id)}
          {@const columnTasks = tasks.filter((t) => t.status === column.id)}
          <section class="atl-band">
            <div class="atl-band-head">
              <h3>{column.label}</h3>
              <p class="atl-band-note">
                {columnTasks.length} task{columnTasks.length === 1 ? "" : "s"}
              </p>
              {#if column.id === "todo"}
                <div class="atl-band-actions">
                  <button class="cf-btn ghost" onclick={() => onEdit?.("task", null)}><Plus size={13} /> Add task</button>
                </div>
              {/if}
            </div>
            {#if columnTasks.length === 0}
              <p class="cf-empty">Nothing here.</p>
            {:else}
              <div class="rows">
                {#each columnTasks as t (t.id)}
                  <div class="task-row">
                    <button class="task-check" onclick={() => cycleTaskStatus(t)} title="Advance status" aria-label="Advance {t.title}">
                      {#if t.status === "done"}<Check size={14} strokeWidth={2.5} />
                      {:else if t.status === "in-progress"}<CirclePlay size={14} />
                      {:else}<Circle size={14} />{/if}
                    </button>
                    <button class="task-title as-button" onclick={() => onEdit?.("task", t)}>{t.title}</button>
                    {#if t.priority !== "medium"}<span class="cf-badge" data-pri={t.priority}>{t.priority}</span>{/if}
                    {#if t.due_date}
                      {@const label = dueLabel(t.due_date)}
                      <span class="gutter" data-tone={label.tone}>{label.text}</span>
                    {/if}
                    <Menu label="Task options" items={taskMenu(t)} />
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      {:else if activeFace === "deadlines"}
        <section class="atl-band">
          <div class="atl-band-head">
            <h3>Dated Tasks</h3>
            <p class="atl-band-note">Soonest first. {overdueTasks.length} overdue.</p>
          </div>
          {#if datedTasks.length === 0}
            <p class="cf-empty">No task on this project carries a date.</p>
          {:else}
            <div class="rows">
              {#each datedTasks as t (t.id)}
                {@const label = dueLabel(t.due_date)}
                <div class="task-row">
                  <span class="gutter" data-tone={label.tone}>{label.text}</span>
                  <span class="task-title" class:done={t.status === "done"}>{t.title}</span>
                  <span class="cf-badge" data-tone={t.status === "done" ? "ok" : "muted"}>{t.status.replace("-", " ")}</span>
                  <span class="line-date mono">{t.due_date}</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else if activeFace === "operator"}
        <section class="atl-band">
          <div class="atl-band-head"><h3>Operator</h3></div>
          <p class="honest">
            Agent runs are launched from the <strong>Runs console</strong>, where the project's
            working directory, provider and approvals live. Nothing is listed here so there is
            only ever one place to watch a run.
          </p>
          <div class="band-actions-left">
            <button class="cf-btn" onclick={() => onNavigate("project")}>
              <TerminalSquare size={13} /> Open Runs console
            </button>
          </div>
        </section>
      {/if}
    </div>
  </div>
{/if}

<style>
  .space-ws { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }

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
  }
  .trail { text-transform: uppercase; }
  .head-actions { display: flex; align-items: center; gap: var(--space-2); }

  .status-ctl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--ctl-h);
    padding: 0 11px;
    border-radius: var(--radius-full);
    border: 1px solid var(--tone);
    color: var(--tone);
    font-size: var(--text-md);
    font-weight: 550;
    text-transform: capitalize;
  }
  .dot { width: 6px; height: 6px; border-radius: var(--radius-full); background: currentColor; }

  .readout {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    background: var(--atlas-panel);
    overflow: hidden;
  }
  .summary-card { display: flex; flex-direction: column; gap: 3px; padding: var(--space-3) var(--space-4); min-width: 0; }
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
  .sc-main { font-size: var(--text-xl); font-weight: 600; color: var(--atlas-ink); font-variant-numeric: tabular-nums; }
  .sc-sub { font-size: var(--text-sm); color: var(--atlas-ink-3); }

  .face-body { display: flex; flex-direction: column; gap: var(--space-5); }

  .attention { display: flex; flex-wrap: wrap; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
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
  .chip[data-tone="ok"] { color: var(--atlas-ok); background: var(--atlas-ok-bg); border-color: var(--atlas-ok); }

  .atl-band-head h3 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--atlas-ink); }

  .brief { margin: 0; max-width: 74ch; font-size: var(--text-md); line-height: 1.6; color: var(--atlas-ink-2); }

  .rows { display: flex; flex-direction: column; }

  .task-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
  }
  .task-row + .task-row { border-top: 1px solid var(--atlas-line); }
  .task-row:hover { background: var(--atlas-wash); }

  .task-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    border: 0;
    background: none;
    border-radius: var(--radius-xs);
    color: var(--atlas-ink-3);
    cursor: pointer;
  }
  .task-check:hover { color: var(--atlas-ink); background: var(--atlas-wash-2); }

  .task-title {
    flex: 1;
    min-width: 0;
    font-size: var(--text-md);
    color: var(--atlas-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-title.done { color: var(--atlas-ink-3); text-decoration: line-through; }
  button.task-title {
    text-align: left;
    background: none;
    border: 0;
    padding: 6px 0;
    font: inherit;
    cursor: pointer;
  }
  button.task-title:hover { color: var(--atlas-signal); }

  .gutter {
    flex: 0 0 auto;
    min-width: 9ch;
    text-align: right;
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

  .line-date { font-family: var(--font-mono); font-size: var(--text-micro); color: var(--atlas-ink-3); }

  .cf-badge[data-pri="high"] { color: var(--atlas-bad); background: var(--atlas-bad-bg); }
  .cf-badge[data-pri="low"] { color: var(--atlas-ok); background: var(--atlas-ok-bg); }
  .cf-badge[data-tone="ok"] { color: var(--atlas-ok); background: var(--atlas-ok-bg); }

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

  .honest { margin: 0; max-width: 68ch; font-size: var(--text-md); line-height: 1.6; color: var(--atlas-ink-3); }
  .honest strong { color: var(--atlas-ink-2); font-weight: 600; }
  .band-actions-left { display: flex; gap: var(--space-2); }
  .skel { height: 68px; }

  @media (max-width: 900px) {
    .readout { grid-template-columns: 1fr; }
    .summary-card + .summary-card { border-left: 0; border-top: 1px solid var(--atlas-line); }
  }
</style>
