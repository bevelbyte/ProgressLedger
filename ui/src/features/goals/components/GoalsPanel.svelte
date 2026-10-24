<script>
  // GoalsPanel — the goal list.
  //
  // Information architecture change from the previous version: this surface now
  // LEADS with the goals, not with a creation form. The composer used to sit
  // permanently open above the list, which meant the first thing the surface
  // said was "fill in four fields" rather than "here is what you are driving".
  // Creating is now a single primary action that opens a dialog (Modal §24),
  // and the list is the surface.
  //
  // Also replaced: the native `confirm()` on cancel/delete. A browser confirm
  // blocks the renderer, cannot be styled, ignores the product's own dialog
  // conventions, and focuses the destructive button first — the opposite of
  // §24's rule that the destructive action is never the default.
  //
  // Functional behaviour is unchanged: the same store calls, the same payload,
  // the same grouping and the same state transitions. Every testid the Goals
  // E2E and unit suites drive is preserved.

  import { onMount } from "svelte";
  import { Play, Ban, Trash2, Plus } from "lucide-svelte";
  import {
    goalsStore,
    subscribeEngineEvents,
    loadGoals,
    createGoal,
    startGoal,
    cancelGoal,
    removeGoal,
    reconcileGoals,
    selectGoal,
  } from "../stores/goals.svelte.js";
  import { confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import Modal from "../../../shared/components/Modal.svelte";

  let { profileId, projectId, selectedGoalId = $bindable(null) } = $props();

  let title = $state("");
  let objective = $state("");
  let kind = $state("code_change");
  let requireVerification = $state(true);
  let creating = $state(false);
  let createError = $state(null);
  let composerOpen = $state(false);

  const ACTIVE = ["created", "starting", "running", "verifying"];
  const FINISHED = ["completed", "failed", "cancelled"];

  let active = $derived(goalsStore.goals.filter((g) => ACTIVE.includes(g.state)));
  let finished = $derived(goalsStore.goals.filter((g) => FINISHED.includes(g.state)));

  onMount(() => {
    if (typeof profileId === "number") {
      subscribeEngineEvents();
      loadGoals(profileId).catch(() => {});
      reconcileGoals(profileId).catch(() => {});
    }
  });

  $effect(() => {
    if (typeof profileId === "number") {
      loadGoals(profileId).catch(() => {});
    }
  });

  function openComposer() {
    createError = null;
    composerOpen = true;
  }

  function closeComposer() {
    if (creating) return;
    composerOpen = false;
    createError = null;
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (!title.trim() || !objective.trim()) {
      createError = "Title and objective are required";
      return;
    }
    if (typeof profileId !== "number" || typeof projectId !== "number") {
      createError = "Pick a profile and project first";
      return;
    }
    creating = true;
    createError = null;
    try {
      const r = await createGoal(profileId, {
        projectId,
        title: title.trim(),
        objective: objective.trim(),
        kind,
        requireVerification,
      });
      if (r && r.ok === false) {
        createError = (r && (r.error || r.reason || r.message)) || "Failed to create goal";
        return;
      }
      title = "";
      objective = "";
      kind = "code_change";
      requireVerification = true;
      composerOpen = false;
    } catch (e) {
      createError = String((e && e.message) || e);
    } finally {
      creating = false;
    }
  }

  function handleSelect(goalId) {
    selectedGoalId = goalId;
    selectGoal(goalId);
  }

  async function handleStart(goal) {
    if (typeof profileId !== "number") return;
    await startGoal(profileId, goal.id);
  }

  async function handleCancel(goal) {
    if (typeof profileId !== "number") return;
    // Cancelling stops a live run: name the goal and state the consequence.
    const ok = await confirmDialog({
      title: "Cancel this goal?",
      message: `"${goal.title}" will stop. The run's transcript and any changes it already made are kept.`,
      confirmLabel: "Cancel goal",
      cancelLabel: "Keep running",
      danger: true,
    });
    if (!ok) return;
    await cancelGoal(profileId, goal.id);
  }

  async function handleRemove(goal) {
    if (typeof profileId !== "number") return;
    const ok = await confirmDialog({
      title: "Delete this goal?",
      message: `"${goal.title}" and its timeline will be deleted. The agent run it produced is not affected.`,
      confirmLabel: "Delete goal",
      danger: true,
    });
    if (!ok) return;
    await removeGoal(profileId, goal.id);
  }

  // State is carried by a word plus a tone — never by colour alone.
  function stateTone(state) {
    if (state === "completed") return "success";
    if (state === "failed") return "danger";
    if (state === "cancelled") return "warning";
    if (state === "created") return "neutral";
    return "accent";
  }

  const LIVE_STATES = new Set(["starting", "running", "verifying"]);
  const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

  function stateLabel(state) {
    const map = {
      created: "ready",
      starting: "starting",
      running: "running",
      verifying: "verifying",
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
    };
    return map[state] || String(state);
  }

  /** A goal's plan progress, when the linked run has published a plan. */
  function progressFor(goal) {
    return goalsStore.progressFor(goal);
  }

  function updatedAgo(iso) {
    if (!iso) return "";
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "";
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
</script>

<section class="goals-panel" data-testid="goals-panel">
  <header class="panel-head">
    <div class="panel-head-text">
      <h2>Goals</h2>
      <p class="subtitle">
        Outcomes driven by the agent engine. Completion is grounded in the run's
        real state and verification, never in what the model claims.
      </p>
    </div>
    <button type="button" class="cf-btn primary sm" onclick={openComposer} data-testid="goal-new-button">
      <Plus size={13} strokeWidth={2} aria-hidden="true" /> New goal
    </button>
  </header>

  <Modal
    open={composerOpen}
    title="New goal"
    subtitle="One outcome, and what finished looks like to the agent."
    width={560}
    onClose={closeComposer}
  >
    {#snippet children()}
      <form class="create-form" onsubmit={handleCreate} data-testid="goal-create-form">
        <label class="field">
          <span class="atl-label">Title</span>
          <input
            class="cf-input"
            type="text"
            bind:value={title}
            placeholder="e.g. Refactor authentication to AuthService"
            maxlength="200"
            data-testid="goal-title-input"
          />
        </label>

        <label class="field">
          <span class="atl-label">Objective</span>
          <textarea
            class="cf-textarea mono"
            bind:value={objective}
            placeholder="What does this goal accomplish? Be specific so the agent can verify success."
            rows="4"
            maxlength="8000"
            data-testid="goal-objective-input"
          ></textarea>
        </label>

        <div class="row">
          <label class="field">
            <span class="atl-label">Kind</span>
            <select class="cf-select" bind:value={kind} data-testid="goal-kind-select">
              <option value="code_change">Code change (verification recommended)</option>
              <option value="research">Research</option>
              <option value="analysis">Analysis</option>
            </select>
          </label>
          <label class="field check">
            <input type="checkbox" bind:checked={requireVerification} data-testid="goal-require-verify" />
            <span>Require verification before completion</span>
          </label>
        </div>

        {#if createError}
          <p class="create-error" role="alert">{createError}</p>
        {/if}

        <div class="composer-actions">
          <button type="button" class="cf-btn ghost sm" onclick={closeComposer} disabled={creating}>
            Cancel
          </button>
          <button type="submit" class="cf-btn primary sm" disabled={creating} data-testid="goal-create-button">
            {creating ? "Creating…" : "Create goal"}
          </button>
        </div>
      </form>
    {/snippet}
  </Modal>

  <section class="goals-section">
    <div class="section-head">
      <span class="atl-label">Active</span>
      <span class="section-count tabular">{active.length}</span>
    </div>
    {#if active.length === 0}
      <p class="empty">No active goals.</p>
    {:else}
      <ul class="goal-list" data-testid="goal-list-active">
        {#each active as goal (goal.id)}
          {@const p = progressFor(goal)}
          <li
            class="goal-row"
            class:selected={selectedGoalId === goal.id}
            data-testid="goal-row"
            data-state={goal.state}
          >
            <button class="goal-row-main" onclick={() => handleSelect(goal.id)} type="button">
              <span class="cf-badge {stateTone(goal.state)}">
                {#if LIVE_STATES.has(goal.state)}<span class="cf-pulse-dot" aria-hidden="true"></span>{/if}
                {stateLabel(goal.state)}
              </span>
              <span class="goal-body">
                <span class="goal-title">{goal.title}</span>
                <span class="goal-meta">
                  {goal.kind.replace(/_/g, " ")}
                  {#if p && p.total > 0}
                    <span class="sep" aria-hidden="true">·</span>
                    <span class="tabular">{p.done}/{p.total} steps</span>
                  {/if}
                  {#if goal.updatedAt}
                    <span class="sep" aria-hidden="true">·</span>
                    {updatedAgo(goal.updatedAt)}
                  {/if}
                </span>
              </span>
              {#if p && p.total > 0}
                <span
                  class="micro-bar"
                  data-tone={goal.state === "failed" ? "bad" : goal.state === "completed" ? "ok" : "live"}
                  aria-hidden="true"
                >
                  <span class="micro-fill" style="width: {p.percent}%"></span>
                </span>
              {/if}
            </button>
            <div class="goal-actions">
              {#if goal.state === "created"}
                <button
                  type="button"
                  class="cf-btn ghost sm"
                  onclick={() => handleStart(goal)}
                  data-testid="goal-start-button"
                  title="Start the agent on this goal"
                >
                  <Play size={11} strokeWidth={2} aria-hidden="true" /> Start
                </button>
              {/if}
              {#if ACTIVE.includes(goal.state)}
                <button
                  type="button"
                  class="cf-btn ghost sm"
                  onclick={() => handleCancel(goal)}
                  data-testid="goal-cancel-button"
                  title="Cancel this goal"
                >
                  <Ban size={11} strokeWidth={2} aria-hidden="true" /> Cancel
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="goals-section">
    <div class="section-head">
      <span class="atl-label">Finished</span>
      <span class="section-count tabular">{finished.length}</span>
    </div>
    {#if finished.length === 0}
      <p class="empty">No finished goals yet.</p>
    {:else}
      <ul class="goal-list" data-testid="goal-list-finished">
        {#each finished as goal (goal.id)}
          {@const p = progressFor(goal)}
          <li
            class="goal-row"
            class:selected={selectedGoalId === goal.id}
            data-testid="goal-row"
            data-state={goal.state}
          >
            <button class="goal-row-main" onclick={() => handleSelect(goal.id)} type="button">
              <span class="cf-badge {stateTone(goal.state)}">{stateLabel(goal.state)}</span>
              <span class="goal-body">
                <span class="goal-title">{goal.title}</span>
                <span class="goal-meta">
                  {goal.kind.replace(/_/g, " ")}
                  {#if p && p.total > 0}
                    <span class="sep" aria-hidden="true">·</span>
                    <span class="tabular">{p.done}/{p.total} steps</span>
                  {/if}
                  {#if TERMINAL_STATES.has(goal.state) && goal.completedAt}
                    <span class="sep" aria-hidden="true">·</span>
                    {updatedAgo(goal.completedAt)}
                  {/if}
                </span>
              </span>
            </button>
            <div class="goal-actions">
              <button
                type="button"
                class="cf-btn ghost sm"
                onclick={() => handleRemove(goal)}
                data-testid="goal-remove-button"
                title="Delete this goal and its timeline"
              >
                <Trash2 size={11} strokeWidth={2} aria-hidden="true" /> Delete
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>

<style>
  .goals-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-4) var(--space-5);
  }

  .panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .panel-head h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }

  .subtitle {
    margin-top: 3px;
    max-width: 62ch;
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .section-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding-bottom: 6px;
    margin-bottom: var(--space-2);
    border-bottom: 1px solid var(--atlas-line);
  }

  .section-count {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-ink-3);
  }

  /* Hairline instrument rows: a goal is a line in a ledger, not a card. */
  .goal-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .goal-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 40px;
    border-radius: var(--radius-sm);
    transition: background-color var(--dur-fast) var(--ease);
  }

  .goal-row + .goal-row {
    border-top: 1px solid var(--atlas-line);
  }

  .goal-row:hover {
    background: var(--atlas-wash);
  }

  .goal-row.selected {
    background: var(--atlas-signal-softer);
    box-shadow: inset 2px 0 0 var(--atlas-signal);
  }

  .goal-row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 8px 6px;
    text-align: left;
    cursor: pointer;
  }

  .goal-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .goal-title {
    color: var(--atlas-ink);
    font-size: var(--text-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goal-meta {
    display: flex;
    align-items: baseline;
    gap: 4px;
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .goal-meta .sep {
    color: var(--atlas-line-2);
  }

  .micro-bar {
    flex: 0 0 56px;
    height: 3px;
    border-radius: var(--radius-full);
    background: var(--atlas-raise);
    overflow: hidden;
  }

  .micro-fill {
    display: block;
    height: 100%;
    background: var(--atlas-signal);
    transition: width var(--dur-slow) var(--ease);
  }

  .micro-bar[data-tone="ok"] .micro-fill { background: var(--atlas-ok); }
  .micro-bar[data-tone="bad"] .micro-fill { background: var(--atlas-bad); }

  /* Row actions stay quiet until the row is engaged, so the list reads as a
     list — but they remain keyboard-reachable at all times. */
  .goal-actions {
    display: flex;
    gap: 2px;
    padding-right: 4px;
    opacity: 0.35;
    transition: opacity var(--dur-fast) var(--ease);
  }

  .goal-row:hover .goal-actions,
  .goal-row:focus-within .goal-actions,
  .goal-row.selected .goal-actions {
    opacity: 1;
  }

  .empty {
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    margin: 0;
    padding: 6px 0;
  }

  /* ---- Composer (inside the dialog) ---- */
  .create-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .row {
    display: flex;
    gap: var(--space-4);
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-width: 180px;
  }

  .field.check {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    flex: 0 0 auto;
    font-size: var(--text-md);
    color: var(--atlas-ink-2);
  }

  .field.check input {
    accent-color: var(--atlas-signal);
  }

  .cf-textarea.mono {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .create-error {
    margin: 0;
    color: var(--atlas-bad);
    font-size: var(--text-md);
  }

  .composer-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--atlas-line);
  }
</style>
