<script>
  // GoalsView — the Goals destination.
  //
  // Two states, both deliberate:
  //
  //   1. No project chosen. Goals drive an agent run, and a run needs a project
  //      root on disk, so a project really is a prerequisite — but a
  //      prerequisite should be *explained*, not stumbled into. This state says
  //      what a project is for, and lists yours as hairline rows.
  //   2. Project chosen. A two-pane ledger: goals on the left, the selected
  //      goal's orchestration summary on the right.
  //
  // The recovery banner is where a previous session's interrupted runs surface.
  // Recovery is EXPLICIT here: the sweep classifies, the user decides. Nothing
  // is auto-resumed, because resuming an agent is a consequential action.

  import { ArrowRight, RotateCcw } from "lucide-svelte";
  import { goalsStore } from "../stores/goals.svelte.js";
  import { projectModeStore, loadProjects, selectProject } from "../../project-mode/stores/projectMode.svelte.js";
  import GoalsPanel from "./GoalsPanel.svelte";
  import GoalDetailView from "./GoalDetailView.svelte";

  let { profileId } = $props();

  let selectedGoalId = $state(null);
  let activeGoal = $derived(
    selectedGoalId != null
      ? goalsStore.goals.find((g) => g.id === selectedGoalId) || null
      : null
  );

  let pickedProjectId = $state(null);
  let projectsLoaded = $state(false);
  let recoveryResult = $state(null);
  let recoveryLoading = $state(false);

  $effect(() => {
    if (typeof profileId !== "number") return;
    if (projectModeStore.projects.length === 0) {
      loadProjects(profileId).then(() => { projectsLoaded = true; }).catch(() => { projectsLoaded = true; });
    } else {
      projectsLoaded = true;
      if (pickedProjectId == null && projectModeStore.activeProjectId != null) {
        pickedProjectId = projectModeStore.activeProjectId;
      }
    }
  });

  // Phase 15 — startup recovery sweep. Run once when the view mounts for an
  // active profile. The IPC returns rows that need attention (or that were
  // classified as safe-resume); the panel surfaces them, and the user decides.
  $effect(() => {
    if (typeof profileId !== "number") return;
    if (recoveryResult != null) return; // one-shot
    recoveryLoading = true;
    const svc = window.progressLedger && window.progressLedger.goals;
    if (!svc || typeof svc.recoverySweep !== "function") {
      recoveryLoading = false;
      return;
    }
    svc.recoverySweep(profileId).then((r) => {
      recoveryResult = r;
      recoveryLoading = false;
    }).catch(() => { recoveryLoading = false; });
  });

  let resumingId = $state(null);

  function resumeRow(row) {
    // EXPLICIT, user-driven resume. The sweep never auto-resumes: clicking
    // Resume re-attaches the existing agent loop through `goal:resume`, which
    // continues from the persisted plan — no replay of completed steps and no
    // duplicate agent.
    if (!row || typeof row.agent_id !== "number") return;
    const agentId = row.agent_id;
    const svc = window.progressLedger && window.progressLedger.goals;
    if (!svc || typeof svc.resume !== "function") {
      window.dispatchEvent(new CustomEvent("cf:open-agent", { detail: { agentId } }));
      return;
    }
    resumingId = agentId;
    svc.resume(profileId, row.goal_id ?? null, agentId)
      .then((r) => {
        if (r && r.ok === false) {
          window.dispatchEvent(new CustomEvent("cf:open-agent", { detail: { agentId } }));
        }
      })
      .catch(() => {
        window.dispatchEvent(new CustomEvent("cf:open-agent", { detail: { agentId } }));
      })
      .finally(() => { resumingId = null; });
  }

  function handleOpenAgent(agentId) {
    if (agentId == null) return;
    window.dispatchEvent(new CustomEvent("cf:open-agent", { detail: { agentId } }));
  }

  function handlePickProject(projectId) {
    pickedProjectId = projectId;
    selectProject(projectId);
    selectedGoalId = null;
  }

  /** Tone for a recovery classification — meaning only, never decoration. */
  function recoveryTone(classification) {
    if (classification === "safe-resume") return "success";
    if (classification === "requires-user") return "warning";
    if (classification === "stale") return "danger";
    return "neutral";
  }
</script>

<section class="goals-view" data-testid="goals-view">
  {#if pickedProjectId == null}
    <div class="picker" data-testid="goals-project-picker">
      <header class="picker-head">
        <p class="atl-label">Workspace</p>
        <h2>Goals run inside a project</h2>
        <p class="picker-lede">
          A project is the folder an agent run is allowed to touch. Pick the one
          this goal belongs to — you can switch at any time.
        </p>
      </header>

      {#if !projectsLoaded}
        <p class="loading">Loading projects…</p>
      {:else if projectModeStore.projects.length === 0}
        <p class="empty">
          No projects exist yet. Create one in
          <button type="button" class="inline-nav" onclick={() => window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "project" } }))}>Runs</button>
          first.
        </p>
      {:else}
        <ul class="project-list" data-testid="goals-project-list">
          {#each projectModeStore.projects as p (p.id)}
            <li>
              <button class="project-row" onclick={() => handlePickProject(p.id)} data-testid="goals-pick-project" data-project-id={p.id}>
                <span class="project-body">
                  <span class="project-name">{p.name}</span>
                  {#if p.description}<span class="project-desc">{p.description}</span>{/if}
                </span>
                <ArrowRight size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <div class="goals-grid">
      <div class="list-pane" data-testid="goals-list-pane">
        <header class="picked-header">
          <span class="atl-label">Project</span>
          <strong class="picked-name">{projectModeStore.activeProject ? projectModeStore.activeProject.name : ''}</strong>
          <button type="button" class="cf-btn ghost sm" onclick={() => { pickedProjectId = null; selectedGoalId = null; }} data-testid="goals-switch-project">
            Switch
          </button>
        </header>

        {#if recoveryLoading}
          <p class="recovery-loading atl-label">Checking for interrupted runs…</p>
        {:else if recoveryResult && (recoveryResult.resumable || []).length > 0}
          <section class="recovery-banner" data-testid="goals-recovery-banner">
            <div class="recovery-head">
              <RotateCcw size={13} strokeWidth={1.8} aria-hidden="true" />
              <span class="atl-label on-ink">Interrupted runs</span>
              <span class="recovery-count tabular">{recoveryResult.resumable.length}</span>
            </div>
            <p class="recovery-lede">
              {recoveryResult.resumable.length} run{recoveryResult.resumable.length === 1 ? "" : "s"} from a previous
              session need a decision. Nothing resumes on its own.
            </p>
            <ul class="recovery-list">
              {#each (recoveryResult.resumable || []).slice(0, 6) as row (row.id)}
                <li class="recovery-row">
                  <span class="cf-badge {recoveryTone(row.classification)} recover-class recover-{row.classification}">
                    {row.classification.replace('-', ' ')}
                  </span>
                  <span class="recovery-what">
                    <span class="recovery-agent tabular">Agent #{row.agent_id}</span>
                    <span class="recovery-reason">{row.phase} · {row.reason || "no reason recorded"}</span>
                  </span>
                  {#if row.classification === 'safe-resume'}
                    <button type="button" class="cf-btn sm secondary" onclick={() => resumeRow(row)} data-testid="recover-resume">
                      {resumingId === (row.agent_id ?? row.agentId) ? 'Resuming…' : 'Resume'}
                    </button>
                  {:else}
                    <!--
                      "Open" NAVIGATES. It must never resume: `resumeRow` calls
                      `goal:resume`, which re-attaches the agent loop and
                      continues executing the persisted plan. A control labelled
                      "Open" that silently starts work is exactly the kind of
                      control this banner exists to prevent, and the banner copy
                      says "Nothing resumes on its own" — so a row the sweep
                      classified as `requires-user` / `stale` is the one case
                      that must be opened and inspected, never advanced.
                    -->
                    <button type="button" class="cf-btn sm ghost" onclick={() => handleOpenAgent(row.agent_id ?? row.agentId)} data-testid="recover-row">
                      Open
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <GoalsPanel {profileId} projectId={pickedProjectId} bind:selectedGoalId />
      </div>

      <div class="detail-pane" data-testid="goals-detail-pane">
        {#if activeGoal}
          <GoalDetailView goal={activeGoal} onOpenAgent={handleOpenAgent} />
        {:else}
          <div class="empty-detail" data-testid="goals-empty-detail">
            <p class="atl-label">Goal</p>
            <h3>Nothing selected</h3>
            <p>
              Pick a goal to see its progress, timeline and linked run — or start
              a new one. Progress here is read from the run's own plan, so it is
              never an estimate.
            </p>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .goals-view {
    width: 100%;
  }

  /* ---- Workspace picker ---- */
  .picker {
    max-width: 620px;
    margin: 0 auto;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    background: var(--atlas-panel);
    padding: var(--space-5);
  }

  .picker-head {
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-3);
    border-bottom: 1px solid var(--atlas-line);
  }

  .picker-head h2 {
    margin-top: 4px;
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--atlas-ink);
  }

  .picker-lede {
    margin-top: 4px;
    max-width: 60ch;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    line-height: 1.5;
  }

  .inline-nav {
    padding: 0;
    border: 0;
    background: none;
    color: var(--atlas-signal-2);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }

  .loading,
  .empty {
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    margin: 0;
  }

  .project-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .project-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 9px 6px;
    text-align: left;
    color: inherit;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background-color var(--dur-fast) var(--ease);
  }

  /* The rows are buttons inside list items, so the hairline belongs on the
     list item — a sibling selector on the buttons would never match. */
  .project-list li + li {
    border-top: 1px solid var(--atlas-line);
  }

  .project-row:hover {
    background: var(--atlas-wash);
  }

  .project-row :global(svg) {
    color: var(--atlas-ink-3);
  }

  .project-row:hover :global(svg) {
    color: var(--atlas-signal);
  }

  .project-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .project-name {
    color: var(--atlas-ink);
    font-size: var(--text-md);
    font-weight: 500;
  }

  .project-desc {
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Two-pane ledger ---- */
  .goals-grid {
    display: grid;
    grid-template-columns: minmax(380px, 1fr) minmax(420px, 1.35fr);
    gap: var(--space-5);
    align-items: start;
  }

  .list-pane,
  .detail-pane {
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    background: var(--atlas-panel);
    overflow: hidden;
  }

  .detail-pane {
    min-height: 380px;
  }

  .picked-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 10px var(--space-4);
    border-bottom: 1px solid var(--atlas-line);
    background: var(--atlas-chrome);
  }

  .picked-name {
    flex: 1;
    min-width: 0;
    font-size: var(--text-md);
    font-weight: 500;
    color: var(--atlas-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Recovery ---- */
  .recovery-loading {
    display: block;
    padding: 10px var(--space-4);
    color: var(--atlas-ink-3);
  }

  .recovery-banner {
    margin: var(--space-3) var(--space-4);
    border: 1px solid var(--atlas-warn-line);
    border-left-width: 3px;
    border-radius: var(--radius-md);
    background: var(--atlas-warn-bg);
    padding: var(--space-3);
  }

  .recovery-head {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--atlas-warn);
  }

  .recovery-count {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-warn);
  }

  .recovery-lede {
    margin: 6px 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--atlas-ink-2);
  }

  .recovery-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .recovery-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 30px;
    font-size: var(--text-sm);
  }

  .recovery-row + .recovery-row {
    border-top: 1px solid var(--atlas-line);
  }

  .recovery-what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .recovery-agent {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--atlas-ink);
  }

  .recovery-reason {
    color: var(--atlas-ink-3);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Classification tints ride the shared badge; these class names are kept so
     anything matching on `recover-*` keeps working. */
  .recover-class.recover-safe-resume { color: var(--atlas-ok); background: var(--atlas-ok-bg); }
  .recover-class.recover-requires-user { color: var(--atlas-warn); background: var(--atlas-warn-bg); }
  .recover-class.recover-stale { color: var(--atlas-bad); background: var(--atlas-bad-bg); }
  .recover-class.recover-terminal-cleanup { color: var(--atlas-ink-3); background: var(--atlas-hover); }

  /* ---- Empty detail ---- */
  .empty-detail {
    padding: var(--space-6);
  }

  .empty-detail h3 {
    margin: 4px 0 6px;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--atlas-ink);
  }

  .empty-detail p {
    margin: 0;
    max-width: 52ch;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    line-height: 1.55;
  }

  @media (max-width: 1080px) {
    .goals-grid { grid-template-columns: 1fr; }
  }
</style>
