<script>
  // Atlas shell — operator console.
  //
  // The single place where machine action is visible from anywhere in the app.
  // Three tabs: Approvals (the blocking work), Runs (what is executing), and
  // Activity (the tool-call stream).
  //
  // Why this exists: the previous design surfaced approvals only inside the
  // Project Mode view, so a user working in Subjects had no way to know the
  // operator was blocked on them. Approvals now auto-open this drawer.
  //
  // The renderer boundary deliberately does not project tool arguments
  // (shell/src/services/agent/event-sanitizer.js). Atlas therefore makes the
  // *permission* legible in plain language and points at the transcript for
  // detail, instead of rendering an empty "arguments hidden" block.

  import { ShieldAlert, Check, X, Activity, ChevronDown, ChevronUp, SquareTerminal } from "lucide-svelte";
  import {
    operator,
    clearOperatorApproval,
    activeRunCount,
  } from "./operator.svelte.js";
  import { projectModeService } from "../features/project-mode/services/projectMode.service.js";
  import { toast } from "../shared/stores/toasts.svelte.js";
  import { reportError } from "../shared/utils/errors.js";

  let {
    open = $bindable(false),
    tab = $bindable("approvals"),
    onOpenRuns = () => {},
  } = $props();

  let busy = $state({});

  const pending = $derived(operator.approvals);
  const runs = $derived(operator.runs);
  const activity = $derived(operator.activity);
  const active = $derived(activeRunCount());

  const TABS = [
    { id: "approvals", label: "Approvals" },
    { id: "runs", label: "Runs" },
    { id: "activity", label: "Activity" },
  ];

  const PERMISSION_GLOSS = {
    READ: "reads project data",
    WRITE: "writes files or state",
    EXECUTE: "runs a command",
    NETWORK: "reaches the network",
    DESTRUCTIVE: "can destroy data",
  };

  function gloss(permission) {
    if (!permission) return "permission not declared";
    return PERMISSION_GLOSS[String(permission).toUpperCase()] || "privileged action";
  }

  function permissionTone(permission) {
    const p = String(permission || "").toUpperCase();
    if (p === "DESTRUCTIVE") return "bad";
    if (p === "EXECUTE" || p === "WRITE") return "warn";
    return "muted";
  }

  async function decide(approval, decision) {
    if (busy[approval.id]) return;
    busy = { ...busy, [approval.id]: true };
    try {
      const fn = decision === "approve" ? projectModeService.approveCall : projectModeService.denyCall;
      const res = await fn(approval.profileId, approval.agentId, approval.id);
      if (!res || res.ok === false) {
        throw new Error((res && (res.error || res.reason)) || "Approval IPC failed");
      }
      clearOperatorApproval(approval.id);
      if (decision === "approve") toast.success(`Tool "${approval.tool}" approved.`);
      else toast.info(`Tool "${approval.tool}" denied.`);
    } catch (e) {
      reportError(e, "Could not resolve approval");
    } finally {
      busy = { ...busy, [approval.id]: false };
    }
  }

  // Queue-level keyboard: `a` allows, `d` denies the approval at the head of
  // the queue.
  //
  // This is deliberately *not* a per-row handler. Two reasons:
  //   1. A focusable `<li>` is a non-interactive element carrying interaction
  //      handlers — it reads as a button to assistive tech without being one.
  //      Rows are plain content again; the Allow/Deny buttons are the real
  //      controls and remain the accessible path.
  //   2. "Whichever row happened to be focused" is the wrong subject for a
  //      destructive decision. The queue is ordered oldest-first, so the head
  //      is the run that has been blocked longest — a predictable target.
  //
  // The handler is scoped to focus *inside* the console. Holding `a` while
  // typing a note in the workspace must never approve a privileged tool, even
  // though the drawer stays open across views.
  let consoleEl = $state(null);

  function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable === true;
  }

  $effect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "a" && k !== "d") return;
      if (!consoleEl || !consoleEl.contains(document.activeElement)) return;
      if (isTypingTarget(e.target)) return;
      const target = operator.approvals[0];
      if (!target) return;
      e.preventDefault();
      decide(target, k === "a" ? "approve" : "deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function ago(ts) {
    const s = Math.max(0, (Date.now() - (ts || Date.now())) / 1000);
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  const STATE_LABEL = {
    running: "running",
    resumed: "resumed",
    planning: "planning",
    replanning: "replanning",
    verifying: "verifying",
    executing_tool: "executing",
    waiting_for_approval: "waiting",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  };

  function stateTone(state) {
    if (state === "completed") return "ok";
    if (state === "failed") return "bad";
    if (state === "cancelled") return "muted";
    if (state === "waiting_for_approval") return "warn";
    return "live";
  }
</script>

<section
  class="console"
  class:open
  class:waiting={pending.length > 0}
  aria-label="Operator console"
  bind:this={consoleEl}
>
  <button
    type="button"
    class="console-strip"
    onclick={() => (open = !open)}
    aria-expanded={open}
    title={open ? "Collapse operator console" : "Expand operator console"}
  >
    <span class="cs-left">
      <SquareTerminal size={13} strokeWidth={1.7} aria-hidden="true" />
      <span class="atl-label on-ink">Operator</span>
      {#if pending.length > 0}
        <span class="cs-badge warn">{pending.length} waiting</span>
      {:else if active > 0}
        <span class="cs-badge live"><span class="cf-pulse-dot"></span>{active} running</span>
      {:else}
        <span class="cs-badge">idle</span>
      {/if}
    </span>
    <span class="cs-right">
      <span class="cs-hint atl-label">Ctrl Shift A</span>
      {#if open}<ChevronDown size={13} strokeWidth={2} aria-hidden="true" />{:else}<ChevronUp size={13} strokeWidth={2} aria-hidden="true" />{/if}
    </span>
  </button>

  {#if open}
    <div class="console-body">
      <div class="console-tabs" role="tablist" aria-label="Operator console sections">
        {#each TABS as t (t.id)}
          <button
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            class="ctab"
            class:active={tab === t.id}
            onclick={() => (tab = t.id)}
          >
            {t.label}
            {#if t.id === "approvals" && pending.length > 0}
              <span class="ctab-count warn">{pending.length}</span>
            {:else if t.id === "runs" && active > 0}
              <span class="ctab-count live">{active}</span>
            {:else if t.id === "activity" && activity.length > 0}
              <span class="ctab-count">{activity.length}</span>
            {/if}
          </button>
        {/each}
      </div>

      <div class="console-pane">
        {#if tab === "approvals"}
          {#if pending.length === 0}
            <p class="pane-empty">
              Nothing is waiting on you. Approvals appear here the moment a run needs one.
            </p>
          {:else}
            <ul class="approval-list" aria-live="polite">
              {#each pending as a (a.id)}
                {@const isBusy = !!busy[a.id]}
                <li
                  class="approval"
                  aria-label={`${a.tool} requires ${a.permission || "unspecified"} permission`}
                >
                  <span class="ap-icon" aria-hidden="true"><ShieldAlert size={15} strokeWidth={1.7} /></span>
                  <div class="ap-main">
                    <div class="ap-head">
                      <span class="ap-tool">{a.tool}</span>
                      <span class="ap-perm" data-tone={permissionTone(a.permission)}>{a.permission || "unknown"}</span>
                      <span class="ap-time">{ago(a.requestedAt)}</span>
                    </div>
                    <p class="ap-gloss">
                      This run wants to <strong>{gloss(a.permission)}</strong>.
                      Arguments are not projected to the interface — read them in the run transcript.
                    </p>
                  </div>
                  <div class="ap-actions">
                    <button
                      type="button"
                      class="cf-btn sm danger"
                      disabled={isBusy}
                      onclick={() => decide(a, "deny")}
                      title="Deny (d)"
                    >
                      <X size={12} strokeWidth={2.2} aria-hidden="true" /> Deny
                    </button>
                    <button
                      type="button"
                      class="cf-btn sm secondary"
                      disabled={isBusy}
                      onclick={() => decide(a, "approve")}
                      title="Allow (a)"
                    >
                      <Check size={12} strokeWidth={2.2} aria-hidden="true" /> Allow
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
            <p class="pane-hint">
              <kbd class="cf-kbd">a</kbd> allow
              <kbd class="cf-kbd">d</kbd> deny the oldest request
            </p>
          {/if}
        {:else if tab === "runs"}
          {#if runs.length === 0}
            <p class="pane-empty">No runs this session. Start one from the Runs console.</p>
          {:else}
            <ul class="run-list">
              {#each runs as r (r.agentId)}
                <li class="run">
                  <span class="run-state" data-tone={stateTone(r.state)}>
                    {#if stateTone(r.state) === "live" || stateTone(r.state) === "warn"}
                      <span class="cf-pulse-dot"></span>
                    {/if}
                    {STATE_LABEL[r.state] || r.state}
                  </span>
                  <span class="run-title">
                    {r.objective || `Agent #${r.agentId}`}
                  </span>
                  {#if r.currentTool}<span class="run-tool">{r.currentTool}</span>{/if}
                  {#if r.reason}<span class="run-reason">{r.reason}</span>{/if}
                  <span class="run-time">{ago(r.endedAt || r.startedAt)}</span>
                  <button
                    type="button"
                    class="cf-btn sm ghost"
                    onclick={() => onOpenRuns(r)}
                    title="Open this run in the Runs console"
                  >
                    Open
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {:else}
          {#if activity.length === 0}
            <p class="pane-empty">No tool calls yet this session.</p>
          {:else}
            <ul class="activity-list">
              {#each activity as ev, i (ev.callId || `${ev.at}-${i}`)}
                <li class="act" data-kind={ev.kind}>
                  <Activity size={12} strokeWidth={1.8} aria-hidden="true" />
                  <span class="act-tool">{ev.tool}</span>
                  <span class="act-kind">{ev.kind}</span>
                  {#if ev.elapsedMs != null}<span class="act-ms">{ev.elapsedMs}ms</span>{/if}
                  {#if ev.errorCode}<span class="act-err">{ev.errorCode}</span>{/if}
                  <span class="act-time">{ago(ev.at)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .console {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    background: var(--atlas-chrome);
    border-top: 1px solid var(--atlas-line);
    min-height: 30px;
  }

  .console.waiting {
    border-top-color: var(--atlas-warn-line);
  }

  /* ---- Collapsed strip ---- */
  .console-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    height: 30px;
    padding: 0 12px;
    color: var(--atlas-ink-3);
    transition: background-color var(--dur-fast) var(--ease);
  }

  .console-strip:hover {
    background: var(--atlas-wash);
  }

  .cs-left,
  .cs-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .cs-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: var(--atlas-hover);
    color: var(--atlas-ink-3);
  }

  .cs-badge.live {
    color: var(--atlas-signal-2);
    background: var(--atlas-signal-soft);
  }

  .cs-badge.warn {
    color: var(--atlas-warn);
    background: var(--atlas-warn-bg);
  }

  .cs-hint {
    opacity: 0.6;
  }

  /* ---- Expanded body ---- */
  .console-body {
    display: flex;
    flex-direction: column;
    max-height: 42vh;
    border-top: 1px solid var(--atlas-line);
    animation: console-in var(--dur-med) var(--ease);
  }

  @keyframes console-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .console-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 10px 0;
    flex-shrink: 0;
  }

  .ctab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    font-weight: 500;
    border-bottom: 2px solid transparent;
    transition: color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  }

  .ctab:hover {
    color: var(--atlas-ink-2);
  }

  .ctab.active {
    color: var(--atlas-ink);
    border-bottom-color: var(--atlas-signal);
  }

  .ctab-count {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    padding: 0 5px;
    border-radius: var(--radius-full);
    background: var(--atlas-hover);
    color: var(--atlas-ink-3);
  }

  .ctab-count.warn {
    background: var(--atlas-warn-bg);
    color: var(--atlas-warn);
  }

  .ctab-count.live {
    background: var(--atlas-signal-soft);
    color: var(--atlas-signal-2);
  }

  .console-pane {
    overflow-y: auto;
    padding: 8px 12px 12px;
    border-top: 1px solid var(--atlas-line);
  }

  .pane-empty {
    padding: 14px 4px;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
  }

  /* Chord reminder. The shortcuts are useless if nobody knows they exist, and a
     destructive decision is a bad place to rely on discovery. */
  .pane-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 4px 2px;
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
  }

  /* ---- Approvals ---- */
  .approval-list {
    list-style: none;
    display: flex;
    flex-direction: column;
  }

  .approval {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 8px;
    border-radius: var(--radius-md);
    border-left: 2px solid var(--atlas-warn);
    background: var(--atlas-panel);
    transition: background-color var(--dur-fast) var(--ease);
  }

  .approval + .approval {
    margin-top: 6px;
  }

  .approval:focus-visible {
    outline: 2px solid var(--atlas-signal);
    outline-offset: 1px;
  }

  .ap-icon {
    color: var(--atlas-warn);
    margin-top: 1px;
    flex-shrink: 0;
  }

  .ap-main {
    flex: 1;
    min-width: 0;
  }

  .ap-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .ap-tool {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--atlas-ink);
  }

  .ap-perm {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: var(--atlas-hover);
    color: var(--atlas-ink-3);
  }

  .ap-perm[data-tone="warn"] {
    background: var(--atlas-warn-bg);
    color: var(--atlas-warn);
  }

  .ap-perm[data-tone="bad"] {
    background: var(--atlas-bad-bg);
    color: var(--atlas-bad);
  }

  .ap-time {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-ink-3);
  }

  .ap-gloss {
    margin-top: 3px;
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
  }

  .ap-gloss strong {
    color: var(--atlas-ink-2);
    font-weight: 600;
  }

  .ap-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  /* ---- Runs ---- */
  .run-list,
  .activity-list {
    list-style: none;
    display: flex;
    flex-direction: column;
  }

  .run {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 30px;
    padding: 0 6px;
    font-size: var(--text-md);
  }

  .run + .run,
  .act + .act {
    border-top: 1px solid var(--atlas-line);
  }

  .run-state {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: var(--atlas-hover);
    color: var(--atlas-ink-3);
    flex-shrink: 0;
  }

  .run-state[data-tone="live"] {
    background: var(--atlas-signal-soft);
    color: var(--atlas-signal-2);
  }

  .run-state[data-tone="warn"] {
    background: var(--atlas-warn-bg);
    color: var(--atlas-warn);
  }

  .run-state[data-tone="ok"] {
    background: var(--atlas-ok-bg);
    color: var(--atlas-ok);
  }

  .run-state[data-tone="bad"] {
    background: var(--atlas-bad-bg);
    color: var(--atlas-bad);
  }

  .run-title {
    flex: 1;
    min-width: 0;
    color: var(--atlas-ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-tool,
  .run-reason {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-ink-3);
  }

  .run-time {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-ink-3);
  }

  /* ---- Activity ---- */
  .act {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 26px;
    padding: 0 6px;
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
  }

  .act[data-kind="failed"] {
    color: var(--atlas-bad);
  }

  .act-tool {
    font-family: var(--font-mono);
    color: var(--atlas-ink-2);
  }

  .act-kind,
  .act-ms {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
  }

  .act-err {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-bad);
  }

  .act-time {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
  }
</style>
