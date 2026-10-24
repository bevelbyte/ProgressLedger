<script>
  // TokenBudgetPanel -- live view of the active agent's token budget.
  //
  // Calls `agent:get-budget` on mount and then every POLL_INTERVAL_MS
  // (5 s). The main process reads the agent row (tokens_in + tokens_out)
  // and the owning project's config_json (token_budget) and returns
  // { current, cap, usedPct, lastUpdated }.
  //
  // Color thresholds (driven by `usedPct`):
  //   < 50%  -> green (ok)
  //   50-80% -> yellow (warn)
  //   > 80%  -> red (danger)
  //
  // A cap of 0 means "no limit" (the budget module's contract) -- the
  // panel reports usedPct as 0 in that case and renders "no limit"
  // instead of a percentage.
  //
  // We poll rather than subscribe to an event because the agent loop
  // does not currently forward a `tokens.updated` event to the renderer
  // (the AGENT_EVENTS bus is internal to the main process). 5 s is a
  // balance between responsiveness and IPC load; the budget is a slow-
  // changing aggregate, not a streaming signal.

  import { onMount } from "svelte";
  import { projectModeService } from "../services/projectMode.service.js";
  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null, agentId = null } = $props();

  const POLL_INTERVAL_MS = 5000;

  // { current, cap, usedPct, lastUpdated } | null (no agent / not yet loaded)
  let budget = $state(null);
  let error = $state(null);
  let loading = $state(false);

  // Color bucket derived from usedPct. When cap is 0 ("no limit") we
  // report "ok" so the bar renders a stable green rather than grey.
  let colorClass = $derived(
    !budget
      ? "unknown"
      : budget.cap === 0
        ? "ok"
        : budget.usedPct < 50
          ? "ok"
          : budget.usedPct < 80
            ? "warn"
            : "danger",
  );

  // State pill label mirrors the color class for screen-reader / test
  // assertions. The bar itself is decorative (aria-hidden).
  let stateLabel = $derived(
    error ? "error"
      : !budget ? "idle"
      : budget.cap === 0 ? "no limit"
      : colorClass === "ok" ? "ok"
      : colorClass === "warn" ? "warn"
      : "danger",
  );

  function formatTokens(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return Number(n).toLocaleString();
  }

  function formatPct(p) {
    if (p == null || !Number.isFinite(p)) return "—";
    return Number(p).toFixed(1) + "%";
  }

  function formatTime(ts) {
    if (!ts || !Number.isFinite(ts)) return "—";
    try {
      return new Date(ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (_e) {
      return "—";
    }
  }

  async function refresh() {
    const pid = profileId;
    const aid = agentId;
    if (pid == null || aid == null) {
      budget = null;
      error = null;
      loading = false;
      return;
    }
    loading = true;
    try {
      const res = await projectModeService.getBudget(pid, aid);
      if (res && res.ok) {
        budget = {
          current: Number(res.current) || 0,
          cap: Number(res.cap) || 0,
          usedPct: Number(res.usedPct) || 0,
          lastUpdated: Number(res.lastUpdated) || Date.now(),
        };
        error = null;
      } else {
        budget = null;
        error = res && res.error ? String(res.error) : "unknown";
      }
    } catch (e) {
      budget = null;
      error = String(e && e.message || e);
      reportError(e, "Could not load token budget");
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    // Initial fetch + 5 s polling loop. We keep a single interval; if the
    // component is re-mounted (e.g. agent switch), the previous one is
    // cleared by the onMount teardown before the new one starts.
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  });
</script>

<section class="token-budget" data-testid="token-budget-panel" data-state={stateLabel}>
  <header class="panel-header">
    <h3>Token budget</h3>
    <span class="badge badge-{stateLabel}" data-testid="token-budget-state">
      {stateLabel}
    </span>
  </header>

  {#if error}
    <div class="error" data-testid="token-budget-error" role="alert">{error}</div>
  {:else if !budget}
    <div class="empty" data-testid="token-budget-empty">
      {loading ? "Loading…" : "No active agent."}
    </div>
  {:else}
    <div
      class="progress-track"
      data-testid="token-budget-bar"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={budget.cap === 0 ? 0 : Math.min(100, budget.usedPct)}
      aria-label="Token budget usage"
    >
      <div
        class="progress-fill progress-{colorClass}"
        style="width: {budget.cap === 0 ? 0 : Math.min(100, budget.usedPct)}%"
        data-testid="token-budget-fill"
        data-color={colorClass}
      ></div>
    </div>

    <dl class="stats">
      <div class="stat" data-testid="token-budget-current">
        <dt class="label">Current</dt>
        <dd class="value">{formatTokens(budget.current)}</dd>
      </div>
      <div class="stat" data-testid="token-budget-cap">
        <dt class="label">Cap</dt>
        <dd class="value">{budget.cap === 0 ? "no limit" : formatTokens(budget.cap)}</dd>
      </div>
      <div class="stat" data-testid="token-budget-used-pct">
        <dt class="label">Used</dt>
        <dd class="value">{budget.cap === 0 ? "—" : formatPct(budget.usedPct)}</dd>
      </div>
    </dl>

    <div class="meta" data-testid="token-budget-updated">
      Updated {formatTime(budget.lastUpdated)}
    </div>
  {/if}
</section>

<style>
  .token-budget {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    font-size: var(--text-md);
    color: var(--text-main);
  }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .panel-header h3 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
  }
  .badge {
    font-size: var(--text-xs);
    padding: 1px 8px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: var(--bg-main);
  }
  .badge-ok { color: var(--atlas-ok); border-color: var(--atlas-ok); }
  .badge-warn { color: var(--atlas-warn); border-color: var(--atlas-warn); }
  .badge-danger { color: var(--atlas-bad); border-color: var(--atlas-bad); }
  .badge-error { color: var(--atlas-bad); border-color: var(--atlas-bad); }
  .badge-idle, .badge-unknown { color: var(--text-muted); }

  .progress-track {
    width: 100%;
    height: 10px;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 240ms ease-out, background-color 240ms ease-out;
  }
  .progress-ok { background: var(--atlas-ok); }
  .progress-warn { background: var(--atlas-warn); }
  .progress-danger { background: var(--atlas-bad); }
  .progress-unknown { background: var(--border); }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 0;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .label {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .value {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-main);
    font-variant-numeric: tabular-nums;
  }

  .meta {
    font-size: var(--text-sm);
    color: var(--text-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .empty {
    padding: 14px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    text-align: center;
    font-size: var(--text-md);
  }
  .error {
    padding: 8px 10px;
    border: 1px solid var(--atlas-bad);
    background: var(--atlas-bad-bg);
    color: var(--atlas-bad);
    border-radius: var(--radius-md);
    font-size: var(--text-md);
  }
</style>
