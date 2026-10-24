<script>
  // ChangedFilesPanel — per-run list of the files the agent has written to
  // the working tree, with action, mtime, and +N/-M line counts.
  //
  // Why this exists: ProjectDiff renders the working-tree diff, but it is a
  // snapshot view — it answers "what differs from HEAD" and nothing else.
  // This panel answers "which files did the agent touch, and in what order",
  // which is what a reviewer wants mid-run. It is the read-mostly companion
  // to ProjectDiff and deliberately shares its visual language so the two
  // panels read as a pair.
  //
  // Data sources (NO new IPC channels — see the task constraints):
  //   1. window.careerflow.diff.workingTree(profileId, agentId)
  //      → { ok, result: { diff, truncated } }
  //      We run `git diff` through the existing shell_git_diff tool and
  //      parse the `diff --git` sections. That gives us the file list,
  //      the action (created / modified / deleted), and the +N/-M counts.
  //   2. window.careerflow.projectIntel.list(profileId, projectId)
  //      → { ok, result: { entries: [{ path, size, mtime, language }] } }
  //      Best-effort mtime lookup for the "written at" column. The file
  //      index is populated when the project is indexed, so this column
  //      shows "—" until a matching entry exists. We never block on it:
  //      an empty index just means no timestamps, never an empty file list.
  //
  // Deliberately NOT used: the file-reservations store. It is a write-time
  // lock manager whose rows are released in a `finally` block on every
  // fs_write, so by the time the UI polls it only holds in-flight writers.
  // It also has no IPC surface for the renderer, and adding one is out of
  // scope. The git working tree is the durable history the reservations
  // module was protecting in the first place.

  import { ChevronDown, ChevronRight } from "lucide-svelte";

  let {
    profileId = null,
    projectId = null,
    agentId = null,
    refreshIntervalMs = 0,
    maxIndexedFiles = 2000,
  } = $props();

  let rows = $state([]);
  let truncated = $state(false);
  let loading = $state(false);
  let error = $state(null);
  let filter = $state("all"); // "all" | "created" | "modified" | "deleted"
  let expanded = $state(null); // path of the row whose preview is open
  let mtimeMissing = $state(false);

  // ---- indexing (added: the panel's own hint used to be unfulfillable) ------
  //
  // WHY THIS EXISTS
  //   This panel has always rendered:
  //     "Times come from the file index; re-index to timestamp every row."
  //   ...with no control anywhere to re-index. The index is built by
  //   `project:intel:index` -> ProjectIntel.indexProject, and the preload
  //   already exposes it as `projectIntel.index(profileId, projectId, mode)`,
  //   but no renderer surface ever called it. So in the running app the index
  //   was never built, the "written at" column was permanently "—", and the
  //   panel instructed the user to perform an action that did not exist.
  //   Recorded as P-1 in CAPABILITY-MATRIX.md.
  //
  //   This is the same defect class as the dormant Hooks surface: a UI that
  //   promises a capability it cannot reach. Here the fix is to make the
  //   promise true rather than to delete the sentence, because indexing IS a
  //   supported product action and the main-process path is already complete
  //   and ownership-checked.
  //
  // SECURITY — unchanged, deliberately
  //   The renderer supplies only {profileId, projectId, mode}. It CANNOT supply
  //   a root: `resolveProjectIntelContext` resolves the authorized root in the
  //   main process from the project's stored trusted root, and both
  //   indexProject and reindexDelta re-validate that root before walking
  //   anything. `shell/tests/project-intel-ownership.test.js` pins that the
  //   preload must not let a rootPath through this channel. So adding a button
  //   here adds no filesystem authority whatsoever.
  //
  // NO NEW IPC CHANNEL
  //   The panel's original constraint was "no new IPC channels"; this adds
  //   none. It calls the channel that already existed and was already exposed.
  let indexing = $state(false);
  let indexError = $state(null);
  let indexedAt = $state(null);

  async function runIndex() {
    if (indexing) return;
    if (profileId == null || projectId == null) {
      indexError = "Open a project first — indexing needs a project.";
      return;
    }
    if (!window.careerflow.projectIntel || !window.careerflow.projectIntel.index) {
      indexError = "Indexing is not available in this build.";
      return;
    }
    indexing = true;
    indexError = null;
    try {
      const res = await window.careerflow.projectIntel.index(profileId, projectId, "full");
      // A failure must STAY a failure. Reporting success here when the main
      // process refused (ownership, root-mismatch, walk error) would put the
      // panel back into exactly the dishonest state this control exists to end.
      if (!res || res.ok !== true) {
        const code = res && res.error && res.error.code;
        const msg = (res && res.error && res.error.message) || "Indexing failed.";
        indexError = code ? `${code}: ${msg}` : msg;
        return;
      }
      indexedAt = new Date().toISOString();
      // Re-read so the freshly built index populates the timestamps the user
      // was just told to expect.
      await refresh();
    } catch (e) {
      indexError = (e && e.message) || String(e);
    } finally {
      indexing = false;
    }
  }


  // ---- diff parsing -------------------------------------------------------
  // Same shape as ProjectDiff's parser, kept local so the commit stays to
  // the three files this task owns. Status is derived from the /dev/null
  // sentinels, which are how `git diff` marks new and deleted files.

  function parseChanged(diffText) {
    if (!diffText) return { rows: [], truncated: false };
    const lines = diffText.split("\n");
    const out = [];
    let cur = null;
    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        if (cur) out.push(cur);
        const rest = line.slice("diff --git ".length);
        // git diff --git <a-path> <b-path>   (may be "/dev/null" on a side)
        const parts = rest.split(" ");
        const aPath = parts[0] || "";
        const bPath = parts[1] || "";
        const file = relativeFromPrefix(bPath) || relativeFromPrefix(aPath) || rest;
        cur = { path: file, lines: [], adds: 0, dels: 0, created: false, deleted: false };
      } else if (cur) {
        cur.lines.push(line);
        if (line.startsWith("--- /dev/null") || line === "--- /dev/null") cur.created = true;
        if (line.startsWith("+++ /dev/null") || line === "+++ /dev/null") cur.deleted = true;
        if (line.startsWith("+") && !line.startsWith("+++")) cur.adds += 1;
        if (line.startsWith("-") && !line.startsWith("---")) cur.dels += 1;
      }
    }
    if (cur) out.push(cur);
    return { rows: out, truncated: false };
  }

  function relativeFromPrefix(p) {
    if (!p) return "";
    if (p === "/dev/null") return "";
    if (p.startsWith("a/")) return p.slice(2);
    if (p.startsWith("b/")) return p.slice(2);
    return p;
  }

  function actionOf(row) {
    if (row.created) return "created";
    if (row.deleted) return "deleted";
    return "modified";
  }

  function actionLabel(a) {
    if (a === "created") return "C";
    if (a === "deleted") return "D";
    return "M";
  }

  function actionClass(a) {
    if (a === "created") return "badge-created";
    if (a === "deleted") return "badge-deleted";
    return "badge-modified";
  }

  function actionText(a) {
    if (a === "created") return "created";
    if (a === "deleted") return "deleted";
    return "modified";
  }

  // project-intel stores Math.floor(st.mtimeMs), so mtime is whole
  // MILLISECONDS. We still tolerate a seconds-scale value (some callers
  // hand this in pre-floor) and UTC-format the output so the panel is
  // diffable in screenshots and stable under CI.
  function formatTime(mtime) {
    if (typeof mtime !== "number" || !isFinite(mtime) || mtime <= 0) return "—";
    const ms = mtime < 1e12 ? mtime * 1000 : mtime;
    return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  }

  function buildRows(parsed, index) {
    const missing = new Set();
    const merged = parsed.rows.map((r) => {
      const hit = index.get(r.path);
      const action = actionOf(r);
      if (!hit) missing.add(r.path);
      return {
        path: r.path,
        action,
        mtime: hit ? hit.mtime : null,
        adds: r.adds,
        dels: r.dels,
        lines: r.lines,
      };
    });
    return { rows: merged, missingCount: missing.size };
  }

  function filteredRows() {
    if (filter === "all") return rows;
    return rows.filter((r) => r.action === filter);
  }

  function lineClass(line) {
    if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
    if (line.startsWith("+")) return "diff-add";
    if (line.startsWith("-")) return "diff-del";
    if (line.startsWith("@@")) return "diff-hunk";
    return "diff-ctx";
  }

  function toggle(path) {
    expanded = expanded === path ? null : path;
  }

  async function refresh() {
    if (profileId == null || agentId == null) return;
    loading = true;
    error = null;
    try {
      // Both lookups are independent; race them so a slow index never
      // delays the file list, and a missing index never hides it.
      const diffPromise = window.careerflow.diff
        ? window.careerflow.diff.workingTree(profileId, agentId).catch((e) => ({
            ok: false,
            error: { message: (e && e.message) || "diff failed" },
          }))
        : Promise.resolve({ ok: false, error: { message: "diff API unavailable" } });

      let indexPromise = Promise.resolve({ ok: true, result: { entries: [] } });
      if (projectId != null && window.careerflow.projectIntel && window.careerflow.projectIntel.list) {
        indexPromise = window.careerflow.projectIntel
          .list(profileId, projectId, { max: maxIndexedFiles })
          // An index lookup that FAILS must stay a failure. The old
          // `.catch(() => ({ ok: true, result: { entries: [] } }))` rewrote an
          // ownership rejection, a `root-mismatch` or a thrown IPC error into
          // a successful empty result, which is indistinguishable from "this
          // project genuinely has no index" — and `mtimeMissing` is then
          // derived from it, so the panel CLAIMED the metadata was present
          // when the lookup had actually failed. The diff result is still the
          // authority for the panel's success/failure; the index is advisory,
          // so a failure here degrades to "no index", but it is recorded as a
          // failure so nothing downstream can mistake it for a populated one.
          .catch((e) => ({ ok: false, error: { message: String((e && e.message) || e) }, result: { entries: [] } }));
      }

      const [diffRes, indexRes] = await Promise.all([diffPromise, indexPromise]);

      if (!diffRes || !diffRes.ok) {
        error = (diffRes && diffRes.error && diffRes.error.message) || "Couldn't load changed files";
        rows = [];
        mtimeMissing = false;
        return;
      }

      const parsed = parseChanged(diffRes.result.diff || "");
      truncated = !!diffRes.result.truncated;

      const index = new Map();
      // The index is advisory — the diff is the authority for this panel — so
      // a failed lookup degrades to "no index" rather than failing the panel.
      // But it must degrade to a state the user can SEE is degraded, so
      // `mtimeMissing` reports the truth instead of claiming the metadata is
      // present because the lookup silently returned nothing.
      const indexAvailable = !!(indexRes && indexRes.ok);
      const entries = (indexRes && indexRes.result && indexRes.result.entries) || [];
      for (const e of entries) {
        if (e && typeof e.path === "string") index.set(e.path, e);
      }
      const built = buildRows(parsed, index);
      rows = built.rows;
      // When the index lookup failed outright, EVERY row is missing its
      // metadata — not just the ones the (empty) index failed to cover. The
      // old code computed this from an empty index and reported "nothing is
      // missing", i.e. the opposite of the truth.
      mtimeMissing = indexAvailable ? built.missingCount > 0 : built.rows.length > 0;
      expanded = null;
    } catch (e) {
      error = (e && e.message) || "Unknown error";
      rows = [];
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

<section class="changed-files" aria-label="Files changed this run" data-testid="changed-files-panel">
  <header class="head">
    <h3>Changed Files</h3>
    <div class="head-actions">
      <div class="filter-group" role="group" aria-label="Filter by action">
        {#each ["all", "created", "modified", "deleted"] as f}
          <button
            class="filter-btn {filter === f ? "active" : ""}"
            type="button"
            onclick={() => filter = f}
            aria-pressed={filter === f}
            data-testid="filter-{f}"
          >
            {f === "all" ? "All" : actionLabel(f)}
          </button>
        {/each}
      </div>
      <button class="refresh" type="button" onclick={refresh} disabled={loading} data-testid="changed-files-refresh">
        {loading ? "loading…" : "Refresh"}
      </button>
      <button
        class="index-btn"
        type="button"
        onclick={runIndex}
        disabled={indexing || projectId == null}
        title="Build the file index for this project so changed rows can show their timestamps"
        data-testid="changed-files-index"
      >
        {indexing ? "indexing…" : "Index project"}
      </button>
    </div>
  </header>

  {#if indexError}
    <p class="err-msg" data-testid="changed-files-index-error">{indexError}</p>
  {/if}
  {#if indexedAt && !indexError}
    <p class="muted" data-testid="changed-files-indexed">Project indexed.</p>
  {/if}

  {#if error}
    <p class="err-msg" data-testid="changed-files-error">{error}</p>
  {:else if !rows.length}
    <p class="muted" data-testid="changed-files-empty">{loading ? "Loading…" : "No files written this run."}</p>
  {:else}
    {#if truncated}
      <p class="muted truncated">Diff was truncated; raise maxBytes to see more.</p>
    {/if}
    {#if mtimeMissing}
      <p class="muted hint" data-testid="changed-files-mtime-hint">Times come from the file index; use “Index project” to timestamp every row.</p>
    {/if}
    <div class="summary-count">
      {rows.length} file{rows.length !== 1 ? "s" : ""} changed
      {#if rows.reduce((s, r) => s + r.adds, 0) > 0}
        , <span class="add-count">+{rows.reduce((s, r) => s + r.adds, 0)}</span>
      {/if}
      {#if rows.reduce((s, r) => s + r.dels, 0) > 0}
        , <span class="del-count">−{rows.reduce((s, r) => s + r.dels, 0)}</span>
      {/if}
    </div>
    <table class="changed-table">
      <thead>
        <tr>
          <th class="col-action">Action</th>
          <th class="col-file">File</th>
          <th class="col-time">Written at (UTC)</th>
          <th class="col-counts">Lines</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredRows() as row (row.path)}
          <tr class="row" data-testid="changed-file-row" data-path={row.path}>
            <td class="col-action">
              <span class="badge {actionClass(row.action)}" title={actionText(row.action)}>
                {actionLabel(row.action)}
              </span>
            </td>
            <td class="col-file">
              <button
                class="file-btn {expanded === row.path ? "open" : ""}"
                type="button"
                onclick={() => toggle(row.path)}
                data-testid="changed-file-btn"
              >
                <span class="chevron" aria-hidden="true">
                {#if expanded === row.path}
                  <ChevronDown size={13} strokeWidth={2} />
                {:else}
                  <ChevronRight size={13} strokeWidth={2} />
                {/if}
              </span>
                <span class="file-name">{row.path}</span>
              </button>
            </td>
            <td class="col-time">{formatTime(row.mtime)}</td>
            <td class="col-counts">
              <span class="add-count">+{row.adds}</span>
              <span class="del-count">−{row.dels}</span>
            </td>
          </tr>
          {#if expanded === row.path}
            <tr class="preview-row">
              <td colspan="4">
                <pre class="diff-block" data-testid="changed-file-preview">
{#each row.lines as line, i (i)}<span class={lineClass(line)}>{line}</span>{"\n"}{/each}</pre>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .changed-files {
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
  /* The indexing control. Same visual language as .refresh so the header reads
     as one group, but it is the panel's only state-changing action, so it is
     styled to be distinguishable rather than identical. */
  .index-btn {
    background: var(--surface-2, var(--atlas-panel));
    color: var(--text-main, var(--atlas-ink));
    border: 1px solid var(--panel-border, var(--atlas-line));
    border-radius: var(--radius-sm);
    padding: 3px 10px;
    font-size: var(--text-xs);
    cursor: pointer;
    font-weight: 600;
  }
  .index-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .refresh:disabled { opacity: 0.5; cursor: default; }
  .muted { color: var(--text-muted, var(--atlas-ink-2)); font-size: var(--text-sm); margin: 0; }
  .hint { font-size: var(--text-xs); margin-top: 2px; }
  .truncated { color: var(--atlas-warn); }
  .err-msg { color: var(--color-danger, var(--atlas-bad)); font-size: var(--text-sm); }
  .summary-count {
    font-size: var(--text-xs);
    color: var(--text-muted, var(--atlas-ink-2));
    margin-bottom: 8px;
  }
  .add-count { color: var(--atlas-ok); font-weight: 600; }
  .del-count { color: var(--atlas-bad); font-weight: 600; }

  .changed-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }
  .changed-table thead th {
    text-align: left;
    font-size: var(--text-micro);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted, var(--atlas-ink-2));
    padding: 4px 6px;
    border-bottom: 1px solid var(--panel-border, var(--atlas-line));
    font-weight: 600;
  }
  .col-action { width: 52px; text-align: center; }
  .col-time {
    width: 150px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--text-xs);
    white-space: nowrap;
  }
  .col-counts { width: 82px; text-align: right; white-space: nowrap; }

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
  .badge-created { background: var(--atlas-ok-bg); color: var(--atlas-ok); }
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
  .file-btn:hover, .file-btn.open { color: var(--accent, var(--atlas-signal)); }
  .chevron {
    color: var(--text-muted, var(--atlas-ink-2));
    font-size: var(--text-micro);
    min-width: 10px;
  }
  .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .preview-row td { padding: 0 6px 6px 6px; }
  .diff-block {
    margin: 0;
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
