<script>
  // ToolActivityList — shows running + recently completed tool calls.
  // The agent core emits a status message per tool call + result; this
  // is just a live list of the most recent N.

  import { projectModeStore } from "../stores/projectMode.svelte.js";
</script>

<div class="tool-activity" data-testid="tool-activity">
  <h3 class="title">Tool activity</h3>
  {#if projectModeStore.toolActivity.length === 0}
    <div class="hint">No tool activity yet.</div>
  {:else}
    <ul class="list" data-testid="tool-activity-list">
      {#each projectModeStore.toolActivity as item (item.id)}
        <li class="row" data-status={item.status} data-testid="tool-row">
          <span class="dot"></span>
          <span class="name">{item.name}</span>
          <span class="status">{item.status}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tool-activity { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; background: var(--surface); }
  .title { margin: 0 0 8px 0; font-size: var(--text-md); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
  .hint { color: var(--text-muted); font-size: var(--text-md); }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: var(--text-md); }
  .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--text-muted); flex-shrink: 0;
  }
  .row[data-status="running"] .dot { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .row[data-status="completed"] .dot { background: var(--color-success, var(--atlas-ok)); }
  .row[data-status="failed"] .dot { background: var(--color-danger); }
  .name { color: var(--text-main); font-family: ui-monospace, monospace; }
  .status { margin-left: auto; color: var(--text-muted); font-size: var(--text-sm); text-transform: uppercase; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>