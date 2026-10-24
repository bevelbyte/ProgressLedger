<script>
  // ProviderHealth — live view of LLM provider status.
  //
  // Calls `provider:health` on mount. The main process returns one row per
  // provider key (endpoint host + model) recorded in-memory by
  // shell/src/services/agent/provider.js:
  //
  //   { name, requests, success, errors, errorRate, avgLatencyMs, last429 }
  //
  // Colour thresholds live in ../lib/providerHealth.js:
  //   idle   — no requests yet
  //   ok     — <5% errors and no recent 429        (green)
  //   warn   — any error, or a 429 within 10 min   (yellow)
  //   danger — >=25% errors                        (red)
  //
  // No polling: provider calls are event-driven, so the panel fetches once
  // on mount and on an explicit Refresh click. Metrics are in-memory only
  // (this session) — the footer says so rather than implying history.

  import { onMount } from "svelte";
  import { reportError } from "../../../shared/utils/errors.js";
  import {
    classifyProviderHealth,
    statusLabel,
    formatLatencyMs,
    formatErrorRate,
    formatAgo,
    formatNumber,
  } from "../lib/providerHealth.js";

  // Defensive namespace lookup, mirroring projectModeService.listTools():
  // the surface may be absent in older main processes / under test harnesses
  // that mock only part of window.careerflow.
  async function fetchHealth() {
    const ns = window.careerflow && window.careerflow.projectMode;
    const fn = ns && ns.getProviderHealth;
    if (typeof fn !== "function") {
      providers = [];
      updatedAt = null;
      error = "provider:health is not available";
      return;
    }
    loading = true;
    try {
      const res = await fn();
      if (!res || res.ok === false) {
        providers = [];
        updatedAt = null;
        error = (res && res.error) || (res && res.reason) || "unknown-error";
        return;
      }
      providers = Array.isArray(res.providers) ? res.providers : [];
      updatedAt = typeof res.updatedAt === "number" ? res.updatedAt : Date.now();
      error = null;
    } catch (e) {
      providers = [];
      updatedAt = null;
      error = String(e && e.message || e);
      reportError(e, "Could not load provider health");
    } finally {
      loading = false;
    }
  }

  let providers = $state([]);
  let updatedAt = $state(null);
  let error = $state(null);
  let loading = $state(false);

  onMount(() => {
    fetchHealth();
  });
</script>

<section class="panel" data-testid="provider-health-panel">
  <header class="panel-head">
    <h3>Provider health</h3>
    <button
      class="refresh-btn"
      onclick={fetchHealth}
      disabled={loading}
      data-testid="provider-health-refresh"
    >
      {loading ? "Refreshing…" : "Refresh"}
    </button>
  </header>

  {#if error}
    <p class="error" data-testid="provider-health-error">{error}</p>
  {:else if providers.length === 0}
    <p class="empty" data-testid="provider-health-empty">
      No provider calls recorded yet. Run an agent to populate this.
    </p>
  {:else}
    <ul class="list">
      {#each providers as p (p.name)}
        {@const status = classifyProviderHealth(p, updatedAt ?? Date.now())}
        <li class="row" data-testid="provider-health-row" data-status={status}>
          <span class="dot dot-{status}" aria-hidden="true"></span>
          <div class="row-main">
            <div class="row-title">
              <span class="name" data-testid="provider-health-name">{p.name}</span>
              <span
                class="badge badge-{status}"
                data-testid="provider-health-state"
              >{statusLabel(status)}</span>
            </div>
            <dl class="metrics">
              <div class="metric">
                <dt>Requests</dt>
                <dd data-testid="provider-health-requests">{formatNumber(p.requests)}</dd>
              </div>
              <div class="metric">
                <dt>Errors</dt>
                <dd data-testid="provider-health-errors">{formatNumber(p.errors)}</dd>
              </div>
              <div class="metric">
                <dt>Error rate</dt>
                <dd data-testid="provider-health-error-rate">{formatErrorRate(p)}</dd>
              </div>
              <div class="metric">
                <dt>Avg latency</dt>
                <dd data-testid="provider-health-latency">{formatLatencyMs(p.avgLatencyMs)}</dd>
              </div>
              <div class="metric">
                <dt>Last 429</dt>
                <dd data-testid="provider-health-429">
                  {formatAgo(p.last429, updatedAt ?? Date.now())}
                </dd>
              </div>
            </dl>
          </div>
        </li>
      {/each}
    </ul>
    <p class="foot">
      Updated {updatedAt != null ? formatAgo(updatedAt, Date.now()) : "—"} · in-memory,
      this session only
    </p>
  {/if}
</section>

<style>
  .panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-card);
    color: var(--text-main);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .panel-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .panel-head h3 {
    margin: 0;
    font-size: var(--text-md);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .refresh-btn {
    padding: 3px 8px;
    font-size: var(--text-sm);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-main);
    color: var(--text-main);
    cursor: pointer;
  }
  .refresh-btn:hover:not(:disabled) { border-color: var(--accent); }
  .refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .row {
    display: flex;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-main);
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 5px;
  }
  .row-main { flex: 1; min-width: 0; }
  .row-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .name {
    font-size: var(--text-md);
    font-weight: 500;
    color: var(--text-main);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 2px 8px;
    margin: 0;
    font-size: var(--text-sm);
  }
  .metric {
    display: flex;
    justify-content: space-between;
    gap: 6px;
  }
  .metric dt { color: var(--text-muted); }
  .metric dd { margin: 0; color: var(--text-main); font-variant-numeric: tabular-nums; }

  /* Colour palette mirrors TokenBudgetPanel (badge-ok/warn/danger). */
  .dot-ok, .badge-ok { color: var(--atlas-ok); border-color: var(--atlas-ok); }
  .dot-warn, .badge-warn { color: var(--atlas-warn); border-color: var(--atlas-warn); }
  .dot-danger, .badge-danger { color: var(--atlas-bad); border-color: var(--atlas-bad); }
  .dot-idle { background: var(--border); }
  .dot-ok { background: var(--atlas-ok); }
  .dot-warn { background: var(--atlas-warn); }
  .dot-danger { background: var(--atlas-bad); }

  .badge {
    font-size: var(--text-xs);
    line-height: 1.4;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--bg-main);
    white-space: nowrap;
  }
  .badge-idle, .badge-error { color: var(--text-muted); }
  .badge-error { color: var(--atlas-bad); }

  .empty {
    margin: 0;
    padding: 8px 10px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--text-md);
  }
  .error {
    margin: 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--atlas-bad-bg);
    border: 1px solid var(--atlas-bad);
    color: var(--atlas-bad);
    font-size: var(--text-md);
  }
  .foot {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
</style>
