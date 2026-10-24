<script>
  // MarketplacePanel — browse, install, enable/disable/uninstall/update
  // marketplace items (extensions, plugins, skills, etc.) backed by the
  // shell's `Marketplace` service via the `careerflow.marketplace.*`
  // preload bridge.
  //
  // The renderer never sees the on-disk install path of a git clone —
  // the IPC layer strips `install_path` before returning.

  import { onMount as svelteOnMount } from "svelte";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";

  /**
   * Derive a human-readable list of extension "types" this item contributes.
   * The marketplace item IS a plugin — its manifest declares `skills`,
   * `tools`, `mcpServers`. We surface those so users can see what
   * they're installing at a glance.
   */
  function deriveTypes(item) {
    const types = [];
    if (item.skills && item.skills.length) types.push("Skill");
    if (item.tools && item.tools.length) types.push("Sub-agent");
    if (item.mcpServers && item.mcpServers.length) types.push("MCP");
    if (types.length === 0) types.push("Plugin");
    return types;
  }

  function sourceLabel(item) {
    if (!item.source) return "unknown";
    if (item.source.kind === "git") {
      const ref = item.source.ref && item.source.ref !== "HEAD" ? `@${item.source.ref}` : "";
      return `git: ${item.source.url || ""}${ref}`;
    }
    if (item.source.kind === "local") return `local: ${item.source.path || ""}`;
    return item.source.kind || "unknown";
  }

  let items = $state([]);
  let loading = $state(false);
  let busyId = $state(null);

  let localPath = $state("");
  let gitUrl = $state("");
  let gitRef = $state("");
  let installing = $state(false);

  async function refresh() {
    loading = true;
    try {
      const res = await window.careerflow.marketplace.list();
      items = res && res.ok ? res.items : [];
    } catch (e) {
      reportError(e, "Could not load marketplace");
      items = [];
    } finally {
      loading = false;
    }
  }

  svelteOnMount(() => {
    refresh();
  });

  async function runOnItem(id, fn, successMsg) {
    busyId = id;
    try {
      const res = await fn();
      if (res && res.ok) {
        if (successMsg) toast.success(successMsg);
        await refresh();
      } else {
        toast.error(`Failed: ${res && res.reason ? res.reason : "unknown"}`, "Marketplace");
      }
    } catch (e) {
      reportError(e, "Marketplace operation failed");
    } finally {
      busyId = null;
    }
  }

  function enable(item) {
    return runOnItem(
      item.id,
      () => window.careerflow.marketplace.enable(item.id),
      `Enabled “${item.name}”`,
    );
  }

  function disable(item) {
    return runOnItem(
      item.id,
      () => window.careerflow.marketplace.disable(item.id),
      `Disabled “${item.name}”`,
    );
  }

  function uninstall(item) {
    if (!confirm(`Uninstall “${item.name}”? This removes its files from disk.`)) return;
    return runOnItem(
      item.id,
      () => window.careerflow.marketplace.uninstall(item.id),
      `Uninstalled “${item.name}”`,
    );
  }

  function update(item) {
    return runOnItem(
      item.id,
      () => window.careerflow.marketplace.update(item.id),
      `Updated “${item.name}”`,
    );
  }

  async function submitLocal() {
    const p = localPath.trim();
    if (!p) {
      toast.warning("Provide a local path.", "Install local");
      return;
    }
    installing = true;
    try {
      const res = await window.careerflow.marketplace.installLocal(p);
      if (res && res.ok) {
        toast.success(`Installed “${res.id}”`);
        localPath = "";
        await refresh();
      } else {
        toast.error(`Failed: ${res && res.reason ? res.reason : "unknown"}`, "Install local");
      }
    } catch (e) {
      reportError(e, "Local install failed");
    } finally {
      installing = false;
    }
  }

  async function submitGit() {
    const u = gitUrl.trim();
    if (!u) {
      toast.warning("Provide a Git URL.", "Install Git");
      return;
    }
    installing = true;
    try {
      const res = await window.careerflow.marketplace.installGit(u, gitRef.trim() || "HEAD");
      if (res && res.ok) {
        toast.success(`Installed “${res.id}” (v${res.version})`);
        gitUrl = "";
        gitRef = "";
        await refresh();
      } else {
        toast.error(`Failed: ${res && res.reason ? res.reason : "unknown"}`, "Install Git");
      }
    } catch (e) {
      reportError(e, "Git install failed");
    } finally {
      installing = false;
    }
  }
</script>

<section class="marketplace-panel" data-testid="marketplace-panel">
  <header class="panel-header">
    <h3>Marketplace</h3>
    <button
      type="button"
      class="refresh-btn"
      data-testid="marketplace-refresh"
      onclick={refresh}
      disabled={loading}
    >
      {loading ? "Loading…" : "Refresh"}
    </button>
  </header>

  <div class="install-forms">
    <div class="form-row" data-testid="install-local-form">
      <label class="form-label" for="mp-local-path">Install from local path</label>
      <div class="form-controls">
        <input
          id="mp-local-path"
          type="text"
          data-testid="install-local-path"
          bind:value={localPath}
          placeholder="/absolute/path/to/plugin"
          spellcheck="false"
        />
        <button
          type="button"
          class="primary-btn"
          data-testid="install-local-btn"
          onclick={submitLocal}
          disabled={installing}
        >
          Install
        </button>
      </div>
    </div>

    <div class="form-row" data-testid="install-git-form">
      <label class="form-label" for="mp-git-url">Install from Git URL</label>
      <div class="form-controls">
        <input
          id="mp-git-url"
          type="text"
          data-testid="install-git-url"
          bind:value={gitUrl}
          placeholder="https://github.com/owner/plugin.git"
          spellcheck="false"
        />
        <input
          id="mp-git-ref"
          type="text"
          data-testid="install-git-ref"
          bind:value={gitRef}
          placeholder="HEAD"
          class="ref-input"
          spellcheck="false"
        />
        <button
          type="button"
          class="primary-btn"
          data-testid="install-git-btn"
          onclick={submitGit}
          disabled={installing}
        >
          Install
        </button>
      </div>
    </div>
  </div>

  <div class="items-list" data-testid="marketplace-items">
    {#if items.length === 0}
      <div class="empty" data-testid="marketplace-empty">
        <p>No marketplace items installed yet.</p>
        <p class="hint">
          Browse extensions by installing from a local plugin folder or
          cloning a public Git repository. Installed items expose Skills,
          Sub-agents, MCP servers and Plugins to your projects.
        </p>
      </div>
    {:else}
      {#each items as item (item.id)}
        <article
          class="item"
          data-testid="marketplace-item"
          data-item-id={item.id}
          data-item-enabled={item.enabled ? "true" : "false"}
        >
          <div class="item-meta">
            <div class="item-row">
              <span class="item-name">{item.name}</span>
              <span class="item-version">v{item.version}</span>
              <span class="item-status" class:enabled={item.enabled}>
                {item.enabled ? "enabled" : "disabled"}
              </span>
            </div>
            <div class="item-row item-source" title={sourceLabel(item)}>
              <span class="item-id">{item.id}</span>
              <span class="item-source-text">{sourceLabel(item)}</span>
            </div>
            <div class="item-row item-types" data-testid="item-types">
              {#each deriveTypes(item) as t}
                <span class="type-pill">{t}</span>
              {/each}
            </div>
          </div>
          <div class="item-actions">
            {#if item.enabled}
              <button
                type="button"
                class="action-btn"
                data-testid="item-disable"
                onclick={() => disable(item)}
                disabled={busyId === item.id}
              >
                Disable
              </button>
            {:else}
              <button
                type="button"
                class="action-btn"
                data-testid="item-enable"
                onclick={() => enable(item)}
                disabled={busyId === item.id}
              >
                Enable
              </button>
            {/if}
            <button
              type="button"
              class="action-btn"
              data-testid="item-update"
              onclick={() => update(item)}
              disabled={busyId === item.id}
            >
              Update
            </button>
            <button
              type="button"
              class="action-btn danger"
              data-testid="item-uninstall"
              onclick={() => uninstall(item)}
              disabled={busyId === item.id}
            >
              Uninstall
            </button>
          </div>
        </article>
      {/each}
    {/if}
  </div>
</section>

<style>
  .marketplace-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
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

  .install-forms {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .form-row { display: flex; flex-direction: column; gap: 4px; }
  .form-label {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .form-controls {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .form-controls input {
    flex: 1;
    min-width: 0;
    background: var(--bg-card);
    color: var(--text-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font-family: inherit;
    font-size: var(--text-md);
  }
  .form-controls input:focus { outline: 1px solid var(--accent); }
  .form-controls .ref-input { max-width: 90px; flex: 0 0 90px; }
  .primary-btn {
    padding: 6px 12px;
    background: var(--accent);
    color: var(--bg-main);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: var(--text-md);
    font-weight: 500;
  }
  .primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .items-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .empty {
    padding: 14px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    text-align: center;
  }
  .empty .hint { font-size: var(--text-sm); margin-top: 6px; }
  .item {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-main);
  }
  .item-meta { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .item-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .item-name { font-weight: 600; color: var(--text-main); }
  .item-version {
    font-size: var(--text-sm);
    color: var(--text-muted);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: var(--bg-card);
    border: 1px solid var(--border);
  }
  .item-status {
    font-size: var(--text-sm);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .item-status.enabled {
    color: var(--accent, var(--atlas-ok));
    border-color: var(--accent, var(--atlas-ok));
  }
  .item-source {
    font-size: var(--text-sm);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-id { font-family: var(--mono, monospace); }
  .item-source-text { overflow: hidden; text-overflow: ellipsis; }
  .item-types { gap: 4px; }
  .type-pill {
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .item-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .action-btn {
    background: var(--bg-card);
    color: var(--text-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    cursor: pointer;
    font-size: var(--text-sm);
  }
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-btn.danger { color: var(--atlas-bad); border-color: var(--atlas-bad); }
</style>