<script>
  // ToolInventory -- browse the agent's available tools + their schemas.
  //
  // Reads the safe metadata from `window.careerflow.projectTools.list()`
  // which calls the main-process `project:list-tools` IPC. The renderer
  // never sees the execute function -- only `name`, `description`,
  // `permission`, `inputSchema` (plus `approvalRequired` and
  // `permissionInfo` for UI affordances).
  //
  // Categories are derived from the tool name (filesystem, git, exec,
  // delegate, project, memory). The component is read-only -- it does
  // not invoke tools or mint approval tokens.

  import { onMount as svelteOnMount } from "svelte";
  import { reportError } from "../../../shared/utils/errors.js";

  /**
   * Map a tool name into a human-readable category bucket used by the
   * category filter dropdown. The buckets match the on-disk layout in
   * `shell/src/services/project-tools/` so a user sees the same grouping
   * in code and in this panel.
   */
  function categoryOf(name) {
    if (!name) return "other";
    if (name.startsWith("fs_")) return "filesystem";
    if (name.startsWith("shell_git_")) return "git";
    if (name === "exec_run" || name === "build_run" || name === "test_run") return "exec";
    if (name.startsWith("delegate_")) return "delegate";
    if (name === "inspect_project") return "project";
    if (name === "memory_recall") return "memory";
    return "other";
  }

  function computeCategories(list) {
    const set = new Set(list.map((t) => categoryOf(t.name)));
    return ["all", ...[...set].sort()];
  }

  function computeFiltered(list, q, cat) {
    const needle = q.trim().toLowerCase();
    return list.filter((t) => {
      if (cat !== "all" && categoryOf(t.name) !== cat) return false;
      if (!needle) return true;
      const hay = `${t.name} ${t.description || ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }

  let tools = $state([]);
  let approvalRequired = $state([]);
  let permissionInfo = $state({});
  let loading = $state(false);
  let search = $state("");
  let category = $state("all");
  let expanded = $state({}); // toolName -> bool

  let categories = $derived(computeCategories(tools));
  let filtered = $derived(computeFiltered(tools, search, category));

  async function refresh() {
    loading = true;
    try {
      const res = await window.careerflow.projectTools.list();
      if (res && res.ok) {
        tools = Array.isArray(res.tools) ? res.tools : [];
        approvalRequired = Array.isArray(res.approvalRequired) ? res.approvalRequired : [];
        permissionInfo = res.permissionInfo && typeof res.permissionInfo === "object" ? res.permissionInfo : {};
      } else {
        tools = [];
      }
    } catch (e) {
      reportError(e, "Could not load tool inventory");
      tools = [];
    } finally {
      loading = false;
    }
  }

  svelteOnMount(() => {
    refresh();
  });

  function toggle(name) {
    expanded = { ...expanded, [name]: !expanded[name] };
  }

  function permissionLabel(p) {
    const info = permissionInfo && permissionInfo[p];
    return (info && info.label) || p;
  }

  function isApprovalRequired(name) {
    return approvalRequired.includes(name);
  }

  function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n - 1) + "..." : s;
  }
</script>

<section class="tool-inventory" data-testid="tool-inventory">
  <header class="panel-header">
    <h3>Tool inventory</h3>
    <button
      type="button"
      class="refresh-btn"
      data-testid="tool-inventory-refresh"
      onclick={refresh}
      disabled={loading}
    >
      {loading ? "Loading..." : "Refresh"}
    </button>
  </header>

  <div class="filters">
    <input
      type="search"
      class="search"
      data-testid="tool-inventory-search"
      placeholder="Search by name or description..."
      bind:value={search}
      spellcheck="false"
    />
    <label class="cat-label" for="tool-inventory-category">Category</label>
    <select
      id="tool-inventory-category"
      class="category"
      data-testid="tool-inventory-category"
      bind:value={category}
    >
      {#each categories as c}
        <option value={c}>{c}</option>
      {/each}
    </select>
    <span class="count" data-testid="tool-inventory-count">
      {filtered.length}/{tools.length}
    </span>
  </div>

  <div class="tools-list" data-testid="tool-inventory-list">
    {#if loading && tools.length === 0}
      <div class="empty" data-testid="tool-inventory-loading">Loading tools...</div>
    {:else if tools.length === 0}
      <div class="empty" data-testid="tool-inventory-empty">
        No tools registered. Start a project agent to load the registry.
      </div>
    {:else if filtered.length === 0}
      <div class="empty" data-testid="tool-inventory-no-match">
        No tools match the current filter.
      </div>
    {:else}
      {#each filtered as tool (tool.name)}
        <article
          class="tool"
          data-testid="tool-row"
          data-tool-name={tool.name}
          data-tool-permission={tool.permission}
          data-tool-approval={isApprovalRequired(tool.name) ? "true" : "false"}
        >
          <!-- perm class set in markup via permClass() helper below -->
          <header class="tool-head">
            <span class="tool-name">{tool.name}</span>
            <span
              class={`perm perm-${tool.permission}`}
              data-testid="tool-permission"
              title={(permissionInfo[tool.permission] && permissionInfo[tool.permission].description) || tool.permission}
            >
              {permissionLabel(tool.permission)}
            </span>
            {#if isApprovalRequired(tool.name)}
              <span class="approval-flag" data-testid="tool-approval-flag">approval</span>
            {/if}
            <button
              type="button"
              class="expand-btn"
              data-testid="tool-expand"
              aria-expanded={!!expanded[tool.name]}
              onclick={() => toggle(tool.name)}
            >
              {expanded[tool.name] ? "Hide schema" : "Show schema"}
            </button>
          </header>
          <p class="tool-desc" title={tool.description}>
            {truncate(tool.description, 140)}
          </p>
          {#if expanded[tool.name]}
            <pre class="schema" data-testid="tool-schema">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
          {/if}
        </article>
      {/each}
    {/if}
  </div>
</section>

<style>
  .tool-inventory {
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
  }
  .panel-header h3 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
  }
  .refresh-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: var(--text-md);
  }
  .refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .filters {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: 6px;
    align-items: center;
  }
  .search, .category {
    background: var(--bg-main);
    color: var(--text-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 5px 8px;
    font-family: inherit;
    font-size: var(--text-md);
    min-width: 0;
  }
  .search:focus, .category:focus { outline: 1px solid var(--accent); }
  .cat-label {
    font-size: var(--text-sm);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .count {
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .tools-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 360px;
    overflow-y: auto;
  }
  .empty {
    padding: 14px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    text-align: center;
    font-size: var(--text-md);
  }
  .tool {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-main);
  }
  .tool-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .tool-name {
    font-family: var(--mono, monospace);
    font-weight: 600;
    font-size: var(--text-md);
    color: var(--text-main);
  }
  .perm {
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .perm-READ { color: var(--atlas-signal); border-color: var(--atlas-signal); }
  .perm-WRITE { color: var(--atlas-signal); border-color: var(--atlas-signal); }
  .perm-EXECUTE { color: var(--atlas-bad); border-color: var(--atlas-bad); }
  .perm-NETWORK { color: var(--atlas-signal); border-color: var(--atlas-signal); }
  .perm-DESTRUCTIVE { color: var(--atlas-bad); border-color: var(--atlas-bad); background: var(--atlas-bad-bg); }
  .approval-flag {
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--atlas-bad);
    color: var(--atlas-bad);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .expand-btn {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: var(--text-sm);
  }
  .expand-btn:hover { color: var(--text-main); border-color: var(--accent); }
  .tool-desc {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
    line-height: 1.35;
  }
  .schema {
    margin: 4px 0 0 0;
    padding: 8px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: var(--mono, monospace);
    font-size: var(--text-sm);
    color: var(--text-main);
    overflow-x: auto;
    white-space: pre;
  }
</style>