<script>
  // TreeNode — single node in the sub-agent tree. Renders the agent's
  // role/state/activity and an Expand/Collapse toggle for any children.
  // The parent (SubAgentTree) supplies a `node` shape:
  //   { agent, children: [{ agent, children: [...], overflow: number }], overflow: number }
  // `overflow` is the count of grandchildren beyond depth 2; rendered as
  // "+N more" rather than fetched recursively (keeps the tree bounded
  // — bounded recursion guards against pathological spawn chains).
  //
  // The component is intentionally small: all data loading lives in
  // SubAgentTree. Recursion is handled here so each level renders its
  // own children through the same component (Svelte's standard
  // recursive-component pattern).

  import SubAgentDiffView from "./SubAgentDiffView.svelte";
  import Self from "./TreeNode.svelte";

  let {
    node = null,
    depth = 0,
    childMeta = {},
    profileId = null,
    callerAgentId = null,
    onOpenTranscript = () => {},
    deriveRole = (_a) => "agent",
    lastActivity = (_a) => "",
  } = $props();

  let expanded = $state(true);

  function toggle() {
    expanded = !expanded;
  }

  // True when this node has any grandchildren to render OR an overflow
  // count to surface. Drives the visibility of the toggle button.
  function hasChildren(node) {
    if (!node) return false;
    if (Array.isArray(node.children) && node.children.length > 0) return true;
    if (typeof node.overflow === "number" && node.overflow > 0) return true;
    return false;
  }
</script>

{#if node && node.agent}
  <li
    class="node child"
    class:has-children={hasChildren(node)}
    data-testid={`tree-child-${node.agent.id}`}
    data-depth={depth}
  >
    <span class="role-pill" data-role={deriveRole(node.agent)}>
      {deriveRole(node.agent)}
    </span>
    <span class="state" data-state={node.agent.state}>{node.agent.state}</span>
    <span class="activity">{lastActivity(node.agent)}</span>
    <button
      type="button"
      class="open-btn"
      data-testid={`open-child-${node.agent.id}`}
      onclick={() => onOpenTranscript(node.agent)}
    >
      Open transcript
    </button>
    {#if hasChildren(node)}
      <button
        type="button"
        class="toggle-btn"
        data-testid={`toggle-${node.agent.id}`}
        aria-expanded={expanded}
        onclick={toggle}
      >
        {expanded ? "Collapse" : "Expand"}
      </button>
    {/if}
    {#if childMeta[node.agent.id] && childMeta[node.agent.id].files && childMeta[node.agent.id].files.length > 0}
      <SubAgentDiffView
        {profileId}
        {callerAgentId}
        agentId={node.agent.id}
        runId={childMeta[node.agent.id].runId}
        files={childMeta[node.agent.id].files}
      />
    {/if}

    {#if expanded && hasChildren(node)}
      <ul class="nodes nested" data-testid={`tree-nested-${node.agent.id}`}>
        {#each node.children as child (child.agent.id)}
          <Self
            node={child}
            depth={depth + 1}
            {childMeta}
            {profileId}
            {callerAgentId}
            {onOpenTranscript}
            {deriveRole}
            {lastActivity}
          />
        {/each}
        {#if node.overflow > 0}
          <li class="overflow" data-testid={`tree-overflow-${node.agent.id}`}>
            +{node.overflow} more
          </li>
        {/if}
      </ul>
    {/if}
  </li>
{/if}

<style>
  .node {
    display: grid;
    grid-template-columns: 90px 90px 1fr auto auto;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--text-md);
  }
  .node.has-children {
    grid-template-rows: auto auto;
  }
  .nested {
    grid-column: 1 / -1;
    margin: 6px 0 0 16px;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-left: 1px dashed var(--border);
    padding-left: 10px;
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
  .toggle-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    padding: 2px 6px;
    cursor: pointer;
    font-size: var(--text-xs);
  }
  .toggle-btn:hover { color: var(--text-main); }
  .overflow {
    grid-column: 1 / -1;
    color: var(--text-muted);
    font-style: italic;
    font-size: var(--text-sm);
    padding: 2px 8px;
  }
</style>