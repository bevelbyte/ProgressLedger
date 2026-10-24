<script>
  // ProjectWorkspace — the Runs console (docs/DESIGN-ATLAS.md §5.3).
  //
  // What this replaced: a three-column wall that stacked twenty-eight panels
  // simultaneously — a conversation, a plan, a tool stream, a session timeline,
  // two diffs, changed files, run history, provider config, provider health, a
  // token budget, and eleven inventories/editors — each in its own bordered
  // card, all competing for the same attention. Nothing in it was wrong; all of
  // it was equally loud, which meant the one thing that actually needed the user
  // (an approval blocking the run) looked exactly like the twenty-seven things
  // that did not.
  //
  // The console now has three deliberate regions:
  //
  //   1. OBJECTIVE  — the one input, and the two actions that start work.
  //   2. ATTENTION  — the approval queue, full width, directly under the
  //                   objective. It is the only region that can stop a run, so
  //                   it is the only region that is never behind a control.
  //   3. CONSOLE    — transcript + live tool trace on the left, and a TABBED
  //                   inspector on the right for everything that is reference
  //                   rather than action.
  //
  // Why approvals and tool activity are NOT inspector tabs, contrary to the
  // first draft of §5.3: both are the live state of the run. Hiding a blocking
  // approval behind a tab is a bug the user cannot see; hiding the tool stream
  // behind a tab makes "what is it doing right now" a navigation task. Tabs are
  // for looking things up, not for noticing things. Every E2E gate on this
  // surface (`approval-queue`, `approval-row`, `approval-approve`,
  // `tool-activity`, `tool-row`) had independently encoded the same conclusion.

  import AgentConversation from "./AgentConversation.svelte";
  import PlanView from "./PlanView.svelte";
  import ToolActivityList from "./ToolActivityList.svelte";
  import ProviderConfigPanel from "./ProviderConfigPanel.svelte";
  import ProviderHealth from "./ProviderHealth.svelte";
  import DefaultProviderPicker from "./DefaultProviderPicker.svelte";
  import AuditRetentionConfig from "./AuditRetentionConfig.svelte";
  import ShellHistoryFilter from "./ShellHistoryFilter.svelte";
  import TokenBudgetPanel from "./TokenBudgetPanel.svelte";
  import SubAgentTree from "./SubAgentTree.svelte";
  import DiffView from "./DiffView.svelte";
  import ProjectDiff from "./ProjectDiff.svelte";
  import ChangedFilesPanel from "./ChangedFilesPanel.svelte";
  import AgentRunHistory from "./AgentRunHistory.svelte";
  import SubAgentActivity from "./SubAgentActivity.svelte";
  import AgentErrorLog from "./AgentErrorLog.svelte";
  import SessionTimeline from "./SessionTimeline.svelte";
  import MarketplacePanel from "./MarketplacePanel.svelte";
  import ToolInventory from "./ToolInventory.svelte";
  import ApprovalQueue from "./ApprovalQueue.svelte";
  import SkillInventory from "./SkillInventory.svelte";
  import PluginInventory from "./PluginInventory.svelte";
  import MemoryViewer from "./MemoryViewer.svelte";
  import HooksLog from "./HooksLog.svelte";
  import PlanTemplates from "./PlanTemplates.svelte";
  import GoalSuggestions from "./GoalSuggestions.svelte";
  import ProjectModeGuide from "./ProjectModeGuide.svelte";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { projectModeService } from "../services/projectMode.service.js";
  import {
    projectModeStore,
    createAndStartAgent,
    loadAgent,
    applyAgentEvent,
  } from "../stores/projectMode.svelte.js";

  let { profileId = null, onShowKeybindings = null } = $props();

  let objective = $state("");
  let starting = $state(false);
  let exporting = $state(false);
  let showGuide = $state(false);
  let promoting = $state(false);

  // ---- Inspector ------------------------------------------------------------
  // Six tabs, because there are six genuinely different questions: what is the
  // plan, what changed, what else is running, what is it costing, what is it
  // allowed to do, and what happened before.
  const TABS = [
    { id: "plan", label: "Plan" },
    { id: "changes", label: "Changes" },
    { id: "context", label: "Context" },
    { id: "budget", label: "Budget" },
    { id: "extensions", label: "Extensions" },
    { id: "history", label: "History" },
  ];

  let tab = $state("plan");
  let tabEls = $state([]);

  const agentState = $derived(projectModeStore.agent?.state ?? null);

  // Counts come from real store state only. A tab with no honest number shows
  // no badge, rather than a zero dressed up as information.
  const planSteps = $derived(
    Array.isArray(projectModeStore.plan) ? projectModeStore.plan.length : 0
  );
  const editCount = $derived(
    projectModeStore.toolActivity.filter((t) =>
      /^(fs_write|fs_edit|fs_patch|apply_patch|write_file|edit_file|fs_delete|fs_move)/.test(
        String(t?.name ?? "")
      )
    ).length
  );
  const tabCount = (id) =>
    id === "plan" ? planSteps : id === "changes" ? editCount : 0;

  function onTabKey(e, index) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const last = TABS.length - 1;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : e.key === "ArrowLeft"
            ? (index - 1 + TABS.length) % TABS.length
            : (index + 1) % TABS.length;
    tab = TABS[next].id;
    tabEls[next]?.focus();
  }

  // ---- Data ----------------------------------------------------------------

  $effect(() => {
    const apid = projectModeStore.activeProjectId;
    const aaid = projectModeStore.activeAgentId;
    if (apid != null && aaid != null) {
      loadAgent(profileId, aaid).catch((e) => reportError(e, "Could not load agent"));
    }
  });

  // Subscribe once while this workspace is mounted. The main process emits a
  // sanitized event envelope for the active agent; durable transcript reads
  // still rehydrate after reconnects/restarts.
  $effect(() => {
    const off = projectModeService.onEvent((event) => {
      if (event && event.profileId === profileId && event.projectId === projectModeStore.activeProjectId) {
        applyAgentEvent(event);
      }
    });
    return () => off?.();
  });

  async function start() {
    const apid = projectModeStore.activeProjectId;
    if (apid == null) {
      toast.warning("Pick a project first.", "No project");
      return;
    }
    if (!objective.trim()) {
      toast.warning("Give the agent an objective.", "Missing objective");
      return;
    }
    starting = true;
    try {
      const res = await createAndStartAgent(profileId, apid, objective.trim());
      if (res.ok) {
        objective = "";
        if (res.runId != null) {
          toast.success("Agent started");
        } else {
          // The run did not start — do NOT show a success toast for a
          // non-running agent (previously the start failure was silent).
          toast.warning(`Agent created but the run did not start${res.startError ? ` (${res.startError})` : ""}.`, "Start failed");
        }
        await loadAgent(profileId, res.agentId);
      }
    } catch (e) {
      reportError(e, "Could not start agent");
    } finally {
      starting = false;
    }
  }

  /**
   * Promote the current objective + active agent into a persistent
   * Goal. The agent keeps running — we just record that the existing
   * agent work is the authoritative execution for a new goal row.
   *
   * The shell-side engine has a way to start a fresh goal (create a
   * new agent row), but that would orphan the in-flight work the
   * user has already invested in. Instead, the renderer creates a
   * goal that immediately links to the existing agent id, then
   * transitions it to the agent's current state. No second agent
   * is created; no tool calls are repeated.
   */
  async function promoteToGoal() {
    const apid = projectModeStore.activeProjectId;
    const aaid = projectModeStore.activeAgentId;
    const obj = objective.trim();
    if (typeof profileId !== "number" || apid == null || aaid == null || !obj) return;
    promoting = true;
    try {
      const goals = window.careerflow && window.careerflow.goals;
      const pm = window.careerflow && window.careerflow.projectMode;
      if (!goals || typeof goals.create !== "function") {
        toast.error("Goals API unavailable.", "Cannot promote");
        return;
      }
      const titleBase = obj.length > 60 ? obj.slice(0, 57) + "..." : obj;
      const createRes = await goals.create({
        profileId,
        projectId: apid,
        title: titleBase,
        objective: obj,
        kind: "code_change",
        requireVerification: true,
      });
      const goalId = typeof createRes === "number"
        ? createRes
        : (createRes && (createRes.id || (createRes.ok && createRes.id)));
      if (!goalId) {
        toast.error("Could not create goal.", "Promote failed");
        return;
      }
      // Link the existing agent to the new goal via the explicit
      // `goal:link-agent` IPC channel.
      //
      // The previous `await goals.linkAgent?.(...)` followed by
      // `if (linkRes && linkRes.ok === false)` meant a MISSING function
      // produced `linkRes === undefined`, the guard did not fire, and the
      // success toast claimed the run had been promoted to a goal when the
      // agent was never linked. `goal:link-agent` answers with `reason`, not
      // `error` (ipc/goals.js), so the old line also swallowed the real
      // failure reason and replaced it with a generic message. Both are fixed
      // by requiring the function and reading the actual refusal field.
      if (typeof goals.linkAgent !== "function") {
        toast.error("Goal linking is unavailable in this build.", "Promote failed");
        return;
      }
      const linkRes = await goals.linkAgent(profileId, goalId, aaid);
      if (!linkRes || linkRes.ok === false) {
        toast.error(
          (linkRes && (linkRes.reason || linkRes.error)) || "Could not link agent.",
          "Promote failed"
        );
        return;
      }
      // Promote the goal to running (skip starting). The existing
      // engine code path doesn't expose this directly; we use the
      // raw NAPI via the project's IPC if available. The simplest
      // path: just trigger reconcile — the engine will see the
      // linked agent already running and bring the goal into the
      // matching state.
      // Reconcile is best-effort: the agent is already linked and running, so
      // the engine will bring the goal into the matching state. It must not be
      // able to report a false success if the function is absent, so it is
      // invoked only when present and its failure is swallowed deliberately.
      if (typeof goals.reconcile === "function") {
        await goals.reconcile(profileId).catch(() => {});
      }
      toast.success("Promoted to Goal — open the Goals view to track it.", "Goal created");
      // Jump to Goals view.
      window.dispatchEvent(new CustomEvent("cf:navigate", { detail: { view: "goals" } }));
    } catch (e) {
      reportError(e, "Could not promote to Goal");
    } finally {
      promoting = false;
    }
  }

async function exportSession() {
    const agentId = projectModeStore.activeAgentId;
    if (agentId == null) {
      toast.warning("No agent selected to export.", "Nothing to export");
      return;
    }
    exporting = true;
    try {
      const result = await window.careerflow.projectMode.exportSession(profileId, agentId);
      if (!result || result.ok === false) {
        toast.error(result && result.error ? String(result.error) : "Export failed.", "Export error");
        return;
      }
      const blob = new Blob([JSON.stringify(result.session, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agent-session-${agentId}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Session exported.", "Export complete");
    } catch (e) {
      reportError(e, "Session export");
      toast.error("Export failed.", "Export error");
    } finally {
      exporting = false;
    }
  }
</script>

<div class="workspace" data-testid="project-workspace">
  <!-- ===== 1. Objective ================================================= -->
  <header class="ws-head">
    <div class="meta">
      <h2>{projectModeStore.activeProject ? projectModeStore.activeProject.name : "No project"}</h2>
      {#if projectModeStore.activeProject?.description}
        <span class="desc">{projectModeStore.activeProject.description}</span>
      {/if}
      {#if agentState}
        <span
          class="cf-badge {agentState === 'failed' ? 'danger' : agentState === 'waiting_for_approval' ? 'warning' : agentState === 'completed' ? 'success' : 'neutral'}"
        >{agentState.replace(/_/g, " ")}</span>
      {/if}
    </div>
    <div class="head-actions">
      <button
        type="button"
        class="cf-btn ghost sm"
        onclick={onShowKeybindings}
        title="Keyboard shortcuts (?)"
        data-testid="keybindings-btn"
        aria-label="Show keyboard shortcuts"
      >?</button>
      <button
        type="button"
        class="cf-btn secondary sm"
        onclick={() => (showGuide = true)}
        title="Open Project Mode user guide"
        data-testid="open-guide-btn"
      >Guide</button>
      <button
        type="button"
        class="cf-btn secondary sm"
        onclick={exportSession}
        disabled={exporting || projectModeStore.activeAgentId == null}
        title="Export session as JSON"
        data-testid="export-session-btn"
      >{exporting ? "Exporting…" : "Export"}</button>
    </div>
  </header>

  <section class="objective-row">
    <div class="objective-field">
      <GoalSuggestions bind:goal={objective} inputTestId="objective-input" />
    </div>
    <button
      type="button"
      class="cf-btn primary"
      onclick={start}
      disabled={starting || projectModeStore.activeProjectId == null}
      data-testid="start-agent"
    >{starting ? "Starting…" : "Run agent"}</button>
    <button
      type="button"
      class="cf-btn secondary"
      onclick={promoteToGoal}
      disabled={promoting || !objective.trim() || projectModeStore.activeProjectId == null || projectModeStore.activeAgentId == null}
      data-testid="promote-to-goal"
      title="Promote the current objective + agent into a persistent Goal"
    >{promoting ? "Promoting…" : "Promote to Goal"}</button>
  </section>

  <!-- ===== 2. Attention ================================================= -->
  <!-- Full width, above the console, never behind a tab: this is the only
       region on the surface that can block the run waiting on the user. -->
  <div class="attention">
    <ApprovalQueue {profileId} agentId={projectModeStore.activeAgentId} />
  </div>

  <!-- ===== 3. Console =================================================== -->
  <div class="console">
    <section class="lane lane-transcript" aria-label="Transcript and live tool trace">
      <AgentConversation />
      <ToolActivityList />
    </section>

    <aside class="lane lane-inspector" aria-label="Inspector">
      <div class="tabs" role="tablist" aria-label="Run inspector">
        {#each TABS as t, i (t.id)}
          {@const count = tabCount(t.id)}
          <button
            type="button"
            role="tab"
            id="inspector-tab-{t.id}"
            class="tab"
            class:on={tab === t.id}
            aria-selected={tab === t.id}
            aria-controls="inspector-panel"
            tabindex={tab === t.id ? 0 : -1}
            bind:this={tabEls[i]}
            onclick={() => (tab = t.id)}
            onkeydown={(e) => onTabKey(e, i)}
          >
            {t.label}
            {#if count > 0}<span class="count atl-mono">{count}</span>{/if}
          </button>
        {/each}
      </div>

      <div
        class="panel"
        id="inspector-panel"
        role="tabpanel"
        aria-labelledby="inspector-tab-{tab}"
        tabindex="0"
      >
        {#if tab === "plan"}
          <PlanView />
          <PlanTemplates {profileId} />
        {:else if tab === "changes"}
          <ChangedFilesPanel
            {profileId}
            projectId={projectModeStore.activeProjectId}
            agentId={projectModeStore.activeAgentId}
            refreshIntervalMs={15000}
          />
          <ProjectDiff {profileId} agentId={projectModeStore.activeAgentId} />
          <DiffView {profileId} agentId={projectModeStore.activeAgentId} />
        {:else if tab === "context"}
          <SubAgentTree {profileId} parentAgentId={projectModeStore.activeAgentId} />
          <SubAgentActivity {profileId} parentAgentId={projectModeStore.activeAgentId} />
          <SessionTimeline {profileId} agentId={projectModeStore.activeAgentId} />
          <MemoryViewer {profileId} projectId={projectModeStore.activeProjectId} />
        {:else if tab === "budget"}
          <TokenBudgetPanel {profileId} agentId={projectModeStore.activeAgentId} />
          <DefaultProviderPicker {profileId} />
          <ProviderConfigPanel {profileId} />
          <ProviderHealth />
          <AuditRetentionConfig {profileId} />
        {:else if tab === "extensions"}
          <ToolInventory />
          <SkillInventory {profileId} projectId={projectModeStore.activeProjectId} />
          <PluginInventory {profileId} />
          <MarketplacePanel />
        {:else if tab === "history"}
          <AgentRunHistory {profileId} />
          <AgentErrorLog {profileId} />
          <HooksLog {profileId} />
          <ShellHistoryFilter {profileId} />
        {/if}
      </div>
    </aside>
  </div>
</div>

{#if showGuide}
  <ProjectModeGuide onClose={() => (showGuide = false)} />
{/if}

<style>
  .workspace {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    height: 100%;
    min-height: 0;
  }

  /* ---- Objective ------------------------------------------------------ */

  .ws-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--atlas-line);
  }

  .meta {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
  }

  .meta h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--atlas-ink);
  }

  .meta .desc {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .objective-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .objective-field {
    flex: 1;
    min-width: 0;
  }

  /* The two actions sit level with the objective field rather than floating
     at its baseline, so the row reads as one control group. */
  .objective-row > button {
    margin-top: 18px;
    flex-shrink: 0;
  }

  /* ---- Attention ------------------------------------------------------ */

  /* The approval queue is the only surface that can be *waiting* for the
     user, so it leads. Quiet hairline when empty, semantic edge when it
     holds something. */
  .attention :global(.approval-queue) {
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    padding: var(--space-3);
  }

  .attention :global(.approval-queue:not([data-count="0"])) {
    border-color: var(--atlas-warn-line);
    box-shadow: inset 3px 0 0 var(--atlas-warn);
  }

  .attention :global(.approval-queue[data-count="0"]) {
    padding: var(--space-2) var(--space-3);
  }

  .attention :global(.approval-queue[data-count="0"] .panel-header h3) {
    color: var(--atlas-ink-3);
  }

  /* ---- Console -------------------------------------------------------- */

  .console {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: var(--space-4);
    flex: 1;
    min-height: 0;
  }

  @media (max-width: 1100px) {
    .console {
      grid-template-columns: minmax(0, 1fr);
      grid-auto-rows: minmax(0, auto);
    }
  }

  .lane {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
  }

  .lane-transcript > :global(:first-child) {
    flex: 1;
    min-height: 0;
  }

  .lane-transcript > :global(:last-child) {
    max-height: 30%;
    min-height: 92px;
  }

  /* ---- Inspector ------------------------------------------------------ */

  .tabs {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    border-bottom: 1px solid var(--atlas-line);
    overflow-x: auto;
    scrollbar-width: none;
    flex-shrink: 0;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px var(--space-2);
    border: 0;
    background: none;
    cursor: pointer;
    font-size: var(--text-md);
    color: var(--atlas-ink-3);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    white-space: nowrap;
    transition: color var(--dur-fast) var(--ease);
  }

  .tab:hover {
    color: var(--atlas-ink);
  }

  .tab.on {
    color: var(--atlas-ink);
    border-bottom-color: var(--atlas-signal);
  }

  .tab .count {
    font-size: var(--text-micro);
    padding: 0 5px;
    border-radius: var(--radius-full);
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
  }

  .tab.on .count {
    background: var(--atlas-signal-soft);
    color: var(--atlas-signal-2);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow-y: auto;
    min-height: 0;
    flex: 1;
    padding-right: 2px;
  }

  .panel:focus-visible {
    outline: 2px solid var(--atlas-signal);
    outline-offset: 2px;
  }
</style>
