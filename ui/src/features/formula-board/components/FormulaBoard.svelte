<script>
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { formulaService } from "../services/formula.service.js";
  import { Modal, Menu } from "../../../shared/components";
  import katex from "katex";

  let { profileId = null } = $props();

  let tree = $state([]);
  let activeSubjectId = $state(null);
  
  let formulas = $state([]);
  let loading = $state(false);

  let activeCategory = $state(""); // Empty means 'All'

  // Modal
  let showModal = $state(false);
  let editingFormula = $state(null);
  
  let formTitle = $state("");
  let formLatex = $state("");
  let formCategory = $state("");

  // Flatten subjects
  const allSubjects = $derived.by(() => {
    const subs = [];
    for (const track of tree) {
      for (const sem of track.semesters) {
        for (const ms of sem.milestones) {
          for (const subj of ms.subjects) {
            subs.push({
              id: subj.id,
              name: subj.name,
              trackName: track.name,
              semesterName: sem.name
            });
          }
        }
      }
    }
    return subs;
  });

  const allCategories = $derived([...new Set(formulas.map(f => f.category).filter(Boolean))]);
  const filteredFormulas = $derived(
    activeCategory ? formulas.filter(f => f.category === activeCategory) : formulas
  );

  async function loadTree() {
    if (profileId == null) {
      tree = [];
      return;
    }
    try {
      tree = await formulaService.getAcademicTree(profileId);
      if (!activeSubjectId && allSubjects.length > 0) {
        activeSubjectId = allSubjects[0].id;
      }
    } catch (e) {
      reportError(e, "Could not load academic tree");
    }
  }

  async function loadFormulas() {
    if (!activeSubjectId) {
      formulas = [];
      return;
    }
    loading = true;
    try {
      formulas = await formulaService.list(profileId, activeSubjectId, null);
    } catch (e) {
      reportError(e, "Could not load formulas");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const pid = profileId;
    loadTree();
  });

  $effect(() => {
    const sid = activeSubjectId;
    loadFormulas();
  });

  $effect(() => {
    const onChanged = () => loadFormulas();
    window.addEventListener("cf:data-changed", onChanged);
    return () => window.removeEventListener("cf:data-changed", onChanged);
  });

  function renderLatex(tex) {
    try {
      return katex.renderToString(tex, { throwOnError: false, displayMode: true });
    } catch (e) {
      return `<span style="color:red">Error rendering LaTeX</span>`;
    }
  }
  
  function renderInlineLatex(tex) {
    try {
      return katex.renderToString(tex, { throwOnError: false, displayMode: false });
    } catch (e) {
      return `<span style="color:red">Error rendering LaTeX</span>`;
    }
  }

  function openModal(f = null) {
    if (!activeSubjectId) {
      toast.error("Please select a subject first");
      return;
    }
    editingFormula = f;
    if (f) {
      formTitle = f.title;
      formLatex = f.latex_content;
      formCategory = f.category || "";
    } else {
      formTitle = "";
      formLatex = "";
      formCategory = activeCategory || "";
    }
    showModal = true;
  }

  function closeModal() {
    showModal = false;
    editingFormula = null;
  }

  async function saveFormula() {
    if (!formTitle.trim() || !formLatex.trim()) {
      toast.error("Title and LaTeX content are required");
      return;
    }
    try {
      if (editingFormula) {
        await formulaService.update(
          profileId,
          editingFormula.id,
          formTitle,
          formLatex,
          formCategory || null
        );
        toast.success("Formula updated");
      } else {
        await formulaService.add(
          profileId,
          activeSubjectId,
          formTitle,
          formLatex,
          formCategory || null
        );
        toast.success("Formula added");
      }
      closeModal();
      loadFormulas();
    } catch (e) {
      reportError(e, "Failed to save formula");
    }
  }

  async function deleteFormula(f) {
    const ok = await confirmDialog({
      title: "Delete formula",
      message: `Delete “${f.title}”? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await formulaService.remove(profileId, f.id);
      toast.success("Formula deleted");
      loadFormulas();
    } catch (e) {
      reportError(e, "Delete failed");
    }
  }

  function formulaMenu(f) {
    return [
      { id: "edit", label: "Edit formula", onselect: () => openModal(f) },
      { id: "sep", separator: true },
      { id: "del", label: "Delete formula", danger: true, onselect: () => deleteFormula(f) },
    ];
  }
</script>

<svelte:head>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
</svelte:head>

<section class="formula-board atl-view">
  <header class="section-head">
    <div class="head-id">
      <h2>Formula Board</h2>
      <p class="standing">{filteredFormulas.length} shown · {allCategories.length} categories</p>
    </div>
    <div class="head-actions">
      <select bind:value={activeSubjectId} class="cf-select subject-select">
        {#if allSubjects.length === 0}
          <option value={null}>No subjects found</option>
        {/if}
        {#each allSubjects as s}
          <option value={s.id}>{s.trackName} › {s.name}</option>
        {/each}
      </select>
      <button class="cf-btn primary" onclick={() => openModal()} disabled={!activeSubjectId}>Add formula</button>
    </div>
  </header>

  {#if formulas.length > 0}
    <div class="categories-bar">
      <button class="cat-pill {activeCategory === '' ? 'active' : ''}" onclick={() => activeCategory = ''}>All</button>
      {#each allCategories as cat}
        <button class="cat-pill {activeCategory === cat ? 'active' : ''}" onclick={() => activeCategory = cat}>{cat}</button>
      {/each}
    </div>

    <div class="formulas-grid">
      {#each filteredFormulas as f}
        <div class="formula-card">
          <div class="fc-header">
            <h4>{f.title}</h4>
            <Menu label="Formula options" items={formulaMenu(f)} />
          </div>
          {#if f.category}
            <span class="fc-cat">{f.category}</span>
          {/if}
          <div class="fc-math">
            {@html renderLatex(f.latex_content)}
          </div>
        </div>
      {/each}
    </div>
  {:else if activeSubjectId && !loading}
    <div class="cf-empty boxed">
      <h3>No formulas yet</h3>
      <p>Save this subject's key equations in LaTeX and they render here.</p>
      <button class="cf-btn" onclick={() => openModal()}>Add the first formula</button>
    </div>
  {/if}
</section>

<!-- Formula Modal -->
<Modal
  open={showModal}
  title={editingFormula ? "Edit formula" : "Add formula"}
  subtitle="LaTeX renders live as you type."
  width={520}
  onClose={closeModal}
>
  {#snippet children()}
    <div class="modal-body">
      <label>
        <span>Title</span>
        <input class="cf-input" type="text" bind:value={formTitle} placeholder="e.g. Quadratic formula" />
      </label>
      <label>
        <span>Category (optional)</span>
        <input class="cf-input" type="text" bind:value={formCategory} placeholder="e.g. Algebra, Calculus" list="cat-list" />
        <datalist id="cat-list">
          {#each allCategories as cat}
            <option value={cat}></option>
          {/each}
        </datalist>
      </label>
      <label>
        <span>LaTeX content</span>
        <textarea class="cf-textarea mono-input" bind:value={formLatex} rows="4" placeholder="E = mc^2"></textarea>
      </label>

      <div class="preview-box">
        <div class="atl-label preview-lbl">Preview</div>
        <div class="preview-math">
          {#if formLatex.trim()}
            {@html renderLatex(formLatex)}
          {:else}
            <span class="muted">Live preview…</span>
          {/if}
        </div>
      </div>

      <div class="form-actions">
        <button class="cf-btn ghost sm" onclick={closeModal}>Cancel</button>
        <button class="cf-btn primary sm" onclick={saveFormula}>{editingFormula ? "Save changes" : "Add formula"}</button>
      </div>
    </div>
  {/snippet}
</Modal>

<style>
  .formula-board { margin-top: 0; }
  .section-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap; }
  .head-id { display: flex; flex-direction: column; gap: 4px; }
  .section-head h2 { margin: 0; font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.01em; color: var(--atlas-ink); }
  .standing { margin: 0; font-size: var(--text-md); color: var(--atlas-ink-3); font-variant-numeric: tabular-nums; }
  .head-actions { display: flex; gap: 12px; align-items: center; }
  .subject-select { max-width: 250px; }

  .categories-bar { display: flex; gap: 8px; flex-wrap: wrap; }
  .cat-pill { background: var(--atlas-raise); color: var(--atlas-ink-3); border: 1px solid var(--atlas-line); border-radius: var(--radius-full); padding: 4px 12px; font-size: var(--text-md); cursor: pointer; transition: all 0.2s; }
  .cat-pill:hover { border-color: var(--atlas-line-2); color: var(--atlas-ink-2); }
  .cat-pill.active { background: var(--atlas-signal-soft); color: var(--atlas-signal); border-color: var(--atlas-signal); font-weight: 550; }

  .formulas-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .formula-card { background: var(--atlas-panel); border: 1px solid var(--atlas-line); border-radius: var(--radius-lg); padding: var(--space-4); display: flex; flex-direction: column; position: relative; }
  .formula-card:hover { border-color: var(--atlas-line-2); }

  .fc-header { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-2); }
  .fc-header h4 { margin: 0 0 4px 0; font-size: var(--text-lg); color: var(--atlas-ink); }

  .fc-cat { font-size: var(--text-xs); color: var(--atlas-ink-3); background: var(--atlas-raise); padding: 2px 8px; border-radius: var(--radius-full); align-self: flex-start; margin-bottom: 12px; font-family: var(--font-mono); letter-spacing: 0.04em; text-transform: uppercase; }

  .fc-math { flex: 1; display: flex; align-items: center; justify-content: center; background: var(--atlas-base); border-radius: var(--radius-md); padding: 16px; margin-top: 12px; overflow-x: auto; }

  /* Modal form */
  .modal-body { display: flex; flex-direction: column; gap: 14px; }
  .modal-body label { display: flex; flex-direction: column; gap: 5px; }
  .modal-body label span { font-size: var(--text-md); color: var(--atlas-ink-2); }
  .mono-input { font-family: var(--font-mono); }

  .preview-box { background: var(--atlas-base); border: 1px solid var(--atlas-line); border-radius: var(--radius-md); padding: 12px; }
  .preview-lbl { margin-bottom: 8px; border-bottom: 1px solid var(--atlas-line); padding-bottom: 4px; }
  .preview-math { min-height: 40px; display: flex; align-items: center; justify-content: center; overflow-x: auto; }
  .muted { color: var(--atlas-ink-3); font-style: italic; }

  .form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }
</style>
