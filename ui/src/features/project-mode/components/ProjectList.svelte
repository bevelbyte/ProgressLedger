<script>
  // ProjectList — sidebar of pm_projects for the active profile.

  import { Plus, X } from "lucide-svelte";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { projectModeStore, loadProjects, createProject, deleteProject, selectProject } from "../stores/projectMode.svelte.js";

  let { profileId = null, onSelectProject = () => {} } = $props();

  let showForm = $state(false);
  let formName = $state("");
  let formDescription = $state("");
  let formRootPath = $state("");
  let saving = $state(false);

  $effect(() => {
    const pid = profileId;
    if (pid != null) loadProjects(pid).catch((e) => reportError(e, "Could not load projects"));
  });

  async function submit() {
    if (!formName.trim()) {
      toast.warning("Project name is required.", "Missing name");
      return;
    }
    if (!formRootPath.trim()) {
      toast.warning("Project root path is required.", "Missing root path");
      return;
    }
    saving = true;
    try {
      const id = await createProject(profileId, {
        name: formName.trim(),
        description: formDescription.trim(),
        rootPath: formRootPath.trim(),
      });
      selectProject(id);
      onSelectProject(id);
      showForm = false;
      formName = "";
      formDescription = "";
      formRootPath = "";
      toast.success("Project created");
    } catch (e) {
      reportError(e, "Could not create project");
    } finally {
      saving = false;
    }
  }

  async function remove(p) {
    try {
      await deleteProject(profileId, p.id);
      toast.success(`Deleted “${p.name}”`);
    } catch (e) {
      reportError(e, "Could not delete project");
    }
  }
</script>

<div class="project-list" data-testid="project-list">
  <header class="header atl-band-head">
    <h3 class="atl-label">Projects</h3>
    <button
      type="button"
      class="cf-btn ghost sm new-btn"
      onclick={() => (showForm = !showForm)}
      title="New project"
      aria-label="New project"
      aria-expanded={showForm}
      data-testid="new-project-toggle"
    >
      <Plus size={13} strokeWidth={2} aria-hidden="true" />
    </button>
  </header>

  {#if showForm}
    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="new-project-form"
    >
      <input
        class="cf-input"
        placeholder="Name"
        aria-label="Project name"
        bind:value={formName}
        required
        data-testid="new-project-name"
      />
      <input
        class="cf-input"
        placeholder="Root path"
        aria-label="Project root path"
        bind:value={formRootPath}
        required
        data-testid="new-project-root"
      />
      <textarea
        class="cf-textarea"
        placeholder="Description (optional)"
        aria-label="Project description"
        rows="2"
        bind:value={formDescription}
      ></textarea>
      <div class="form-actions">
        <button type="button" class="cf-btn ghost sm" onclick={() => (showForm = false)}>Cancel</button>
        <button type="submit" class="cf-btn primary sm" disabled={saving}>
          {saving ? "Saving…" : "Create"}
        </button>
      </div>
    </form>
  {/if}

  <ul class="list">
    {#each projectModeStore.projects as p (p.id)}
      <li
        class="item"
        class:active={projectModeStore.activeProjectId === p.id}
        data-testid="project-item"
        data-project-id={p.id}
      >
        <button
          class="item-main"
          aria-current={projectModeStore.activeProjectId === p.id ? "true" : undefined}
          onclick={() => {
            selectProject(p.id);
            onSelectProject(p);
          }}
        >
          <span class="item-name">{p.name}</span>
        </button>
        <button
          class="item-remove cf-btn ghost sm"
          title="Delete project"
          aria-label={`Delete ${p.name}`}
          onclick={(e) => {
            e.stopPropagation();
            remove(p);
          }}
        ><X size={12} strokeWidth={2} aria-hidden="true" /></button>
      </li>
    {:else}
      <li class="cf-empty">No projects yet.</li>
    {/each}
  </ul>
</div>

<style>
  .project-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .header h3 {
    font-weight: 600;
  }

  .new-btn {
    width: var(--ctl-h-sm);
    padding: 0;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  /* A project is a destination in a rail, so it renders as a row with a
     current-page marker rather than as a card. */
  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    min-height: 0;
  }

  .item {
    display: flex;
    align-items: stretch;
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .item + .item {
    border-top: 1px solid var(--atlas-line);
  }

  .item:hover {
    background: var(--atlas-wash);
  }

  .item.active {
    background: var(--atlas-signal-soft);
  }

  .item-main {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: var(--atlas-ink);
    display: flex;
    align-items: center;
    padding: 7px var(--space-2);
    min-height: var(--row-h);
    cursor: pointer;
    text-align: left;
  }

  /* The active project is marked by a rule as well as a tint, so the
     indicator survives a colour-blind viewer and a greyscale screenshot. */
  .item.active .item-main {
    box-shadow: inset 2px 0 0 var(--atlas-signal);
  }

  .item-name {
    font-size: var(--text-md);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-remove {
    width: var(--ctl-h-sm);
    padding: 0;
    color: var(--atlas-ink-3);
    flex-shrink: 0;
  }

  .item-remove:hover {
    color: var(--atlas-bad);
  }
</style>