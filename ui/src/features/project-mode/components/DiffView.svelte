<script>
  // DiffView — shows `git diff` output for the active project.
  //
  // The renderer NEVER has a path. It calls window.progressLedger.diff.workingTree
  // with (profileId, agentId); the main process resolves the per-agent
  // projectRoot from the registry and invokes the existing shell_git_diff
  // tool (with the assertInsideProjectRoot sandbox already in place).
  //
  // The diff is rendered as a list of file sections. Lines are colored:
  //   + green  (additions)
  //   - red    (deletions)
  //   context (gray, no highlight)

  import { onMount } from "svelte";

  let { profileId = null, agentId = null, refreshIntervalMs = 0, staged = false } = $props();

  let diff = $state("");
  let truncated = $state(false);
  let loading = $state(false);
  let error = $state(null);
  let root = $state(null);

  async function refresh() {
    if (profileId == null || agentId == null) return;
    loading = true;
    error = null;
    try {
      const r = await window.progressLedger.diff.workingTree(profileId, agentId, { staged });
      if (!r || !r.ok) {
        error = (r && r.error && r.error.message) || "Couldn't load diff";
        diff = "";
        return;
      }
      diff = r.result.diff || "";
      truncated = !!r.result.truncated;
      root = r.result.root || null;
    } catch (e) {
      error = (e && e.message) || "Unknown error";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (profileId != null && agentId != null) refresh();
  });

  // Optional auto-refresh (e.g. every 5s) for an at-a-glance view.
  $effect(() => {
    if (refreshIntervalMs > 0 && profileId != null && agentId != null) {
      const t = setInterval(refresh, refreshIntervalMs);
      return () => clearInterval(t);
    }
  });

  // Parse the unified diff into per-file sections.
  function parseSections(d) {
    if (!d) return [];
    const sections = [];
    const lines = d.split("\n");
    let cur = null;
    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        if (cur) sections.push(cur);
        cur = { file: line.slice("diff --git ".length), lines: [] };
      } else if (cur) {
        cur.lines.push(line);
      }
    }
    if (cur) sections.push(cur);
    return sections;
  }

  function lineClass(line) {
    if (line.startsWith("+++") || line.startsWith("---")) return "meta";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    if (line.startsWith("@@")) return "hunk";
    return "ctx";
  }
</script>

<section class="diff-view" aria-label="Working tree diff">
  <header class="head">
    <h3>Diff</h3>
    <div class="head-actions">
      <label>
        <input type="checkbox" bind:checked={staged} onchange={refresh} />
        Staged
      </label>
      <button class="refresh" type="button" onclick={refresh} disabled={loading}>
        {loading ? "loading…" : "Refresh"}
      </button>
    </div>
  </header>

  {#if error}
    <p class="err-msg">{error}</p>
  {:else if !diff}
    <p class="muted">No changes in the working tree.</p>
  {:else}
    {#if truncated}
      <p class="muted truncated">Diff was truncated; raise maxBytes to see more.</p>
    {/if}
    {#each parseSections(diff) as sec (sec.file)}
      <details open>
        <summary class="file">{sec.file}</summary>
        <pre class="lines">{#each sec.lines as line, i (i)}<span class={lineClass(line)}>{line}</span>{'\n'}{/each}</pre>
      </details>
    {/each}
  {/if}
</section>

<style>
  .diff-view { border: 1px solid var(--panel-border, var(--atlas-line)); border-radius: var(--radius-lg); padding: 10px 12px; background: var(--surface, var(--atlas-panel)); }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .head h3 { margin: 0; font-size: var(--text-md); font-weight: 600; color: var(--text-main, var(--atlas-ink)); }
  .head-actions { display: flex; gap: 8px; align-items: center; font-size: var(--text-sm); color: var(--text-muted, var(--atlas-ink-2)); }
  .head-actions label { display: flex; gap: 4px; align-items: center; }
  .refresh {
    background: var(--surface-2, var(--atlas-panel));
    color: var(--text-main, var(--atlas-ink));
    border: 1px solid var(--panel-border, var(--atlas-line));
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .refresh:disabled { opacity: 0.5; cursor: default; }
  .muted { color: var(--text-muted, var(--atlas-ink-2)); font-size: var(--text-sm); margin: 0; }
  .truncated { color: var(--atlas-warn); }
  .err-msg { color: var(--color-danger, var(--atlas-bad)); font-size: var(--text-sm); }
  details { margin-bottom: 6px; }
  summary.file { cursor: pointer; font-size: var(--text-sm); color: var(--accent, var(--atlas-signal)); }
  pre.lines {
    margin: 4px 0 0 0;
    padding: 6px 8px;
    background: var(--atlas-void);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--text-xs);
    line-height: 1.45;
  }
  pre.lines .meta { color: var(--text-muted, var(--atlas-ink-3)); }
  pre.lines .hunk { color: var(--atlas-signal); }
  pre.lines .add  { color: var(--atlas-ok); }
  pre.lines .del  { color: var(--atlas-bad); }
  pre.lines .ctx  { color: var(--text-main, var(--atlas-ink-2)); }
</style>
