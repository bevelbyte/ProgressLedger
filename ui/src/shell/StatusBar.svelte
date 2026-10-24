<script>
  // Atlas shell — status bar.
  //
  // A readout strip, not a UI region: profile, storage locality, core health,
  // operator state, clock. All mono, all 10px, all muted — it reports facts
  // and never asks for attention.
  //
  // CONTRACT: the core readout renders the native `ping()` response verbatim
  // (`CareerFlow core online`). Every E2E spec in this repo waits on that exact
  // text as its "the app is up" gate, so the strip must never paraphrase it
  // into a friendlier word. It is also the honest thing to show: the strip
  // reports what the Rust core actually said, not a summary of it.

  import { operatorSummary, activeRunCount } from "./operator.svelte.js";

  let {
    activeProfile = null,
    coreStatus = "checking…",
    online = false,
    onOpenConsole = () => {},
  } = $props();

  const summary = $derived(operatorSummary());
  const runs = $derived(activeRunCount());

  let now = $state(new Date());
  $effect(() => {
    const t = setInterval(() => (now = new Date()), 20000);
    return () => clearInterval(t);
  });

  const clock = $derived(
    now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );
</script>

<footer class="statusbar" aria-label="Status">
  <div class="sb-group">
    <span class="sb-item">
      <span class="atl-label">workspace</span>
      <strong>{activeProfile?.name ?? "none"}</strong>
    </span>
    <span class="sb-sep" aria-hidden="true"></span>
    <span class="sb-item">
      <span class="atl-label">storage</span>
      <strong>local</strong>
    </span>
  </div>

  <div class="sb-group sb-center">
    <span class="sb-item" title={coreStatus}>
      <span class="sb-dot" class:ok={online} class:bad={!online} aria-hidden="true"></span>
      <span class="sb-core">{coreStatus}</span>
    </span>
    <span class="sb-sep" aria-hidden="true"></span>
    <button
      type="button"
      class="sb-operator"
      class:waiting={summary.tone === "warn"}
      onclick={onOpenConsole}
      title="Open the operator console"
    >
      {#if summary.tone === "live" || summary.tone === "warn"}
        <span class="cf-pulse-dot" aria-hidden="true"></span>
      {/if}
      <span class="atl-label">{summary.text}</span>
      {#if runs > 1}<span class="sb-runs">{runs} active</span>{/if}
    </button>
  </div>

  <div class="sb-group sb-right">
    <span class="sb-item"><span class="atl-label">Ctrl K</span> commands</span>
    <span class="sb-sep" aria-hidden="true"></span>
    <time class="sb-clock">{clock}</time>
  </div>
</footer>

<style>
  .statusbar {
    height: var(--shell-status-h);
    flex: 0 0 var(--shell-status-h);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 0 12px;
    background: var(--atlas-chrome);
    border-top: 1px solid var(--atlas-line);
    color: var(--atlas-ink-3);
    font-size: var(--text-micro);
    user-select: none;
  }

  .sb-group {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .sb-center {
    justify-content: center;
  }

  .sb-right {
    justify-content: flex-end;
  }

  .sb-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .sb-item strong {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    color: var(--atlas-ink-2);
    text-transform: none;
    letter-spacing: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }

  /* The native response, verbatim. Truncates only if a failure message is
     long; the untruncated text stays available via `title`. */
  .sb-core {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-ink-2);
    letter-spacing: 0;
    text-transform: none;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 300px;
    white-space: nowrap;
  }

  .sb-sep {
    width: 1px;
    height: 11px;
    background: var(--atlas-line-2);
  }

  .sb-dot {
    width: 5px;
    height: 5px;
    border-radius: var(--radius-full);
    background: var(--atlas-ink-3);
  }

  .sb-dot.ok {
    background: var(--atlas-ok);
  }

  .sb-dot.bad {
    background: var(--atlas-bad);
  }

  .sb-operator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px;
    height: 18px;
    border-radius: var(--radius-xs);
    color: var(--atlas-ink-3);
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .sb-operator:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink-2);
  }

  .sb-operator.waiting {
    color: var(--atlas-warn);
  }

  .sb-runs {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-ink-3);
  }

  .sb-clock {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--atlas-ink-2);
  }
</style>
