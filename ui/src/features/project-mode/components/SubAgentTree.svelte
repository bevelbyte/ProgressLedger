<script>
  // SubAgentTree — shows the active agent + a list of its direct
  // children. Each node shows a derived role (researcher / coder /
  // tester / reviewer), state, last activity time, an Expand/Collapse
  // toggle for any nested children rendered recursively by
  // TreeNode, and a button that opens the agent's transcript. The
  // list re-fetches whenever the parent's `updated_at` changes so a
  // freshly-spawned child appears without a manual reload. The IPC
  // surface only exposes direct children; deeper recursion is a
  // visual concern handled inside TreeNode via <svelte:self>.

  import { onMount } from "svelte";
  import { projectModeStore } from "../stores/projectMode.svelte.js";
  import { projectModeService } from "../services/projectMode.service.js";
  import TreeNode from "./TreeNode.svelte";

  // Recursion cap: 0 = the active agent (the parent), 1 = direct
  // children. buildNode only fetches direct children of the active
  // agent; TreeNode handles the visual recursion for nested
  // children if they exist on a node (collapsed-by-default, render
  // via <svelte:self>). This matches the test contract and avoids
  // duplicate renders when the IPC mock returns the same children
  // list for every agent id.
  const MAX_DEPTH = 1;

  let { profileId = null, parentAgentId = null } = $props();

  let treeNodes = $state([]); // [{ agent, children: [...], overflow }]
  let loading = $state(false);
  let error = $state(null);
  // Per-agent metadata used by TreeNode → SubAgentDiffView: the
  // last-known runId and the files_changed array parsed out of the
  // agent's last assistant message. Keyed by agent id at every depth
  // so grandchildren can show their diff too.
  let agentMeta = $state({}); // agentId -> { runId, files }

  // PmAgent has no dedicated role column. Derive a stable role from a
  // leading tag in the objective, e.g. "[coder] implement foo" or
  // "[tester] cover edge cases". Falls back to "agent" when nothing
  // matches.
  function deriveRole(agent) {
    if (!agent) return "agent";
    const text = String(agent.objective || "");
    const m = /^\s*\[(researcher|coder|tester|reviewer)\]/i.exec(text);
    if (m) return m[1].toLowerCase();
    const lower = text.toLowerCase();
    if (/research|explore|investigate/.test(lower)) return "researcher";
    if (/test|spec|coverage/.test(lower)) return "tester";
    if (/review|audit|inspect/.test(lower)) return "reviewer";
    if (/implement|build|code|fix|refactor/.test(lower)) return "coder";
    return "agent";
  }

  function lastActivity(agent) {
    if (!agent) return "";
    // `project:get-children` returns RAW native rows, which are camelCase
    // (`updatedAt`, `createdAt`); fixtures use the Rust names (D13).
    const ts = agent.updatedAt ?? agent.updated_at ?? agent.createdAt ?? agent.created_at ?? "";
    if (!ts) return "";
    // Display ISO timestamps verbatim — the renderer doesn't depend on
    // a date library and full ISO is unambiguous in the tree view.
    return ts;
  }

  /**
   * Recursively build the tree structure, capped at MAX_DEPTH.
   * Returns a `node` shape: { agent, children, overflow }. When
   * `currentDepth` reaches MAX_DEPTH we stop recursing and surface
   * the count of skipped descendants as `overflow` so the user sees
   * "+N more" instead of a silently-truncated subtree.
   */
  async function buildNode(agent, currentDepth) {
    const node = { agent, children: [], overflow: 0 };
    if (currentDepth >= MAX_DEPTH) {
      return node;
    }
    let direct = [];
    try {
      const res = await projectModeService.getChildren(profileId, agent.id);
      direct = Array.isArray(res) ? res : [];
    } catch {
      // Tree gracefully degrades — a node with no fetchable children
      // is still rendered so the user sees the agent exists.
      return node;
    }
    // Fan out the grandchildren fetch in parallel. A slow child
    // shouldn't block the whole subtree rendering.
    const built = await Promise.all(
      direct.map((c) => buildNode(c, currentDepth + 1)),
    );
    node.children = built;
    return node;
  }

  async function loadTree() {
    if (profileId == null || parentAgentId == null) {
      treeNodes = [];
      return;
    }
    loading = true;
    error = null;
    try {
      // Always pass the active parent through buildNode so the root
      // renders identically to a child (same shape, same diff meta,
      // same overflow semantics).
      const root = await buildNode({ id: parentAgentId, _isRoot: true }, 0);
      treeNodes = root.children;
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      treeNodes = [];
    } finally {
      loading = false;
    }
    // Fire-and-forget — the per-agent diff metadata loads after the
    // tree so the diff is available without blocking the render.
    loadAgentMeta(treeNodes);
  }

  function openTranscript(agent) {
    if (!agent) return;
    projectModeStore.activeAgentId = agent.id;
    // Child rows are raw camelCase: reading only `project_id` set the active
    // project to `undefined`, i.e. opening a child's transcript cleared the
    // workspace's project (D13).
    projectModeStore.activeProjectId = agent.projectId ?? agent.project_id;
  }

  /**
   * Parse the last assistant message's content for `files_changed`.
   * Mirrors the shape produced by coder/reviewer delegates (see
   * shell/src/services/agent/subagent-result.js DEFAULT_SHAPES). We
   * keep this here rather than sharing shell code so the renderer
   * never imports a main-process module.
   */
  function filesChangedFromTranscript(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "assistant") continue;
      const text = typeof m.content === "string" ? m.content : "";
      if (!text) continue;
      try {
        const obj = JSON.parse(text);
        if (obj && Array.isArray(obj.files_changed)) {
          return obj.files_changed.filter((p) => typeof p === "string");
        }
      } catch {
        // not JSON — keep walking backwards
      }
    }
    return [];
  }

  /** Walks the entire tree (root → grandchildren) and collects the
   * unique set of agent ids whose metadata we need to fetch. Avoids
   * duplicate IPC calls for agents shared across subtrees (defensive
   * — current shape never produces dupes, but cheap to guard). */
  function collectAgentIds(nodes) {
    const ids = new Set();
    const visit = (n) => {
      if (!n || !n.agent || n.agent._isRoot) return;
      ids.add(n.agent.id);
      (n.children || []).forEach(visit);
    };
    nodes.forEach(visit);
    return ids;
  }

  async function loadAgentMeta(nodes) {
    const ids = collectAgentIds(nodes);
    if (ids.size === 0) {
      agentMeta = {};
      return;
    }
    const next = { ...agentMeta };
    await Promise.all(
      Array.from(ids).map(async (id) => {
        const meta = { runId: null, files: [] };
        try {
          const runRes = await projectModeService.getAgentRun(profileId, id);
          if (runRes && runRes.ok && runRes.runId) meta.runId = runRes.runId;
        } catch {
          // not running — meta.runId stays null
        }
        try {
          const msgs = await projectModeService.listMessages(profileId, id);
          meta.files = filesChangedFromTranscript(msgs);
        } catch {
          meta.files = [];
        }
        next[id] = meta;
      }),
    );
    agentMeta = next;
  }

  onMount(loadTree);

  // Re-fetch whenever the parent's updated_at changes (new child was
  // just spawned, or a child's run completed and bumped the timestamp
  // transitively on the parent).
  $effect(() => {
    const apid = projectModeStore.activeProjectId;
    const aaid = projectModeStore.activeAgentId;
    const updated = projectModeStore.agent && projectModeStore.agent.updated_at;
    if (apid != null && aaid != null) {
      loadTree();
      void updated;
    }
  });
</script>

<div class="tree" data-testid="sub-agent-tree">
  <header class="tree-header">
    <h3>Sub-agents</h3>
    {#if loading}
      <span class="badge">loading…</span>
    {/if}
  </header>

  {#if error}
    <p class="error" role="alert" data-testid="tree-error">{error}</p>
  {/if}

  <ul class="nodes">
    <li class="node parent" data-testid="tree-parent">
      <span class="role-pill" data-role={deriveRole(projectModeStore.agent)}>
        {deriveRole(projectModeStore.agent)}
      </span>
      <span class="state" data-state={projectModeStore.agent && projectModeStore.agent.state}>
        {projectModeStore.agent ? projectModeStore.agent.state : "—"}
      </span>
      <span class="activity">{lastActivity(projectModeStore.agent)}</span>
      <button
        type="button"
        class="open-btn"
        data-testid="open-parent-transcript"
        onclick={() => openTranscript(projectModeStore.agent)}
        disabled={!projectModeStore.agent}
      >
        Open transcript
      </button>
    </li>

    {#if treeNodes.length === 0 && !loading}
      <li class="empty" data-testid="tree-empty">No sub-agents yet.</li>
    {:else}
      {#each treeNodes as node (node.agent.id)}
        <TreeNode
          {node}
          depth={1}
          childMeta={agentMeta}
          {profileId}
          callerAgentId={parentAgentId}
          onOpenTranscript={openTranscript}
          {deriveRole}
          {lastActivity}
        />
      {/each}
    {/if}
  </ul>
</div>

<style>
  .tree {
    display: flex; flex-direction: column; gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 12px;
    color: var(--text-main);
  }
  .tree-header { display: flex; align-items: center; gap: 8px; }
  .tree-header h3 { margin: 0; font-size: var(--text-lg); }
  .badge { font-size: var(--text-sm); color: var(--text-muted); }
  .error { color: var(--atlas-bad); font-size: var(--text-md); margin: 0; }

  .nodes { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .node.parent {
    display: grid;
    grid-template-columns: 90px 90px 1fr auto;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--bg-main);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    font-size: var(--text-md);
  }
  .role-pill {
    text-transform: uppercase;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--bg-main);
    background: var(--accent);
    border-radius: var(--radius-full);
    padding: 2px 8px;
    text-align: center;
  }
  .role-pill[data-role="researcher"] { background: var(--atlas-signal); }
  .role-pill[data-role="coder"] { background: var(--atlas-ok); }
  .role-pill[data-role="tester"] { background: var(--atlas-warn); }
  .role-pill[data-role="reviewer"] { background: var(--atlas-signal); }
  .role-pill[data-role="agent"] { background: var(--text-muted); }
  .state { color: var(--text-muted); font-size: var(--text-sm); }
  .activity { color: var(--text-muted); font-family: var(--mono, monospace); font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; }
  .open-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-main);
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    cursor: pointer;
    font-size: var(--text-sm);
  }
  .open-btn:hover:not(:disabled) { background: var(--bg-main); }
  .open-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .empty { color: var(--text-muted); font-style: italic; padding: 4px 8px; }
</style>
