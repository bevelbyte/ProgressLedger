<script>
  // SkillInventory — browse the agent's installed Skills, preview them, and
  // enable/disable them for the active profile.
  //
  // Skills are bundles of system-prompt fragments the agent opts into
  // (see shell/src/services/skills/). The Skills registry lives in the main
  // process; the renderer only sees the metadata exposed via
  // `careerflow.extensions.listSkills()`, the raw SKILL.md text via
  // `careerflow.extensions.previewSkill(id)`, and the enable toggle via
  // `careerflow.extensions.setSkillEnabled(...)`.
  //
  // The enable toggle used to have NO caller anywhere in the renderer, which
  // made `skills:set-enabled` — the only state-mutating Skills channel, and the
  // one that actually changes what the agent is told — unreachable from the
  // product. It is wired here, scoped to the active profile and project exactly
  // like every other project-mode panel, so the ownership gate in
  // `shell/src/security/skills-auth.js` is the thing that decides.
  //
  // Columns: id | name | triggers (chips) | scope (project/global) | description | enabled
  // Click a row to expand the SKILL.md preview below the table. A search
  // input filters across id/name/description/triggers.

  import { onMount as svelteOnMount } from "svelte";
  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null, projectId = null } = $props();

  let skills = $state([]); // { id, name, description, triggers, scope, project, global, project_id }
  let loading = $state(false);
  let loadFailed = $state(false);
  let loadError = $state("");
  let enabledIds = $state([]);   // ids enabled for (profileId, projectId)
  let busyId = $state(null);     // id whose toggle is in flight
  let toggleError = $state("");

  let search = $state("");
  let expandedId = $state(null); // currently expanded skill id (or null)
  let previewText = $state("");   // last preview content
  let previewLoading = $state(false);
  let previewError = $state("");

  function extensionsApi() {
    const w = typeof window !== "undefined" ? window : undefined;
    const ns = w && w.careerflow && w.careerflow.extensions;
    return ns &&
      typeof ns.listSkills === "function" &&
      typeof ns.previewSkill === "function"
      ? ns
      : null;
  }

  // Enabling needs a real profile: the shell refuses without one, and a
  // project-scoped skill additionally needs the project.
  const canToggle = $derived(
    typeof profileId === "number" && profileId >= 1 &&
      typeof extensionsApi()?.setSkillEnabled === "function",
  );

  async function load() {
    const api = extensionsApi();
    if (!api) {
      loadFailed = true;
      loadError = "Skills are not available in this build.";
      return;
    }
    loading = true;
    try {
      const res = await api.listSkills();
      if (res && res.ok && Array.isArray(res.skills)) {
        skills = res.skills;
        loadFailed = false;
        loadError = "";
      } else {
        loadFailed = true;
        loadError = (res && res.reason) || (res && res.error && res.error.code) || "Could not load skills.";
        skills = [];
      }
    } catch (e) {
      loadFailed = true;
      reportError(e, "Could not load skills");
      loadError = "Could not load skills.";
      skills = [];
    } finally {
      loading = false;
    }
  }

  /**
   * Toggle a skill and reflect the RESULT, never the optimism: the shell
   * enforces ownership and scope, so a refusal must leave the row off.
   */
  async function toggleEnabled(skill) {
    const api = extensionsApi();
    if (!api || typeof api.setSkillEnabled !== "function") return;
    if (typeof profileId !== "number" || profileId < 1) {
      toggleError = "Select a profile before enabling a skill.";
      return;
    }
    const next = !enabledIds.includes(skill.id);
    busyId = skill.id;
    toggleError = "";
    try {
      const res = await api.setSkillEnabled(
        skill.id,
        profileId,
        typeof projectId === "number" ? projectId : null,
        next,
      );
      if (res && res.ok) {
        enabledIds = next
          ? [...enabledIds, skill.id]
          : enabledIds.filter((id) => id !== skill.id);
      } else {
        toggleError =
          (res && res.reason) ||
          (res && res.error && res.error.code) ||
          "Could not change this skill.";
      }
    } catch (e) {
      reportError(e, "Could not change this skill");
      toggleError = "Could not change this skill.";
    } finally {
      busyId = null;
    }
  }

  // Pure filter; safe to derive in render because the inputs are tiny
  // (typically <50 skills) and `search` only changes on keystroke.
  function filtered(list, q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((s) => {
      if ((s.id || "").toLowerCase().includes(needle)) return true;
      if ((s.name || "").toLowerCase().includes(needle)) return true;
      if ((s.description || "").toLowerCase().includes(needle)) return true;
      const triggers = Array.isArray(s.triggers) ? s.triggers : [];
      for (const t of triggers) {
        if (String(t).toLowerCase().includes(needle)) return true;
      }
      return false;
    });
  }

  let visible = $derived(filtered(skills, search));

  async function toggleRow(id) {
    if (expandedId === id) {
      expandedId = null;
      previewText = "";
      previewError = "";
      return;
    }
    expandedId = id;
    previewText = "";
    previewError = "";
    const api = extensionsApi();
    if (!api) {
      previewError = "Skills preview is not available in this build.";
      return;
    }
    previewLoading = true;
    try {
      const res = await api.previewSkill(id);
      if (res && res.ok && typeof res.content === "string") {
        previewText = res.content;
      } else {
        previewError = (res && res.reason) || "Could not read SKILL.md.";
      }
    } catch (e) {
      reportError(e, "Could not read SKILL.md");
      previewError = "Could not read SKILL.md.";
    } finally {
      previewLoading = false;
    }
  }

  function scopeLabel(s) {
    if (s && s.project) return "project";
    if (s && s.global) return "global";
    return "unknown";
  }

  svelteOnMount(() => {
    load();
  });
</script>

<section class="skill-inventory" data-testid="skill-inventory">
  <header class="panel-header">
    <h3>Skill inventory</h3>
    <div class="header-controls">
      <input
        type="search"
        class="search-input"
        placeholder="Search id, name, description, trigger…"
        bind:value={search}
        data-testid="skill-inventory-search"
        aria-label="Search skills"
      />
      <button
        type="button"
        class="refresh-btn"
        data-testid="skill-inventory-refresh"
        onclick={load}
        disabled={loading}
      >
        {loading ? "Loading…" : "Refresh"}
      </button>
    </div>
  </header>

  {#if loadFailed}
    <p class="note err" data-testid="skill-inventory-load-error">{loadError}</p>
  {/if}
  {#if toggleError}
    <p class="note err" data-testid="skill-inventory-toggle-error">{toggleError}</p>
  {/if}

  <div class="table-wrap" data-testid="skill-inventory-table-wrap">
    <table class="skill-table" data-testid="skill-inventory-table">
      <thead>
        <tr>
          <th scope="col">ID</th>
          <th scope="col">Name</th>
          <th scope="col">Triggers</th>
          <th scope="col">Scope</th>
          <th scope="col">Description</th>
          <th scope="col">Agent</th>
        </tr>
      </thead>
      <tbody>
        {#if visible.length === 0}
          <tr data-testid="skill-inventory-empty">
            <td colspan="6" class="empty-cell">
              {skills.length === 0
                ? "No skills installed."
                : "No skills match the current search."}
            </td>
          </tr>
        {:else}
          {#each visible as s (s.id)}
            {@const isEnabled = enabledIds.includes(s.id)}
            <tr
              class="skill-row"
              class:expanded={expandedId === s.id}
              data-testid="skill-row"
              data-skill-id={s.id}
              data-skill-scope={scopeLabel(s)}
              data-skill-enabled={isEnabled ? "true" : "false"}
              onclick={() => toggleRow(s.id)}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleRow(s.id);
                }
              }}
              tabindex="0"
              role="button"
              aria-expanded={expandedId === s.id}
            >
              <td class="cell-id">{s.id}</td>
              <td class="cell-name">{s.name || s.id}</td>
              <td class="cell-triggers">
                {#if Array.isArray(s.triggers) && s.triggers.length > 0}
                  {#each s.triggers as trig (trig)}
                    <span class="trigger-chip" data-testid="skill-trigger">{trig}</span>
                  {/each}
                {:else}
                  <span class="muted">—</span>
                {/if}
              </td>
              <td class="cell-scope" data-scope={scopeLabel(s)}>
                <span class="scope-pill" data-testid="skill-scope">{scopeLabel(s)}</span>
                {#if scopeLabel(s) === "project" && typeof s.project_id === "number"}
                  <span class="project-id" data-testid="skill-project-id">#{s.project_id}</span>
                {/if}
              </td>
              <td class="cell-desc">{s.description || ""}</td>
              <td class="cell-enabled">
                {#if canToggle}
                  <button
                    type="button"
                    class="enable-btn"
                  class:on={isEnabled}
                    data-testid="skill-enable-toggle"
                    aria-pressed={isEnabled}
                    disabled={busyId === s.id}
                    onclick={(e) => { e.stopPropagation(); toggleEnabled(s); }}
                  >
                    {busyId === s.id ? "…" : isEnabled ? "Enabled" : "Enable"}
                  </button>
                {:else}
                  <span class="muted" data-testid="skill-enable-unavailable">—</span>
                {/if}
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  {#if expandedId}
    <div class="preview" data-testid="skill-preview" data-skill-id={expandedId}>
      <header class="preview-head">
        <strong>SKILL.md — {expandedId}</strong>
        <button
          type="button"
          class="close-btn"
          data-testid="skill-preview-close"
          onclick={() => toggleRow(expandedId)}
          aria-label="Close preview"
        >
          Close
        </button>
      </header>
      {#if previewLoading}
        <p class="note" data-testid="skill-preview-loading">Loading…</p>
      {:else if previewError}
        <p class="note err" data-testid="skill-preview-error">{previewError}</p>
      {:else}
        <pre class="preview-body" data-testid="skill-preview-body">{previewText}</pre>
      {/if}
    </div>
  {/if}
</section>

<style>
  .skill-inventory {
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
    flex-wrap: wrap;
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
  .search-input {
    background: var(--bg-main);
    color: var(--text-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font-family: inherit;
    font-size: var(--text-md);
    min-width: 220px;
  }
  .search-input:focus { outline: 1px solid var(--accent); }
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
  .skill-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-md);
  }
  .skill-table th,
  .skill-table td {
    padding: 8px 10px;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--border);
  }
  .skill-table th {
    background: var(--surface);
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--text-sm);
  }
  .skill-table tbody tr:last-child td { border-bottom: none; }
  .skill-row {
    cursor: pointer;
    background: var(--bg-main);
    transition: background var(--trans-fast, 120ms ease);
  }
  .skill-row:hover { background: var(--surface); }
  .skill-row:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
  .skill-row.expanded { background: var(--surface); }
  .cell-id { font-family: var(--mono, monospace); color: var(--text-secondary); }
  .cell-name { font-weight: 600; color: var(--text-main); }
  .cell-triggers {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-width: 220px;
  }
  .trigger-chip {
    font-size: var(--text-sm);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: var(--surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .muted { color: var(--text-muted); }
  .cell-scope {
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .scope-pill {
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    color: var(--text-muted);
  }
  .cell-scope[data-scope="global"] .scope-pill {
    color: var(--accent, var(--atlas-ok));
    border-color: var(--accent, var(--atlas-ok));
  }
  .cell-scope[data-scope="project"] .scope-pill {
    color: var(--atlas-warn);
    border-color: var(--atlas-warn);
  }
  .project-id {
    font-family: var(--mono, monospace);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .cell-desc {
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .cell-enabled { white-space: nowrap; }
  .enable-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    padding: 2px 10px;
    cursor: pointer;
    font-size: var(--text-sm);
  }
  .enable-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--text-main); }
  .enable-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .enable-btn.on {
    color: var(--accent, var(--atlas-ok));
    border-color: var(--accent, var(--atlas-ok));
  }
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
    margin: 0;
    padding: 8px 10px;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: var(--mono, monospace);
    font-size: var(--text-sm);
    color: var(--text-main);
    white-space: pre-wrap;
    overflow-x: auto;
    max-height: 320px;
  }
</style>