<script>
  // GoalDetailView — a goal's orchestration summary.
  //
  // This is deliberately NOT the agent transcript (that lives in the Runs
  // console, which this view links to). It answers four questions in order:
  // what am I driving, how far along is it, what happened, and what did it
  // produce.
  //
  // Atlas treatment: the progress bar is the only filled shape on the surface,
  // because it is the only thing that is genuinely a proportion. Everything
  // else is hairlines and mono readouts — the state word is always present
  // beside the colour, and a live phase carries a pulse dot rather than a
  // second brand colour.

  import { goalsStore } from "../stores/goals.svelte.js";
  import { ArrowUpRight, CircleDot } from "lucide-svelte";

  let { goal, onOpenAgent } = $props();

  let progress = $derived(goal ? goalsStore.progressFor(goal) : null);
  let events = $derived(goal ? goalsStore.events.filter((e) => e.goalId === goal.id) : []);

  // Live = the operator is doing something right now. Treatment, not hue.
  const LIVE_PHASES = new Set(["preparing", "planning", "executing", "verifying", "recovering"]);

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_e) {
      return String(iso);
    }
  }

  function phaseTone(phase) {
    if (phase === "completed") return "success";
    if (phase === "failed") return "danger";
    if (phase === "cancelled") return "warning";
    if (LIVE_PHASES.has(phase)) return "accent";
    return "neutral";
  }

  // The bar's fill follows the phase, so a failed run never reads as progress.
  function barTone(phase) {
    if (phase === "completed") return "ok";
    if (phase === "failed") return "bad";
    if (phase === "cancelled") return "warn";
    return "live";
  }

  function humanizeKind(kind) {
    const map = { code_change: "code change", research: "research", analysis: "analysis" };
    return map[kind] || String(kind);
  }

  function humanizeEvent(evt) {
    const map = {
      state_changed: "state changed",
      agent_linked: "agent linked",
      created: "created",
      started: "started",
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
      note: "note",
    };
    return map[evt] || String(evt).replace(/_/g, " ");
  }

  /** Semantic tone for a timeline row, so state changes are scannable. */
  function eventTone(evt) {
    if (evt === "completed") return "ok";
    if (evt === "failed") return "bad";
    if (evt === "cancelled") return "warn";
    if (evt === "state_changed" || evt === "started") return "live";
    return "muted";
  }
</script>

{#if !goal}
  <div class="empty">No goal selected.</div>
{:else}
  {@const phase = progress ? progress.phase : goal.state}
  <article class="goal-detail" data-testid="goal-detail" data-goal-id={goal.id} data-state={goal.state}>
    <header class="detail-header">
      <h2>{goal.title}</h2>
      <span class="cf-badge {phaseTone(phase)}" data-testid="goal-state-pill">
        {#if LIVE_PHASES.has(phase)}<span class="cf-pulse-dot" aria-hidden="true"></span>{/if}
        {goalsStore.phaseLabel(phase)}
      </span>
    </header>

    <p class="objective">{goal.objective}</p>

    {#if progress}
      <section class="progress" data-testid="goal-progress">
        <div class="band-head">
          <span class="atl-label">Plan progress</span>
          {#if progress.total > 0}
            <span class="prog-readout tabular">
              <span data-testid="goal-progress-percent">{progress.percentReliable ? progress.percent : '?'}%</span>
              <span class="sep" aria-hidden="true">·</span>
              <span data-testid="goal-progress-done">{progress.done}</span> done
              <span class="sep" aria-hidden="true">·</span>
              <span data-testid="goal-progress-running">{progress.running}</span> running
              <span class="sep" aria-hidden="true">·</span>
              <span data-testid="goal-progress-pending">{progress.pending}</span> pending
              <span class="sep" aria-hidden="true">·</span>
              <span data-testid="goal-progress-failed">{progress.failed}</span> failed
              <span class="sep" aria-hidden="true">·</span>
              <span data-testid="goal-progress-total">{progress.total}</span> total
            </span>
          {/if}
        </div>
        {#if progress.total > 0}
          <div class="bar" role="progressbar" aria-label="Plan progress" aria-valuenow={progress.percent} aria-valuemin="0" aria-valuemax="100">
            <div class="bar-fill {barTone(phase)}" style="width: {progress.percent}%"></div>
          </div>
        {:else}
          <p class="muted" data-testid="goal-progress-empty">No plan yet — agent is {goalsStore.phaseLabel(progress.phase).toLowerCase()}.</p>
        {/if}
      </section>
    {/if}

    <section class="meta-band">
      <dl class="meta">
        <dt>Kind</dt><dd>{humanizeKind(goal.kind)}</dd>
        <dt>Verification</dt><dd>{goal.requireVerification ? "required before completion" : "not required"}</dd>
        <dt>Created</dt><dd>{fmtTime(goal.createdAt)}</dd>
        <dt>Started</dt><dd>{fmtTime(goal.startedAt)}</dd>
        <dt>Completed</dt><dd>{fmtTime(goal.completedAt)}</dd>
        <dt>Run</dt>
        <dd>
          {#if goal.linkedAgentId}
            <button type="button" class="run-link" onclick={() => onOpenAgent && onOpenAgent(goal.linkedAgentId)} data-testid="open-agent-button">
              <CircleDot size={12} strokeWidth={2} aria-hidden="true" />
              Agent #{goal.linkedAgentId}
              <ArrowUpRight size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>
          {:else}
            <span class="muted">none yet</span>
          {/if}
        </dd>
      </dl>
    </section>

    {#if goal.failureReason}
      <section class="notice bad">
        <p class="atl-label on-ink">Failure reason</p>
        <pre data-testid="goal-failure-reason">{goal.failureReason}</pre>
      </section>
    {/if}

    {#if goal.resultText}
      <section class="notice ok">
        <p class="atl-label on-ink">Result</p>
        <pre data-testid="goal-result">{goal.resultText}</pre>
      </section>
    {/if}

    <section class="timeline">
      <div class="band-head">
        <span class="atl-label">Timeline</span>
        <span class="prog-readout tabular">{events.length} event{events.length === 1 ? "" : "s"}</span>
      </div>
      {#if events.length === 0}
        <p class="muted">No events yet.</p>
      {:else}
        <ul class="timeline-list" data-testid="goal-timeline">
          {#each events as evt (evt.id)}
            <li class="timeline-row" data-event={evt.event} data-tone={eventTone(evt.event)}>
              <span class="evt-time">{fmtTime(evt.createdAt)}</span>
              <span class="evt-name">{humanizeEvent(evt.event)}</span>
              <span class="evt-msg">{evt.message}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </article>
{/if}

<style>
  .goal-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-4) var(--space-5);
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .detail-header h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }

  .objective {
    margin: 0;
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
    line-height: 1.55;
    white-space: pre-wrap;
    max-width: 76ch;
  }

  /* A mono label with its readout on the same baseline — the instrument voice. */
  .band-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    padding-bottom: 6px;
    border-bottom: 1px solid var(--atlas-line);
    margin-bottom: var(--space-2);
  }

  .prog-readout {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--atlas-ink-2);
    white-space: nowrap;
  }

  .prog-readout .sep {
    color: var(--atlas-ink-3);
    margin: 0 5px;
  }

  .bar {
    width: 100%;
    height: 4px;
    background: var(--atlas-raise);
    border-radius: var(--radius-full);
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    background: var(--atlas-signal);
    transition: width var(--dur-slow) var(--ease);
  }
  .bar-fill.ok { background: var(--atlas-ok); }
  .bar-fill.bad { background: var(--atlas-bad); }
  .bar-fill.warn { background: var(--atlas-warn); }

  .meta {
    display: grid;
    grid-template-columns: minmax(96px, max-content) 1fr;
    gap: 7px var(--space-4);
    margin: 0;
  }

  .meta dt {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
    padding-top: 2px;
  }

  .meta dd {
    margin: 0;
    font-size: var(--text-md);
    color: var(--atlas-ink);
  }

  .muted {
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
  }

  .run-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--ctl-h-sm);
    padding: 0 9px;
    border-radius: var(--radius-md);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .run-link:hover {
    border-color: var(--atlas-signal);
    color: var(--atlas-signal-2);
  }

  /* Notices state a fact about the run's outcome; the edge carries the tone. */
  .notice {
    border: 1px solid var(--atlas-line);
    border-left-width: 3px;
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: var(--atlas-panel);
  }

  .notice.bad {
    border-left-color: var(--atlas-bad);
    background: var(--atlas-bad-bg);
  }

  .notice.ok {
    border-left-color: var(--atlas-ok);
    background: var(--atlas-ok-bg);
  }

  .notice pre {
    margin: 6px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--atlas-ink);
  }

  .timeline-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 260px;
    overflow-y: auto;
  }

  .timeline-row {
    display: grid;
    grid-template-columns: max-content minmax(88px, max-content) 1fr;
    gap: var(--space-3);
    align-items: baseline;
    padding: 5px 0;
    font-size: var(--text-sm);
  }

  .timeline-row + .timeline-row {
    border-top: 1px solid var(--atlas-line);
  }

  .evt-time {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--atlas-ink-3);
    white-space: nowrap;
  }

  .evt-name {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--atlas-ink-2);
  }

  .timeline-row[data-tone="live"] .evt-name { color: var(--atlas-signal-2); }
  .timeline-row[data-tone="ok"] .evt-name { color: var(--atlas-ok); }
  .timeline-row[data-tone="bad"] .evt-name { color: var(--atlas-bad); }
  .timeline-row[data-tone="warn"] .evt-name { color: var(--atlas-warn); }

  .evt-msg {
    color: var(--atlas-ink-2);
    overflow-wrap: anywhere;
  }

  .empty {
    padding: var(--space-6);
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
  }
</style>
