<script>
// ProjectDiff — per-file summary of the active project's working-tree diff.
//
// Unlike DiffView (which renders the raw unified diff inline), this panel
// shows a compact table: file | status badge | +N/-M line counts. Each row
// is clickable to expand the full per-file diff. A status filter lets the
// user focus on added / modified / deleted files.
//
// The renderer NEVER has a path. It calls window.careerflow.diff.workingTree
// with (profileId, agentId); the main process resolves the per-agent
// projectRoot and invokes the existing shell_git_diff tool.

import { onMount } from "svelte";
import { ChevronDown, ChevronRight } from "lucide-svelte";

let { profileId = null, agentId = null, refreshIntervalMs = 0 } = $props();

let sections = $state([]);
let truncated = $state(false);
let loading = $state(false);
let error = $state(null);
let filter = $state("all"); // "all" | "added" | "modified" | "deleted"

// Parse the unified diff into per-file sections with status + line counts.
function parseSections(d) {
  if (!d) return [];
  const sections = [];
  const lines = d.split("\n");
  let cur = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (cur) sections.push(cur);
      const rest = line.slice("diff --git ".length);
      // git diff --git <a-path> <b-path>
      const parts = rest.split(" ");
      const aPath = parts[0] || "";
      const bPath = parts[1] || "";
      const file = (bPath.startsWith("b/") ? bPath.slice(2) : bPath)
        || (aPath.startsWith("a/") ? aPath.slice(2) : aPath)
        || rest;
      cur = { file, lines: [], adds: 0, dels: 0 };
    } else if (cur) {
      cur.lines.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) cur.adds += 1;
      if (line.startsWith("-") && !line.startsWith("---")) cur.dels += 1;
    }
  }
  if (cur) sections.push(cur);

  // Derive status from the diff headers inside each section.
  for (const sec of sections) {
    let status = "modified";
    for (const line of sec.lines) {
      if (line.startsWith("+++ ") && (line.includes("/dev/null") || line === "+++ /dev/null")) {
        status = "deleted";
        break;
      }
      if (line.startsWith("--- ") && (line.includes("/dev/null") || line === "--- /dev/null")) {
        status = "added";
        break;
      }
    }
    sec.status = status;
  }
  return sections;
}

function statusLabel(s) {
  if (s === "added") return "A";
  if (s === "deleted") return "D";
  return "M";
}

function statusClass(s) {
  if (s === "added") return "badge-added";
  if (s === "deleted") return "badge-deleted";
  return "badge-modified";
}

function filteredSections() {
  if (filter === "all") return sections;
  return sections.filter((s) => s.status === filter);
}

function lineClass(line) {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  if (line.startsWith("@@")) return "diff-hunk";
  return "diff-ctx";
}

async function refresh() {
  if (profileId == null || agentId == null) return;
  loading = true;
  error = null;
  try {
    const r = await window.careerflow.diff.workingTree(profileId, agentId);
    if (!r || !r.ok) {
      error = (r && r.error && r.error.message) || "Couldn't load diff";
      sections = [];
      return;
    }
    sections = parseSections(r.result.diff || "");
    truncated = !!r.result.truncated;
  } catch (e) {
    error = (e && e.message) || "Unknown error";
    sections = [];
  } finally {
    loading = false;
  }
}

$effect(() => {
  if (profileId != null && agentId != null) refresh();
});

$effect(() => {
  if (refreshIntervalMs > 0 && profileId != null && agentId != null) {
    const t = setInterval(refresh, refreshIntervalMs);
    return () => clearInterval(t);
  }
});
</script>

<section class="project-diff" aria-label="Project file diff">
  <header class="head">
    <h3>Project Diff</h3>
    <div class="head-actions">
      <div class="filter-group" role="group" aria-label="Filter by status">
        {#each ["all", "added", "modified", "deleted"] as f}
          <button
            class="filter-btn {filter === f ? 'active' : ''}"
            type="button"
            onclick={() => filter = f}
            aria-pressed={filter === f}
          >
            {f === "all" ? "All" : statusLabel(f)}
          </button>
        {/each}
      </div>
      <button class="refresh" type="button" onclick={refresh} disabled={loading}>
        {loading ? "loading…" : "Refresh"}
      </button>
    </div>
  </header>

  {#if error}
    <p class="err-msg">{error}</p>
  {:else if !sections.length}
    <p class="muted">{loading ? "Loading…" : "No changes in the working tree."}</p>
  {:else}
    {#if truncated}
      <p class="muted truncated">Diff was truncated; raise maxBytes to see more.</p>
    {/if}
    <div class="summary-count">
      {sections.length} file{sections.length !== 1 ? "s" : ""} changed
      {#if sections.reduce((s, x) => s + x.adds, 0) > 0}
        , <span class="add-count">+{sections.reduce((s, x) => s + x.adds, 0)}</span>
      {/if}
      {#if sections.reduce((s, x) => s + x.dels, 0) > 0}
        , <span class="del-count">-{sections.reduce((s, x) => s + x.dels, 0)}</span>
      {/if}
    </div>
    <table class="diff-table">
      <thead>
        <tr>
          <th class="col-status">Status</th>
          <th class="col-file">File</th>
          <th class="col-adds">+</th>
          <th class="col-dels">−</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredSections() as sec (sec.file)}
          <tr class="row">
            <td class="col-status">
              <span class="badge {statusClass(sec.status)}">{statusLabel(sec.status)}</span>
            </td>
            <td class="col-file">
              <button class="file-btn" type="button" onclick={() => sec.open = !sec.open}>
                <span class="chevron" aria-hidden="true">
                  {#if sec.open}
                    <ChevronDown size={13} strokeWidth={2} />
                  {:else}
                    <ChevronRight size={13} strokeWidth={2} />
                  {/if}
                </span>
                <span class="file-name">{sec.file}</span>
              </button>
            </td>
            <td class="col-adds">{sec.adds}</td>
            <td class="col-dels">{sec.dels}</td>
          </tr>
          {#if sec.open}
            <tr>
              <td colspan="4">
                <pre class="diff-block">{#each sec.lines as line, i (i)}<span class={lineClass(line)}>{line}</span>{'\n'}{/each}</pre>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .project-diff {
    border: 1px solid var(--panel-border, var(--atlas-line));
    border-radius: var(--radius-lg);
    padding: 10px 12px;
    background: var(--surface, var(--atlas-panel));
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .head h3 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text-main, var(--atlas-ink));
  }
  .head-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .filter-group {
    display: flex;
    gap: 2px;
    background: var(--bg-main, var(--atlas-base));
    border-radius: var(--radius-md);
    padding: 2px;
  }
  .filter-btn {
    background: transparent;
    border: none;
    color: var(--text-muted, var(--atlas-ink-2));
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--trans-fast), color var(--trans-fast);
  }
  .filter-btn:hover { color: var(--text-main, var(--atlas-ink)); }
  .filter-btn.active {
    background: var(--surface-2, var(--atlas-panel));
    color: var(--text-main, var(--atlas-ink));
  }
  .refresh {
    background: var(--surface-2, var(--atlas-panel));
    color: var(--text-main, var(--atlas-ink));
    border: 1px solid var(--panel-border, var(--atlas-line));
    border-radius: var(--radius-sm);
    padding: 3px 10px;
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .refresh:disabled { opacity: 0.5; cursor: default; }
  .muted { color: var(--text-muted, var(--atlas-ink-2)); font-size: var(--text-sm); margin: 0; }
  .truncated { color: var(--atlas-warn); }
  .err-msg { color: var(--color-danger, var(--atlas-bad)); font-size: var(--text-sm); }
  .summary-count {
    font-size: var(--text-xs);
    color: var(--text-muted, var(--atlas-ink-2));
    margin-bottom: 8px;
  }
  .add-count { color: var(--atlas-ok); font-weight: 600; }
  .del-count { color: var(--atlas-bad); font-weight: 600; }

  .diff-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }
  .diff-table thead th {
    text-align: left;
    font-size: var(--text-micro);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted, var(--atlas-ink-2));
    padding: 4px 6px;
    border-bottom: 1px solid var(--panel-border, var(--atlas-line));
    font-weight: 600;
  }
  .col-status { width: 48px; text-align: center; }
  .col-adds, .col-dels { width: 40px; text-align: right; }

  .row { border-bottom: 1px solid var(--atlas-scrim); }
  .row:last-child { border-bottom: none; }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-micro);
    font-weight: 700;
    width: 22px;
    height: 22px;
    border-radius: var(--radius-sm);
  }
  .badge-added { background: var(--atlas-ok-bg); color: var(--atlas-ok); }
  .badge-deleted { background: var(--atlas-bad-bg); color: var(--atlas-bad); }
  .badge-modified { background: var(--atlas-signal-soft); color: var(--atlas-signal); }

  .file-btn {
    background: none;
    border: none;
    color: var(--text-main, var(--atlas-ink));
    font-size: var(--text-sm);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 0;
    text-align: left;
    width: 100%;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .file-btn:hover { color: var(--accent, var(--atlas-signal)); }
  .chevron {
    color: var(--text-muted, var(--atlas-ink-2));
    font-size: var(--text-micro);
    min-width: 10px;
  }
  .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .diff-block {
    margin: 4px 0 8px 0;
    padding: 8px 10px;
    background: var(--atlas-void);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--text-xs);
    line-height: 1.5;
    border: 1px solid var(--panel-border, var(--atlas-line));
  }
  .diff-block .diff-meta { color: var(--atlas-ink-3); }
  .diff-block .diff-hunk { color: var(--atlas-signal); }
  .diff-block .diff-add { color: var(--atlas-ok); }
  .diff-block .diff-del { color: var(--atlas-bad); }
  .diff-block .diff-ctx { color: var(--text-main, var(--atlas-ink-2)); }
</style>
