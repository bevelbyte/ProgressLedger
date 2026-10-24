<script>
  // ResumeBanner — "Resume previous run" prompt shown on top of Project
  // Mode when Progress Ledger detects a non-terminal agent left over from the
  // previous session (the user closed the app mid-run). On mount we ask
  // the main process for the most recent non-terminal agent row; if the
  // IPC returns one, we render a banner with the goal and Resume /
  // Discard buttons.
  //
  // Behaviour:
  //   - Resume  → calls projectMode.startAgent on the leftover agent id
  //               so the loop picks up the persisted plan_json.
  //   - Discard → hides the banner for the rest of this session via a
  //               localStorage flag ("progressledger_v2_resume_banner_dismissed").
  //               The flag is profile-scoped so a different profile
  //               still gets its own prompt.
  //   - Both    → set `visible = false` so the banner disappears.
  //
  // The banner is purely opt-in: it never blocks the workspace. It also
  // tolerates a missing IPC surface (`projectMode.listResumableAgent`
  // is absent in older main processes / test harnesses) by quietly
  // rendering nothing.

  import { onMount } from "svelte";
  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null, onResume = null } = $props();

  const DISMISS_KEY_PREFIX = "progressledger_v2_resume_banner_dismissed:";

  let loading = $state(true);
  let visible = $state(false);
  let agent = $state(null);
  let error = $state(null);
  let actionInFlight = $state(false);

  function dismissKey() {
    return `${DISMISS_KEY_PREFIX}${profileId ?? "default"}`;
  }

  function isDismissed() {
    try {
      return localStorage.getItem(dismissKey()) === "1";
    } catch (_) {
      return false;
    }
  }

  function markDismissed() {
    try {
      localStorage.setItem(dismissKey(), "1");
    } catch (_) {
      // localStorage may be unavailable (tests, private mode)
    }
  }

  async function fetchResumable() {
    const ns = window.progressLedger && window.progressLedger.projectMode;
    const fn = ns && ns.listResumableAgent;
    if (typeof fn !== "function") {
      agent = null;
      visible = false;
      error = null;
      return;
    }
    if (typeof profileId !== "number") {
      agent = null;
      visible = false;
      error = null;
      return;
    }
    loading = true;
    try {
      const res = await fn(profileId);
      if (!res || res.ok === false) {
        agent = null;
        visible = false;
        error = (res && (res.error || res.reason)) || "unknown-error";
        return;
      }
      error = null;
      if (res.agent && typeof res.agent === "object" && typeof res.agent.id === "number") {
        agent = res.agent;
        visible = !isDismissed();
      } else {
        agent = null;
        visible = false;
      }
    } catch (e) {
      agent = null;
      visible = false;
      error = String(e && e.message || e);
      reportError(e, "Could not load resumable agent");
    } finally {
      loading = false;
    }
  }

  function truncate(s, n) {
    if (typeof s !== "string") return "";
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  async function resume() {
    if (!agent || typeof agent.id !== "number") return;
    const ns = window.progressLedger && window.progressLedger.projectMode;
    const fn = ns && ns.startAgent;
    if (typeof fn !== "function") {
      error = "project:start-agent is not available";
      return;
    }
    actionInFlight = true;
    try {
      // Call startAgent with the leftover agent id (so the loop picks up
      // the persisted plan_json via `isResume: true` on the main-process
      // side). The renderer's `startAgent` IPC handler is `isResume: true`
      // automatically because the agent is non-terminal.
      const res = await fn(profileId, agent.id);
      if (res && res.ok === false) {
        // Common case: another run is already in flight for this agent.
        // Surface the error inline and let the user retry or discard.
        error = (res && (res.reason || res.error)) || "start-failed";
        return;
      }
      visible = false;
      if (typeof onResume === "function") {
        try {
          onResume(agent);
        } catch (_) {
          // listener errors must not break the banner
        }
      }
    } catch (e) {
      error = String(e && e.message || e);
      reportError(e, "Could not resume previous run");
    } finally {
      actionInFlight = false;
    }
  }

  function discard() {
    markDismissed();
    visible = false;
  }

  onMount(() => {
    fetchResumable();
  });
</script>

{#if visible && agent}
  <aside class="resume-banner" data-testid="resume-banner" role="region" aria-label="Resume previous run">
    <div class="resume-banner-inner">
      <div class="resume-banner-text">
        <strong class="resume-banner-title">Resume previous run:</strong>
        <span class="resume-banner-goal" data-testid="resume-banner-goal">{truncate(agent.objective, 120)}</span>
        <span class="resume-banner-state" data-testid="resume-banner-state">({agent.state})</span>
      </div>
      <div class="resume-banner-actions">
        <button
          type="button"
          class="resume-btn"
          onclick={resume}
          disabled={actionInFlight}
          data-testid="resume-banner-resume"
        >
          {actionInFlight ? "Resuming…" : "Resume"}
        </button>
        <button
          type="button"
          class="discard-btn"
          onclick={discard}
          disabled={actionInFlight}
          data-testid="resume-banner-discard"
        >
          Discard
        </button>
      </div>
    </div>
    {#if error}
      <p class="resume-banner-error" data-testid="resume-banner-error">{error}</p>
    {/if}
  </aside>
{/if}

<style>
  .resume-banner {
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    background: var(--surface-raised);
    border-radius: var(--radius-md);
    padding: 10px 14px;
    margin-bottom: 12px;
    color: var(--text-main);
  }
  .resume-banner-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .resume-banner-text {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .resume-banner-title {
    color: var(--text-main);
  }
  .resume-banner-goal {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .resume-banner-state {
    color: var(--text-secondary);
    font-size: var(--text-md);
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }
  .resume-banner-actions {
    display: flex;
    gap: 8px;
    flex: 0 0 auto;
  }
  .resume-btn,
  .discard-btn {
    border-radius: var(--radius-sm);
    padding: 4px 12px;
    font-size: var(--text-md);
    font-family: inherit;
    cursor: pointer;
    transition: color var(--trans-fast), border-color var(--trans-fast),
      background var(--trans-fast);
  }
  .resume-btn {
    background: var(--accent);
    color: var(--text-on-accent);
    border: 1px solid var(--accent);
  }
  .resume-btn:hover:not(:disabled) {
    filter: brightness(1.05);
  }
  .discard-btn {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .discard-btn:hover:not(:disabled) {
    color: var(--text-main);
    border-color: var(--border-strong);
  }
  .resume-btn:disabled,
  .discard-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .resume-banner-error {
    margin: 6px 0 0 0;
    font-size: var(--text-md);
    color: var(--danger);
  }
</style>