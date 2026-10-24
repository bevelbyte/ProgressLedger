<script>
  // PlanView — renders the agent's current plan. The plan is stored as
  // JSON in `pm_agents.plan_json` and updated on every step.
  //
  // The renderer now consumes the canonical parsed shape (an array of
  // steps carrying `depends_on`, `assigned_to`, and `files` fields when
  // the model emits them). Legacy arrays still render the same way.

  import { projectModeStore } from "../stores/projectMode.svelte.js";

  const STATUS_ORDER = { running: 0, pending: 1, done: 2, completed: 2, failed: 3, skipped: 4 };

  function statusLabel(s) {
    return s || "pending";
  }

  function isDone(s) {
    return s === "done" || s === "completed";
  }

  function isFailed(s) {
    return s === "failed";
  }

  function isSkipped(s) {
    return s === "skipped";
  }

  function hasDeps(step) {
    return Array.isArray(step && step.depends_on) && step.depends_on.length > 0;
  }

  function hasFiles(step) {
    return Array.isArray(step && step.files) && step.files.length > 0;
  }

  function hasAssignee(step) {
    return typeof step && step.assigned_to === "string" && step.assigned_to.length > 0;
  }
</script>

<div class="plan" data-testid="plan-view">
  <h3 class="title">Plan</h3>
  {#if projectModeStore.plan.length === 0}
    <div class="hint">No plan yet.</div>
  {:else}
    <ul class="steps" data-testid="plan-steps">
      {#each projectModeStore.plan as step (step.id)}
        <li
          class="step"
          class:done={isDone(step.status)}
          class:failed={isFailed(step.status)}
          class:skipped={isSkipped(step.status)}
          data-status={statusLabel(step.status)}
          data-testid="plan-step"
        >
          <span class="status">{statusLabel(step.status)}</span>
          <span class="title-text">{step.title}</span>
          {#if hasAssignee(step)}
            <span class="badge assignee" data-testid="plan-step-assignee" title="Assigned to {step.assigned_to}">
              {step.assigned_to}
            </span>
          {/if}
          {#if hasDeps(step)}
            <span class="badge deps" data-testid="plan-step-deps" title="Depends on {step.depends_on.join(', ')}">
              deps: {step.depends_on.join(", ")}
            </span>
          {/if}
          {#if hasFiles(step)}
            <span class="badge files" data-testid="plan-step-files" title={step.files.join('\n')}>
              {step.files.length} file{step.files.length === 1 ? "" : "s"}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .plan {
    border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px;
    background: var(--surface);
  }
  .title { margin: 0 0 8px 0; font-size: var(--text-md); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
  .hint { color: var(--text-muted); font-size: var(--text-md); }
  .steps { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  .step { display: flex; gap: 8px; align-items: center; padding: 4px 0; flex-wrap: wrap; }
  .status {
    font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em;
    padding: 2px 6px; border-radius: var(--radius-sm); background: var(--bg-main); color: var(--text-muted);
  }
  .step.done .status { background: var(--color-success, var(--atlas-ok)); color: var(--atlas-on-fill); }
  .step.failed .status { background: var(--color-danger); color: var(--atlas-on-fill); }
  .step.skipped .status { background: var(--text-muted); color: #fff; }
  .title-text { color: var(--text-main); font-size: var(--text-lg); }
  .step.done .title-text, .step.failed .title-text, .step.skipped .title-text { color: var(--text-secondary); }
  .badge {
    font-size: var(--text-xs); padding: 2px 6px; border-radius: var(--radius-sm);
    background: var(--bg-main); color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .badge.assignee { background: var(--atlas-signal-soft); color: var(--color-link, var(--atlas-signal)); }
  .badge.deps { font-family: var(--font-mono, monospace); }
  .badge.files { font-style: italic; }
</style>