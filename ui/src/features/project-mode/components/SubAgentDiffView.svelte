<script>
  // SubAgentDiffView — per-sub-agent diff.
  //
  // Renders the diff for one child agent: "sub-agent X edited these
  // files" with a collapsible per-file breakdown. Re-uses the same
  // color scheme as the global DiffView (green +add, red /del, blue
  // hunk header) so the two read consistently side-by-side.
  //
  // The renderer NEVER has a path. It calls
  // window.progressLedger.subagent.diff(profileId, callerAgentId, agentId, runId, files)
  // and the main process does `git -C <root> diff -- <path>` for each
  // entry in `files`. Per-file line cap + global byte cap are
  // enforced server-side; the component shows `truncated: true` as a
  // small caption.

  let { profileId = null, callerAgentId = null, agentId = null, runId = null, files = [] } = $props();

  let perFile = $state(null);
  let truncated = $state(false);
  let skipped = $state([]);
  let loading = $state(false);
  let error = $state(null);
  let root = $state(null);

  async function refresh() {
    if (profileId == null || callerAgentId == null || agentId == null || !runId || !Array.isArray(files) || files.length === 0) {
      perFile = {};
      return;
    }
    loading = true;
    error = null;
    try {
      const r = await window.progressLedger.subagent.diff(profileId, callerAgentId, agentId, runId, files);
      if (!r || !r.ok) {
        error = (r && r.error && r.error.message) || "Couldn't load sub-agent diff";
        perFile = {};
        return;
      }
      perFile = r.result.perFile || {};
      truncated = !!r.result.truncated;
      skipped = Array.isArray(r.result.skipped) ? r.result.skipped : [];
      root = r.result.root || null;
    } catch (e) {
      error = (e && e.message) || "Unknown error";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    // Re-fetch when any of the inputs change.
    void profileId;
    void agentId;
    void runId;
    void files;
    refresh();
  });

  function lineClass(line) {
    if (line.startsWith("+++") || line.startsWith("---")) return "meta";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    if (line.startsWith("@@")) return "hunk";
    return "ctx";
  }
</script>

<section class="sub-diff" data-testid="sub-agent-diff-view" aria-label="Sub-agent diff">
  <header class="head">
    <span class="title">Files changed ({files.length})</span>
    <button class="refresh" type="button" onclick={refresh} disabled={loading}>
      {loading ? "loading…" : "Refresh"}
    </button>
  </header>

  {#if error}
    <p class="err-msg" data-testid="sub-agent-diff-error">{error}</p>
  {:else if !perFile || Object.keys(perFile).length === 0}
    <p class="muted">No diff available for this sub-agent.</p>
  {:else}
    {#if truncated}
      <p class="muted truncated" data-testid="sub-agent-diff-truncated">
        Diff was truncated{#if skipped.length > 0}; {skipped.length} file(s) omitted{/if}.
      </p>
    {/if}
    {#each files as f (f)}
      {@const text = perFile[f] || ""}
      <details open data-testid={`sub-agent-diff-file-${f.replace(/[^a-z0-9_-]/gi, "-")}`}>
        <summary class="file">{f}</summary>
        {#if !text}
          <pre class="lines muted">{#if root}(clean){:else}(no data){/if}</pre>
        {:else}
          <pre class="lines">{#each text.split("\n") as line, i (i)}<span class={lineClass(line)}>{line}</span>{'\n'}{/each}</pre>
        {/if}
      </details>
    {/each}
    {#each skipped as s (s)}
      <p class="muted skipped">… {s}</p>
    {/each}
  {/if}
</section>

<style>
  .sub-diff {
    border: 1px solid var(--panel-border, var(--atlas-line));
    border-radius: var(--radius-md);
    padding: 8px 10px;
    background: var(--surface, var(--atlas-panel));
    margin-top: 6px;
  }
  .head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 6px;
  }
  .head .title { font-size: var(--text-sm); color: var(--text-main, var(--atlas-ink)); font-weight: 600; }
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
  .muted { color: var(--text-muted, var(--atlas-ink-2)); font-size: var(--text-xs); margin: 0; }
  .truncated { color: var(--atlas-warn); }
  .err-msg { color: var(--color-danger, var(--atlas-bad)); font-size: var(--text-sm); margin: 0; }
  .skipped { padding: 2px 0; }
  details { margin-bottom: 4px; }
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
    color: var(--text-main, var(--atlas-ink-2));
  }
  pre.lines.muted { color: var(--text-muted, var(--atlas-ink-2)); }
  pre.lines .meta { color: var(--text-muted, var(--atlas-ink-3)); }
  pre.lines .hunk { color: var(--atlas-signal); }
  pre.lines .add  { color: var(--atlas-ok); }
  pre.lines .del  { color: var(--atlas-bad); }
  pre.lines .ctx  { color: var(--text-main, var(--atlas-ink-2)); }
</style>