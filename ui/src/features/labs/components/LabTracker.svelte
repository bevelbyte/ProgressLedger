<script>
  // Labs — practical records and vivas, per subject.
  //
  // Was: a `<select>` picker in the header (a picker pretending to be a filter),
  // two summary tiles with progress bars, a nested bordered table, a hand-rolled
  // modal duplicated from the Projects feature, `✎` glyph buttons, and a
  // `confirmDialog` call passing two strings where the primitive takes one
  // options object — so the destructive prompt lost its title and its danger tone.
  //
  // Now: a subject rail beside the experiment table for the selected subject, one
  // shared dialog, and honest instrument readouts. Labs are a *face of a Subject*
  // (the Work face of the Subject workspace renders the same rows), so this view
  // is the cross-subject lens on the same data — it does not own a second model.
  import { FlaskConical, Plus, Check, Pencil, Trash2, FileText } from "lucide-svelte";
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { Menu, Modal } from "../../../shared/components";
  import { labsService } from "../services/labs.service.js";

  let { profileId = null } = $props();

  let tree = $state([]);
  let activeSubjectId = $state(null);
  let experiments = $state([]);
  let loading = $state(false);
  let summaries = $state({}); // subjectId -> { total, records_submitted, vivas_done }

  let modalOpen = $state(false);
  let editingExp = $state(null);

  let formExpNo = $state(1);
  let formTitle = $state("");
  let formRecord = $state(false);
  let formViva = $state(false);
  let formScore = $state("");
  let formNotes = $state("");

  const allSubjects = $derived.by(() => {
    const subs = [];
    for (const track of tree) {
      for (const sem of track.semesters) {
        for (const ms of sem.milestones) {
          for (const subj of ms.subjects) {
            subs.push({ id: subj.id, name: subj.name, trackName: track.name, semesterName: sem.name });
          }
        }
      }
    }
    return subs;
  });

  const activeSubject = $derived(allSubjects.find((s) => s.id === activeSubjectId) ?? null);

  async function loadTree() {
    if (profileId == null) {
      tree = [];
      summaries = {};
      return;
    }
    try {
      tree = await labsService.getTree(profileId);
    } catch (e) {
      reportError(e, "Could not load academic tree");
    }
  }

  /**
   * Per-subject record/viva counts for the rail. These are the same rows the
   * table renders, so the rail can never disagree with the table.
   */
  async function loadSummaries() {
    if (profileId == null || allSubjects.length === 0) {
      summaries = {};
      return;
    }
    try {
      const next = {};
      for (const s of allSubjects) {
        const rows = await labsService.list(profileId, s.id);
        next[s.id] = {
          total: rows.length,
          submitted: rows.filter((r) => r.record_submitted).length,
          vivas: rows.filter((r) => r.viva_done).length,
        };
      }
      summaries = next;
      if (activeSubjectId == null || !allSubjects.some((s) => s.id === activeSubjectId)) {
        activeSubjectId = allSubjects[0]?.id ?? null;
      }
    } catch (e) {
      reportError(e, "Could not load lab progress");
    }
  }

  async function loadExperiments() {
    if (!activeSubjectId) {
      experiments = [];
      return;
    }
    const requested = activeSubjectId;
    loading = true;
    try {
      const rows = await labsService.list(profileId, requested);
      if (activeSubjectId !== requested) return; // a newer selection superseded this
      experiments = rows;
    } catch (e) {
      reportError(e, "Could not load experiments");
    } finally {
      if (activeSubjectId === requested) loading = false;
    }
  }

  $effect(() => {
    void profileId;
    loadTree();
  });

  // The rail's counts come from the same rows as the table, so reload them
  // whenever the subject list changes.
  $effect(() => {
    void allSubjects.length;
    loadSummaries();
  });

  $effect(() => {
    void activeSubjectId;
    loadExperiments();
  });

  $effect(() => {
    const onChanged = () => {
      loadTree();
      loadSummaries();
      loadExperiments();
    };
    window.addEventListener("cf:data-changed", onChanged);
    return () => window.removeEventListener("cf:data-changed", onChanged);
  });

  async function refresh() {
    await loadSummaries();
    await loadExperiments();
  }

  let totals = $derived.by(() => {
    let total = 0;
    let submitted = 0;
    let vivas = 0;
    for (const s of allSubjects) {
      const row = summaries[s.id];
      if (!row) continue;
      total += row.total;
      submitted += row.submitted;
      vivas += row.vivas;
    }
    return { total, submitted, vivas, subjects: Object.values(summaries).filter((r) => r.total > 0).length };
  });

  let subjectStats = $derived.by(() => ({
    submitted: experiments.filter((e) => e.record_submitted).length,
    vivas: experiments.filter((e) => e.viva_done).length,
    total: experiments.length,
  }));

  function subjectMenu(s) {
    return [
      { id: "add", label: "Add experiment", onselect: () => openAddModal(s.id) },
    ];
  }

  function openAddModal(subjectId = activeSubjectId) {
    const target = subjectId ?? activeSubjectId;
    if (!target) {
      toast.error("Add a subject first — labs attach to a subject.");
      return;
    }
    activeSubjectId = target;
    editingExp = null;
    const rows = target === activeSubjectId ? experiments : [];
    formExpNo = rows.length > 0 ? Math.max(...rows.map((e) => e.experiment_no)) + 1 : 1;
    formTitle = "";
    formRecord = false;
    formViva = false;
    formScore = "";
    formNotes = "";
    modalOpen = true;
  }

  function openEditModal(exp) {
    editingExp = exp;
    formExpNo = exp.experiment_no;
    formTitle = exp.title;
    formRecord = exp.record_submitted;
    formViva = exp.viva_done;
    formScore = exp.viva_score || "";
    formNotes = exp.notes || "";
    modalOpen = true;
  }

  function closeModal() {
    modalOpen = false;
    editingExp = null;
  }

  async function saveExperiment() {
    if (!formTitle.trim()) {
      toast.error("An experiment needs a title.");
      return;
    }
    try {
      if (editingExp) {
        await labsService.update(
          profileId,
          editingExp.id,
          formTitle.trim(),
          formRecord,
          formViva,
          formScore || null,
          formNotes || null
        );
        toast.success("Experiment updated");
      } else {
        await labsService.add(profileId, activeSubjectId, formExpNo, formTitle.trim());
        // Record/viva/score are recorded in the same gesture: create, then apply
        // the remaining fields to the row that was just written.
        if (formRecord || formViva || formScore || formNotes) {
          const fresh = await labsService.list(profileId, activeSubjectId);
          const created = fresh.find((e) => e.experiment_no === formExpNo) ?? fresh[fresh.length - 1];
          if (created) {
            await labsService.update(
              profileId,
              created.id,
              formTitle.trim(),
              formRecord,
              formViva,
              formScore || null,
              formNotes || null
            );
          }
        }
        toast.success("Experiment added");
      }
      closeModal();
      await refresh();
    } catch (e) {
      reportError(e, "Save failed");
    }
  }

  async function deleteExperiment(exp) {
    const ok = await confirmDialog({
      title: "Delete experiment",
      message: `Delete “${exp.title}”?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await labsService.remove(profileId, exp.id);
      toast.success("Experiment deleted");
      await refresh();
    } catch (e) {
      reportError(e, "Delete failed");
    }
  }

  async function toggleField(exp, field) {
    try {
      const record = field === "record" ? !exp.record_submitted : exp.record_submitted;
      const viva = field === "viva" ? !exp.viva_done : exp.viva_done;
      await labsService.update(profileId, exp.id, exp.title, record, viva, exp.viva_score, exp.notes);
      await loadSummaries();
      await loadExperiments();
    } catch (e) {
      reportError(e, "Update failed");
    }
  }
</script>

<div class="labs-view atl-view">
  <header class="index-head">
    <div class="index-id">
      <h1>Labs</h1>
      <p class="standing">
        {totals.total} experiment{totals.total === 1 ? "" : "s"}
        · {totals.submitted} record{totals.submitted === 1 ? "" : "s"} submitted
        · {totals.vivas} viva{totals.vivas === 1 ? "" : "s"} done
      </p>
    </div>
    <button class="cf-btn primary" onclick={() => openAddModal()} disabled={allSubjects.length === 0}>
      <Plus size={14} /> Add experiment
    </button>
  </header>

  {#if allSubjects.length === 0}
    <div class="cf-empty boxed">
      <FlaskConical size={26} />
      <h3>No labs yet</h3>
      <p>Labs attach to a subject, and subjects are created in the Degree planner.</p>
    </div>
  {:else}
    <div class="readout">
      <div class="stat">
        <span class="stat-num">{totals.submitted} / {totals.total}</span>
        <span class="atl-label">Records submitted</span>
        <span class="rule"><span class="fill" style="width:{(totals.total ? Math.round((totals.submitted / totals.total) * 100) : 0)}%"></span></span>
      </div>
      <div class="stat">
        <span class="stat-num">{totals.vivas} / {totals.total}</span>
        <span class="atl-label">Vivas completed</span>
        <span class="rule"><span class="fill viva" style="width:{(totals.total ? Math.round((totals.vivas / totals.total) * 100) : 0)}%"></span></span>
      </div>
      <div class="stat">
        <span class="stat-num">{totals.subjects}</span>
        <span class="atl-label">Subjects with labs</span>
      </div>
    </div>

    <div class="split">
      <section class="rail">
        <div class="atl-band-head">
          <h2>Subjects</h2>
          <p class="atl-band-note">{allSubjects.length}</p>
        </div>
        <div class="rows">
          {#each allSubjects as s (s.id)}
            {@const row = summaries[s.id]}
            {@const done = row && row.total > 0 && row.submitted === row.total && row.vivas === row.total}
            <div class="subject-row" class:on={s.id === activeSubjectId}>
              <button class="row-open" onclick={() => (activeSubjectId = s.id)}>
                <span class="s-name">{s.name}</span>
                <span class="s-meta">
                  {#if row && row.total > 0}
                    {row.submitted}/{row.total} records · {row.vivas}/{row.total} vivas
                  {:else}
                    no experiments
                  {/if}
                </span>
              </button>
              {#if done}
                <span class="done-mark" role="img" aria-label="All records and vivas complete">
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                </span>
              {/if}
              <span onclick={(e) => e.stopPropagation()} role="presentation">
                <Menu label="Subject options" items={subjectMenu(s)} />
              </span>
            </div>
          {/each}
        </div>
      </section>

      <section class="detail">
        {#if activeSubject}
          <div class="atl-band-head">
            <h2>{activeSubject.name}</h2>
            <p class="atl-band-note">
              {subjectStats.submitted}/{subjectStats.total} records · {subjectStats.vivas}/{subjectStats.total} vivas
            </p>
            <div class="atl-band-actions">
              <button class="cf-btn ghost" onclick={() => openAddModal(activeSubject.id)}>
                <Plus size={13} /> Add experiment
              </button>
            </div>
          </div>

          {#if loading && experiments.length === 0}
            <div class="cf-skeleton skel"></div>
          {:else if experiments.length === 0}
            <div class="cf-empty">
              <FlaskConical size={24} />
              <h3>No experiments recorded</h3>
              <p>Log the experiments for {activeSubject.name} as you do them.</p>
            </div>
          {:else}
            <div class="rows">
              {#each experiments as exp (exp.id)}
                <div class="exp-row">
                  <span class="gutter">#{exp.experiment_no}</span>
                  <span class="exp-title">{exp.title}</span>
                  <button
                    class="toggle {exp.record_submitted ? 'done' : ''}"
                    onclick={() => toggleField(exp, "record")}
                    aria-pressed={exp.record_submitted}
                    title="Toggle record submitted"
                  >
                    {#if exp.record_submitted}<Check size={11} strokeWidth={3} aria-hidden="true" />{/if}
                    {exp.record_submitted ? "Record in" : "Record out"}
                  </button>
                  <button
                    class="toggle viva {exp.viva_done ? 'done' : ''}"
                    onclick={() => toggleField(exp, "viva")}
                    aria-pressed={exp.viva_done}
                    title="Toggle viva completed"
                  >
                    {#if exp.viva_done}<Check size={11} strokeWidth={3} aria-hidden="true" />{/if}
                    {exp.viva_done ? "Viva done" : "Viva pending"}
                  </button>
                  <span class="score mono">{exp.viva_score ? exp.viva_score : "—"}</span>
                  {#if exp.notes}
                    <span class="note" title={exp.notes}><FileText size={12} aria-hidden="true" /></span>
                  {/if}
                  <Menu
                    label="Experiment options"
                    items={[
                      { id: "edit", label: "Edit experiment", onselect: () => openEditModal(exp) },
                      { id: "sep", separator: true },
                      { id: "del", label: "Delete experiment", danger: true, onselect: () => deleteExperiment(exp) },
                    ]}
                  />
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <div class="cf-empty">
            <FlaskConical size={24} />
            <h3>No subject selected</h3>
            <p>Pick a subject from the rail.</p>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<Modal
  open={modalOpen}
  title={editingExp ? "Edit experiment" : "Add experiment"}
  subtitle={activeSubject ? `Recording against ${activeSubject.name}.` : ""}
  width={520}
  onClose={closeModal}
>
  {#snippet children()}
    <form class="form" onsubmit={(e) => { e.preventDefault(); saveExperiment(); }}>
      <div class="field-row">
        <label class="field narrow">
          <span class="atl-label">No.</span>
          <input class="cf-input" type="number" min="1" bind:value={formExpNo} disabled={!!editingExp} />
        </label>
        <label class="field">
          <span class="atl-label">Title</span>
          <input class="cf-input" type="text" bind:value={formTitle} placeholder="e.g. Study of half-wave rectifier" />
        </label>
      </div>
      <div class="check-row">
        <label class="check">
          <input type="checkbox" bind:checked={formRecord} />
          <span>Record submitted</span>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={formViva} />
          <span>Viva completed</span>
        </label>
      </div>
      <label class="field">
        <span class="atl-label">Viva score</span>
        <input class="cf-input" type="text" bind:value={formScore} placeholder="e.g. 9/10, A+" />
      </label>
      <label class="field">
        <span class="atl-label">Notes</span>
        <textarea class="cf-textarea" bind:value={formNotes} rows="2"></textarea>
      </label>
      <div class="form-actions">
        <button type="button" class="cf-btn ghost sm" onclick={closeModal}>Cancel</button>
        <button type="submit" class="cf-btn primary sm">{editingExp ? "Save changes" : "Add experiment"}</button>
      </div>
    </form>
  {/snippet}
</Modal>

<style>
  .index-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .index-id { display: flex; flex-direction: column; gap: 4px; }
  .index-head h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }
  .standing { margin: 0; font-size: var(--text-md); color: var(--atlas-ink-3); font-variant-numeric: tabular-nums; }

  .readout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    background: var(--atlas-panel);
  }
  .stat { display: flex; flex-direction: column; gap: 3px; }
  .stat-num {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--atlas-ink);
    font-variant-numeric: tabular-nums;
  }
  .rule {
    display: block;
    height: 2px;
    margin-top: 3px;
    background: var(--atlas-raise);
    border-radius: var(--radius-full);
    overflow: hidden;
  }
  .fill { display: block; height: 100%; background: var(--atlas-ok); transition: width var(--dur-slow) var(--ease); }
  .fill.viva { background: var(--atlas-signal); }

  .split {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    gap: var(--space-5);
    align-items: start;
  }
  .rail, .detail { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
  .atl-band-head h2 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--atlas-ink); }

  .rows { display: flex; flex-direction: column; }

  .subject-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
    border-top: 1px solid var(--atlas-line);
  }
  .subject-row:hover { background: var(--atlas-wash); }
  .subject-row.on { background: var(--atlas-wash-2); box-shadow: inset 2px 0 0 var(--atlas-signal); }

  .row-open {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    padding: 6px 0;
    text-align: left;
    cursor: pointer;
  }
  .s-name {
    font-size: var(--text-md);
    font-weight: 550;
    color: var(--atlas-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .s-meta { font-size: var(--text-sm); color: var(--atlas-ink-3); font-variant-numeric: tabular-nums; }
  .done-mark { display: inline-flex; color: var(--atlas-ok); flex: 0 0 auto; }

  .exp-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
    border-top: 1px solid var(--atlas-line);
    font-size: var(--text-md);
  }
  .exp-row:hover { background: var(--atlas-wash); }

  .gutter {
    flex: 0 0 auto;
    min-width: 4ch;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    color: var(--atlas-ink-3);
  }
  .exp-title {
    flex: 1;
    min-width: 0;
    color: var(--atlas-ink);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 9px;
    border-radius: var(--radius-full);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  .toggle:hover { color: var(--atlas-ink-2); border-color: var(--atlas-line-2); }
  .toggle.done { background: var(--atlas-ok-bg); color: var(--atlas-ok); border-color: var(--atlas-ok); }
  .toggle.viva.done { background: var(--atlas-signal-soft); color: var(--atlas-signal); border-color: var(--atlas-signal); }

  .score { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--atlas-ink-2); min-width: 5ch; text-align: right; }
  .note { display: inline-flex; color: var(--atlas-ink-3); flex: 0 0 auto; }

  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field.narrow { max-width: 88px; }
  .field-row { display: flex; gap: var(--space-4); align-items: flex-end; }
  .field-row .field:not(.narrow) { flex: 1; }
  .check-row { display: flex; gap: var(--space-5); flex-wrap: wrap; }
  .check { display: inline-flex; align-items: center; gap: 7px; font-size: var(--text-md); color: var(--atlas-ink-2); cursor: pointer; }
  .form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }

  .skel { height: 120px; }

  @media (max-width: 900px) {
    .split { grid-template-columns: 1fr; }
  }
</style>
