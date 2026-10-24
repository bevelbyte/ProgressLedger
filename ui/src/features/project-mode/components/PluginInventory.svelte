<script>
  // PluginInventory — browse the agent's installed Plugins + their capabilities.
  //
  // Plugins are folders on disk (<userData>/plugins/<id>/) with a plugin.json
  // manifest. The Plugins registry lives in the main process; the renderer
  // queries metadata via `progressLedger.extensions.listPlugins()` and toggles
  // enable/disable via `progressLedger.extensions.enablePlugin()` /
  // `progressLedger.extensions.disablePlugin()`. Hot-reload is available via
  // `progressLedger.extensions.reloadPlugin()`.
  //
  // Columns: id | name | version | enabled (toggle) | capabilities (chips)
  // Click a row to expand the manifest details below the table.
  // A "Reload" button per row re-reads the on-disk manifest.

  import { onMount as svelteOnMount } from "svelte";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null } = $props();

  let plugins = $state([]); // { id, name, version, skills, tools, mcpServers, enabled }
  let loading = $state(false);
  let loadFailed = $state(false);
  let loadError = $state("");
  let busyId = $state(null);

  let expandedId = $state(null);

  function extensionsApi() {
    const w = typeof window !== "undefined" ? window : undefined;
    const ns = w && w.progressLedger && w.progressLedger.extensions;
    return ns &&
      typeof ns.listPlugins === "function" &&
      typeof ns.reloadPlugin === "function" &&
      typeof ns.enablePlugin === "function" &&
      typeof ns.disablePlugin === "function"
      ? ns
      : null;
  }

  async function load() {
    const api = extensionsApi();
    if (!api) {
      loadFailed = true;
      loadError = "Plugins are not available in this build.";
      return;
    }
    loading = true;
    try {
      const res = await api.listPlugins(profileId);
      if (res && res.ok && Array.isArray(res.plugins)) {
        plugins = res.plugins;
        loadFailed = false;
        loadError = "";
      } else {
        loadFailed = true;
        loadError = (res && res.reason) || (res && res.error && res.error.code) || "Could not load plugins.";
        plugins = [];
      }
    } catch (e) {
      loadFailed = true;
      reportError(e, "Could not load plugins");
      loadError = "Could not load plugins.";
      plugins = [];
    } finally {
      loading = false;
    }
  }

  async function toggleEnabled(plugin) {
    const api = extensionsApi();
    if (!api) {
      toast.error("Extensions API is not available.", "Plugin inventory");
      return;
    }
    busyId = plugin.id;
    try {
      const fn = plugin.enabled ? api.disablePlugin : api.enablePlugin;
      const res = await fn(plugin.id, profileId);
      if (res && res.ok) {
        plugin.enabled = !plugin.enabled;
        plugins = [...plugins];
        toast.success(`${plugin.enabled ? "Enabled" : "Disabled"} "${plugin.name}"`);
      } else {
        toast.error(`Failed: ${res && res.reason ? res.reason : "unknown"}`, "Plugin inventory");
      }
    } catch (e) {
      reportError(e, "Could not toggle plugin");
      toast.error("Could not toggle plugin.", "Plugin inventory");
    } finally {
      busyId = null;
    }
  }

  async function reloadPlugin(plugin) {
    const api = extensionsApi();
    if (!api) {
      toast.error("Extensions API is not available.", "Plugin inventory");
      return;
    }
    busyId = plugin.id;
    try {
      const res = await api.reloadPlugin(plugin.id, profileId);
      if (res && res.ok && res.plugin) {
        const idx = plugins.findIndex((p) => p.id === plugin.id);
        if (idx !== -1) {
          plugins[idx] = res.plugin;
          plugins = [...plugins];
        }
        toast.success(`Reloaded "${plugin.name}"`);
      } else {
        toast.error(`Failed: ${res && res.reason ? res.reason : "unknown"}`, "Plugin inventory");
      }
    } catch (e) {
      reportError(e, "Could not reload plugin");
      toast.error("Could not reload plugin.", "Plugin inventory");
    } finally {
      busyId = null;
    }
  }

  function toggleRow(id) {
    expandedId = expandedId === id ? null : id;
  }

  function capabilities(plugin) {
    const caps = [];
    if (Array.isArray(plugin.skills)) caps.push(...plugin.skills.map((s) => ({ type: "Skill", name: s })));
    if (Array.isArray(plugin.tools)) caps.push(...plugin.tools.map((t) => ({ type: "Tool", name: t })));
    if (Array.isArray(plugin.mcpServers)) caps.push(...plugin.mcpServers.map((m) => ({ type: "MCP", name: m })));
    return caps;
  }

  svelteOnMount(() => {
    load();
  });
</script>

<section class="plugin-inventory" data-testid="plugin-inventory">
  <header class="panel-header">
    <h3>Plugin inventory</h3>
    <div class="header-controls">
      <button
        type="button"
        class="refresh-btn"
        data-testid="plugin-inventory-refresh"
        onclick={load}
        disabled={loading}
      >
        {loading ? "Loading…" : "Refresh"}
      </button>
    </div>
  </header>

  {#if loadFailed}
    <p class="note err" data-testid="plugin-inventory-load-error">{loadError}</p>
  {/if}

  <div class="table-wrap" data-testid="plugin-inventory-table-wrap">
    <table class="plugin-table" data-testid="plugin-inventory-table">
      <thead>
        <tr>
          <th scope="col">ID</th>
          <th scope="col">Name</th>
          <th scope="col">Version</th>
          <th scope="col">Enabled</th>
          <th scope="col">Capabilities</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#if plugins.length === 0}
          <tr data-testid="plugin-inventory-empty">
            <td colspan="6" class="empty-cell">
              {loadFailed ? loadError : "No plugins installed."}
            </td>
          </tr>
        {:else}
          {#each plugins as plugin (plugin.id)}
            <tr
              class="plugin-row"
              class:expanded={expandedId === plugin.id}
              data-testid="plugin-row"
              data-plugin-id={plugin.id}
              data-plugin-enabled={plugin.enabled ? "true" : "false"}
              onclick={() => toggleRow(plugin.id)}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleRow(plugin.id);
                }
              }}
              tabindex="0"
              role="button"
              aria-expanded={expandedId === plugin.id}
            >
              <td class="cell-id">{plugin.id}</td>
              <td class="cell-name">{plugin.name || plugin.id}</td>
              <td class="cell-version">v{plugin.version || "—"}</td>
              <td class="cell-enabled">
                <button
                  type="button"
                  class="toggle-btn"
                  class:enabled={plugin.enabled}
                  data-testid="plugin-toggle"
                  data-plugin-id={plugin.id}
                  disabled={busyId === plugin.id}
                  onclick={(e) => {
                    e.stopPropagation();
                    toggleEnabled(plugin);
                  }}
                  aria-label={plugin.enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}
                >
                  {plugin.enabled ? "On" : "Off"}
                </button>
              </td>
              <td class="cell-caps">
                {#if capabilities(plugin).length > 0}
                  {#each capabilities(plugin) as cap (cap.type + cap.name)}
                    <span class="cap-pill" data-plugin-cap={cap.type}>{cap.name}</span>
                  {/each}
                {:else}
                  <span class="muted">—</span>
                {/if}
              </td>
              <td class="cell-actions">
                <button
                  type="button"
                  class="reload-btn"
                  data-testid="plugin-reload"
                  data-plugin-id={plugin.id}
                  disabled={busyId === plugin.id}
                  onclick={(e) => {
                    e.stopPropagation();
                    reloadPlugin(plugin);
                  }}
                  aria-label={`Reload ${plugin.name}`}
                >
                  {busyId === plugin.id ? "…" : "Reload"}
                </button>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  {#if expandedId}
    {#each plugins as plugin (plugin.id)}
      {#if plugin.id === expandedId}
        <div class="preview" data-testid="plugin-preview" data-plugin-id={expandedId}>
          <header class="preview-head">
            <strong>Manifest — {expandedId}</strong>
            <button
              type="button"
              class="close-btn"
              data-testid="plugin-preview-close"
              onclick={() => toggleRow(expandedId)}
              aria-label="Close preview"
            >
              Close
            </button>
          </header>
          <div class="preview-body">
            <dl class="manifest-dl">
              <dt>Name</dt>
              <dd>{plugin.name}</dd>
              <dt>Version</dt>
              <dd>{plugin.version}</dd>
              <dt>Skills</dt>
              <dd>
                {#if plugin.skills && plugin.skills.length}
                  {plugin.skills.join(", ")}
                {:else}
                  <span class="muted">none</span>
                {/if}
              </dd>
              <dt>Tools</dt>
              <dd>
                {#if plugin.tools && plugin.tools.length}
                  {plugin.tools.join(", ")}
                {:else}
                  <span class="muted">none</span>
                {/if}
              </dd>
              <dt>MCP Servers</dt>
              <dd>
                {#if plugin.mcpServers && plugin.mcpServers.length}
                  {plugin.mcpServers.join(", ")}
                {:else}
                  <span class="muted">none</span>
                {/if}
              </dd>
              <dt>Status</dt>
              <dd>
                <span class="status-badge" class:enabled={plugin.enabled}>
                  {plugin.enabled ? "enabled" : "disabled"}
                </span>
              </dd>
            </dl>
          </div>
        </div>
      {/if}
    {/each}
  {/if}
</section>

<style>
  .plugin-inventory {
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
  .header-controls {
    display: flex;
    align-items: center;
    gap: 6px;
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

  .note {
    font-size: var(--text-sm);
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .note.err {
    color: var(--color-danger);
    background: var(--color-danger-bg);
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .plugin-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-md);
  }
  .plugin-table th,
  .plugin-table td {
    padding: 8px 10px;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--border);
  }
  .plugin-table th {
    background: var(--surface);
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--text-sm);
  }
  .plugin-table tbody tr:last-child td { border-bottom: none; }
  .plugin-row {
    cursor: pointer;
    background: var(--bg-main);
    transition: background var(--trans-fast, 120ms ease);
  }
  .plugin-row:hover { background: var(--surface); }
  .plugin-row:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
  .plugin-row.expanded { background: var(--surface); }
  .cell-id { font-family: var(--mono, monospace); color: var(--text-secondary); }
  .cell-name { font-weight: 600; color: var(--text-main); }
  .cell-version { color: var(--text-muted); white-space: nowrap; }
  .cell-enabled { text-align: center; }
  .toggle-btn {
    font-size: var(--text-sm);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    background: var(--bg-card);
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--trans-fast, 120ms ease);
  }
  .toggle-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .toggle-btn.enabled {
    background: var(--accent, var(--atlas-ok));
    color: var(--bg-main);
    border-color: var(--accent, var(--atlas-ok));
  }
  .cell-caps {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-width: 260px;
  }
  .cap-pill {
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .cap-pill[data-plugin-cap="Skill"] {
    color: var(--atlas-signal);
    border-color: var(--atlas-signal);
  }
  .cap-pill[data-plugin-cap="Tool"] {
    color: var(--atlas-warn);
    border-color: var(--atlas-warn);
  }
  .cap-pill[data-plugin-cap="MCP"] {
    color: var(--atlas-signal);
    border-color: var(--atlas-signal);
  }
  .cell-actions { text-align: center; }
  .reload-btn {
    font-size: var(--text-sm);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-card);
    color: var(--text-muted);
    cursor: pointer;
  }
  .reload-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .muted { color: var(--text-muted); }
  .empty-cell {
    text-align: center;
    color: var(--text-muted);
    padding: 16px;
  }

  .preview {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    padding: 8px 10px;
  }
  .preview-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .preview-head strong {
    font-size: var(--text-md);
    color: var(--text-main);
  }
  .close-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    cursor: pointer;
    font-size: var(--text-sm);
  }
  .preview-body {
    padding: 8px 10px;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--text-md);
    color: var(--text-main);
  }
  .manifest-dl {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 4px 10px;
    margin: 0;
  }
  .manifest-dl dt {
    font-weight: 600;
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .manifest-dl dd {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .status-badge {
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .status-badge.enabled {
    color: var(--accent, var(--atlas-ok));
    border-color: var(--accent, var(--atlas-ok));
  }
</style>
