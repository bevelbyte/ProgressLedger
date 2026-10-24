<script>
  // PlanTemplates — saved plan library.
  //
  // Lets the user save the current agent's plan under a name and re-load
  // it later as the starter plan for a new agent run. Columns: name |
  // description | step count | createdAt. Two CTAs:
  //
  //   * "Save current plan as template" — sends the active agent's
  //     plan_json to pmSavePlanTemplate (upsert on name).
  //   * "Load template" — dispatches an event so the parent can apply the
  //     loaded plan to a target agent. The component does NOT mutate
  //     the agent's plan_json directly; that is the agent-loop's job.
  //
  // Read-only otherwise. The main process owns the SQL boundary; the
  // renderer just renders the rows.

  import { projectModeStore } from "../stores/projectMode.svelte.js";
  import { projectModeService } from "../services/projectMode.service.js";

  let { profileId = null, onLoadTemplate = null } = $props();

  let templates = $state([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state(null);

  // Save form state
  let templateName = $state("");
  let templateDescription = $state("");
  let saveOpen = $state(false);

  // Delete confirmation state
  let deleteConfirmId = $state(null);
  let deleting = $state(false);

  $effect(() => {
    if (profileId != null) {
      load();
    } else {
      templates = [];
    }
  });

  async function load() {
    if (profileId == null) {
      templates = [];
      return;
    }
    loading = true;
    error = null;
    try {
      const res = await projectModeService.listPlanTemplates(profileId);
      templates = Array.isArray(res) ? res : [];
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      templates = [];
    } finally {
      loading = false;
    }
  }

  function currentPlanJson() {
    // Mirror how pm_agents.plan_json is persisted — a JSON string. The
    // renderer store carries the parsed shape; we re-serialise using the
    // canonical shape (matching planToJson in plan.js).
    const steps = Array.isArray(projectModeStore.plan) ? projectModeStore.plan : [];
    return JSON.stringify({
      steps: steps.map((s) => ({
        id: s && s.id,
        title: s && s.title,
        status: s && s.status,
        depends_on: Array.isArray(s && s.depends_on) ? s.depends_on : [],
        files: Array.isArray(s && s.files) ? s.files : [],
        assigned_to: s && s.assigned_to == null ? null : s.assigned_to,
      })),
      version: 1,
    });
  }

  async function saveCurrent() {
    if (profileId == null) {
      error = "No profile selected.";
      return;
    }
    const name = templateName.trim();
    if (!name) {
      error = "Template name is required.";
      return;
    }
    saving = true;
    error = null;
    try {
      await projectModeService.savePlanTemplate(
        profileId,
        name,
        templateDescription.trim(),
        currentPlanJson()
      );
      templateName = "";
      templateDescription = "";
      saveOpen = false;
      await load();
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function loadTemplate(row) {
    if (profileId == null || !row) return;
    try {
      const result = await projectModeService.loadPlanTemplate(
        profileId,
        row.id,
        null
      );
      // Native template rows are camelCase (`planJson`); fixtures use the Rust
      // name. Reading only `plan_json` made this guard return early for every
      // REAL template, so "load" silently did nothing (D13).
      const planJson = result && (result.planJson ?? result.plan_json);
      if (!result || result.ok === false || !planJson) return;
      if (typeof onLoadTemplate === "function") {
        onLoadTemplate({
          id: result.id,
          name: result.name,
          planJson,
        });
      }
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
  }

  function fmtDate(iso) {
    const ts = Date.parse(iso);
    if (!ts || isNaN(ts)) return iso || "—";
    const d = new Date(ts);
    return d.toISOString().replace("T", " ").slice(0, 16);
  }

  function requestDelete(row) {
    deleteConfirmId = row.id;
  }

  function cancelDelete() {
    deleteConfirmId = null;
  }

  async function confirmDelete(row) {
    if (profileId == null || !row) return;
    deleting = true;
    error = null;
    try {
      const result = await projectModeService.deletePlanTemplate(profileId, row.id);
      if (result && result.ok === false) {
        error = result.reason || result.error || "Failed to delete template";
        deleteConfirmId = null;
        return;
      }
      deleteConfirmId = null;
      await load();
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      deleteConfirmId = null;
    } finally {
      deleting = false;
    }
  }
</script>

<section class="templates" data-testid="plan-templates">
  <header class="templates-header">
    <h3>Plan templates</h3>
    <div class="controls">
      <button
        type="button"
        class="refresh-btn"
        data-testid="plan-templates-refresh"
        onclick={load}
        disabled={loading || profileId == null}
      >{loading ? "Refreshing…" : "Refresh"}</button>
      <button
        type="button"
        class="save-btn"
        data-testid="plan-templates-toggle-save"
        onclick={() => (saveOpen = !saveOpen)}
        disabled={profileId == null}
      >{saveOpen ? "Cancel" : "Save current plan as template"}</button>
    </div>
  </header>

  {#if error}
    <p class="error" role="alert" data-testid="plan-templates-error">{error}</p>
  {/if}

  {#if saveOpen}
    <div class="save-form" data-testid="plan-templates-save-form">
      <label class="field">
        <span>Name</span>
        <input
          type="text"
          maxlength="200"
          bind:value={templateName}
          data-testid="plan-templates-name"
          placeholder="e.g. Triage & Investigation"
          disabled={saving}
        />
      </label>
      <label class="field">
        <span>Description (optional)</span>
        <textarea
          rows="2"
          maxlength="1000"
          bind:value={templateDescription}
          data-testid="plan-templates-description"
          disabled={saving}
        ></textarea>
      </label>
      <div class="form-actions">
        <button
          type="button"
          class="primary"
          onclick={saveCurrent}
          disabled={saving || !templateName.trim()}
          data-testid="plan-templates-save"
        >{saving ? "Saving…" : "Save template"}</button>
      </div>
    </div>
  {/if}

  {#if loading && templates.length === 0}
    <p class="loading" data-testid="plan-templates-loading">Loading templates…</p>
  {:else if templates.length === 0}
    <p class="empty" data-testid="plan-templates-empty">
      No saved templates yet. Save the current plan as a template to reuse its structure across runs.
    </p>
  {:else}
    <table class="templates-table" data-testid="plan-templates-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Description</th>
          <th>Steps</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each templates as t (t.id)}
          <tr data-testid={`plan-templates-row-${t.id}`}>
            <td class="name" data-testid={`plan-templates-name-${t.id}`}>{t.name}</td>
            <td class="desc" data-testid={`plan-templates-desc-${t.id}`}>{t.description || ""}</td>
            <td class="count" data-testid={`plan-templates-count-${t.id}`}>{t.stepCount ?? t.step_count}</td>
            <td class="date" data-testid={`plan-templates-date-${t.id}`}>{fmtDate(t.createdAt ?? t.created_at)}</td>
            <td class="actions">
              {#if deleteConfirmId === t.id}
                <span class="delete-confirm">
                  <button
                    type="button"
                    class="confirm-yes"
                    data-testid={`plan-templates-delete-confirm-${t.id}`}
                    onclick={() => confirmDelete(t)}
                    disabled={deleting}
                  >{deleting ? "…" : "Yes"}</button>
                  <button
                    type="button"
                    class="confirm-no"
                    data-testid={`plan-templates-delete-cancel-${t.id}`}
                    onclick={cancelDelete}
                    disabled={deleting}
                  >No</button>
                </span>
              {:else}
                <button
                  type="button"
                  class="load-btn"
                  data-testid={`plan-templates-load-${t.id}`}
                  onclick={() => loadTemplate(t)}
                  disabled={profileId == null}
                >Load template</button>
                <button
                  type="button"
                  class="delete-btn"
                  data-testid={`plan-templates-delete-${t.id}`}
                  onclick={() => requestDelete(t)}
                  disabled={profileId == null}
                >Delete</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .templates {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface, var(--atlas-panel));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-md);
    padding: 10px 12px;
    color: var(--text-main, var(--atlas-ink));
  }
  .templates-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .templates-header h3 {
    margin: 0;
    font-size: var(--text-lg);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted, var(--atlas-ink-2));
  }
  .controls { display: flex; align-items: center; gap: 8px; }
  .refresh-btn, .save-btn {
    background: var(--accent, var(--atlas-signal));
    color: var(--bg-main, var(--atlas-void));
    border: none;
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .save-btn { background: var(--surface, var(--atlas-panel)); color: var(--text-main); border: 1px solid var(--border); }
  .refresh-btn:disabled, .save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .refresh-btn:hover:not(:disabled), .save-btn:hover:not(:disabled) { opacity: 0.85; }
  .save-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--bg-main, var(--atlas-void));
    border: 1px solid var(--border, var(--atlas-line));
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-sm); color: var(--text-muted); }
  .field input, .field textarea {
    background: var(--surface, var(--atlas-panel));
    color: var(--text-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    font-family: inherit;
    font-size: var(--text-md);
    resize: vertical;
  }
  .form-actions { display: flex; justify-content: flex-end; }
  .primary {
    background: var(--accent, var(--atlas-signal));
    color: var(--bg-main, var(--atlas-void));
    border: none;
    border-radius: var(--radius-sm);
    padding: 4px 12px;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .loading, .empty, .error { font-size: var(--text-md); padding: 4px 4px 4px 8px; }
  .error { color: var(--atlas-bad); }
  .empty { color: var(--text-muted, var(--atlas-ink-2)); font-style: italic; }
  .templates-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }
  .templates-table th, .templates-table td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border, var(--atlas-line));
    vertical-align: top;
  }
  .templates-table th {
    color: var(--text-muted, var(--atlas-ink-2));
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .templates-table .name { font-weight: 600; color: var(--text-main); }
  .templates-table .desc { color: var(--text-muted); max-width: 260px; word-break: break-word; }
  .templates-table .count { font-family: var(--mono, monospace); }
  .templates-table .date { font-family: var(--mono, monospace); color: var(--text-muted); font-size: var(--text-sm); }
  .load-btn {
    background: var(--accent, var(--atlas-signal));
    color: var(--bg-main, var(--atlas-void));
    border: none;
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .load-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .load-btn:hover:not(:disabled) { opacity: 0.85; }
  .delete-btn {
    background: transparent;
    color: var(--atlas-bad);
    border: 1px solid var(--atlas-bad);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    margin-left: 4px;
  }
  .delete-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .delete-btn:hover:not(:disabled) { background: var(--atlas-bad); color: var(--atlas-on-fill); }
  .delete-confirm {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .confirm-yes {
    background: var(--atlas-bad);
    color: var(--atlas-on-fill);
    border: none;
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .confirm-no {
    background: transparent;
    color: var(--text-muted, var(--atlas-ink-2));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-size: var(--text-sm);
    cursor: pointer;
  }
</style>