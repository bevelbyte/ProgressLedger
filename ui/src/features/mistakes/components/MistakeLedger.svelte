<script>
  import { mistakesService } from "../services/mistakes.service.js";
  import { confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { Modal } from "../../../shared/components";

  let { profileId = null } = $props();

  const MISTAKE_TYPES = ["Conceptual", "Calculation", "Formula", "Silly", "Time Management"];

  let mistakes = $state([]);
  let stats = $state(null);
  let loading = $state(false);
  let filterSubject = $state(null);
  let filterType = $state(null);
  let academicTree = $state([]);

  // Modal state
  let showModal = $state(false);
  let editingMistake = $state(null);
  let formData = $state({
    subjectId: null,
    questionText: "",
    mistakeType: "Conceptual",
    correctApproach: "",
    tags: "",
  });

  // Load academic tree for subject dropdown
  async function loadAcademicTree() {
    if (profileId == null) {
      academicTree = [];
      return;
    }
    try {
      academicTree = await mistakesService.getTree(profileId);
    } catch (e) {
      console.error("load academic tree failed:", e);
      academicTree = [];
    }
  }

  // Load all subjects from academic tree
  let allSubjects = $derived.by(() => {
    const subjects = [];
    for (const track of academicTree) {
      for (const sem of track.semesters || []) {
        for (const ms of sem.milestones || []) {
          for (const subj of ms.subjects || []) {
            subjects.push({ id: subj.id, name: subj.name, track: track.name });
          }
        }
      }
    }
    return subjects;
  });

  async function load() {
    loading = true;
    try {
      mistakes = await mistakesService.list(profileId, {
        subjectId: filterSubject,
        mistakeType: filterType,
      });
      if (profileId) {
        stats = await mistakesService.stats(profileId);
      }
    } catch (e) {
      console.error("load mistakes failed:", e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (profileId != null) {
      loadAcademicTree();
      load();
    }
  });

  $effect(() => {
    filterSubject;
    filterType;
    if (profileId != null) load();
  });

  function openAddModal() {
    editingMistake = null;
    formData = {
      subjectId: allSubjects[0]?.id || null,
      questionText: "",
      mistakeType: "Conceptual",
      correctApproach: "",
      tags: "",
    };
    showModal = true;
  }

  function openEditModal(m) {
    editingMistake = m;
    formData = {
      subjectId: m.subjectId,
      questionText: m.questionText,
      mistakeType: m.mistakeType,
      correctApproach: m.correctApproach,
      tags: m.tags || "",
    };
    showModal = true;
  }

  async function saveMistake() {
    if (!formData.subjectId || !formData.questionText.trim()) return;

    try {
      if (editingMistake) {
        await mistakesService.update(
          profileId,
          editingMistake.id,
          formData.questionText,
          formData.mistakeType,
          formData.correctApproach,
          formData.tags
        );
      } else {
        await mistakesService.add(
          profileId,
          formData.subjectId,
          formData.questionText,
          formData.mistakeType,
          formData.correctApproach,
          formData.tags
        );
      }
      showModal = false;
      await load();
    } catch (e) {
      console.error("save mistake failed:", e);
    }
  }

  async function deleteMistake(id) {
    const ok = await confirmDialog({
      title: "Delete mistake",
      message: "Delete this mistake? This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await mistakesService.remove(profileId, id);
      await load();
    } catch (e) {
      console.error("delete failed:", e);
    }
  }

  function getTypeColor(type) {
    const colors = {
      Conceptual: "var(--atlas-bad)",
      Calculation: "var(--atlas-warn)",
      Formula: "var(--atlas-signal)",
      Silly: "var(--atlas-ink-3)",
      "Time Management": "var(--atlas-signal)",
    };
    return colors[type] || "var(--atlas-ink-3)";
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
</script>

<section class="mistake-ledger">
  <div class="header">
    <h2>Mistake Ledger</h2>
    <button class="add-btn" onclick={openAddModal} disabled={profileId == null}>
      + Log Mistake
    </button>
  </div>

  {#if profileId == null}
    <p class="empty">Select a student profile to track mistakes.</p>
  {:else if loading}
    <p class="loading">Loading mistakes…</p>
  {:else}
    <!-- Stats Summary -->
    {#if stats}
      <div class="stats">
        <div class="stat-card">
          <div class="stat-value">{stats.totalMistakes}</div>
          <div class="stat-label">Total Mistakes</div>
        </div>
        {#if stats.top3Types.length > 0}
          <div class="stat-card top-types">
            <div class="stat-label">Top Mistake Types</div>
            <div class="type-list">
              {#each stats.top3Types as t}
                <span class="type-chip" style="background:{getTypeColor(t.mistakeType)}20; color:{getTypeColor(t.mistakeType)}">
                  {t.mistakeType}: {t.count}
                </span>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Filters -->
    <div class="filters">
      <select bind:value={filterSubject}>
        <option value={null}>All Subjects</option>
        {#each allSubjects as s}
          <option value={s.id}>{s.name}</option>
        {/each}
      </select>
      <select bind:value={filterType}>
        <option value={null}>All Types</option>
        {#each MISTAKE_TYPES as t}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </div>

    <!-- Mistakes List -->
    {#if mistakes.length === 0}
      <p class="empty">No mistakes logged yet. Click "+ Log Mistake" to start tracking errors.</p>
    {:else}
      <div class="mistakes-list">
        {#each mistakes as m}
          <div class="mistake-card">
            <div class="mistake-header">
              <span class="subject-badge">{m.subjectName}</span>
              <span class="type-badge" style="background:{getTypeColor(m.mistakeType)}20; color:{getTypeColor(m.mistakeType)}">
                {m.mistakeType}
              </span>
              <span class="date">{formatDate(m.createdAt)}</span>
            </div>
            <div class="mistake-body">
              <div class="question">
                <strong>Question:</strong>
                <p>{m.questionText}</p>
              </div>
              {#if m.correctApproach}
                <div class="approach">
                  <strong>Correct Approach:</strong>
                  <p>{m.correctApproach}</p>
                </div>
              {/if}
              {#if m.tags}
                <div class="tags">
                  {#each m.tags.split(',').map(t => t.trim()).filter(Boolean) as tag}
                    <span class="tag">#{tag}</span>
                  {/each}
                </div>
              {/if}
            </div>
            <div class="mistake-actions">
              <button class="edit-btn" onclick={() => openEditModal(m)}>Edit</button>
              <button class="delete-btn" onclick={() => deleteMistake(m.id)}>Delete</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>

<!-- Modal -->
<Modal
  open={showModal}
  title={editingMistake ? "Edit mistake" : "Log new mistake"}
  subtitle="A mistake is logged against one subject, with its type."
  width={560}
  onClose={() => (showModal = false)}
>
  {#snippet children()}
    <div class="modal-form">
      <div class="form-group">
        <label for="mistake-subject">Subject</label>
        <select id="mistake-subject" class="cf-select" bind:value={formData.subjectId}>
          {#each allSubjects as s}
            <option value={s.id}>{s.name} ({s.track})</option>
          {/each}
        </select>
      </div>

      <div class="form-group">
        <label for="mistake-type">Mistake Type</label>
        <select id="mistake-type" class="cf-select" bind:value={formData.mistakeType}>
          {#each MISTAKE_TYPES as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </div>

      <div class="form-group">
        <label for="mistake-question">Question / Problem</label>
        <textarea
          id="mistake-question"
          class="cf-textarea"
          bind:value={formData.questionText}
          placeholder="What was the question or problem?"
          rows="3"
        ></textarea>
      </div>

      <div class="form-group">
        <label for="mistake-solution">Correct Approach / Solution</label>
        <textarea
          id="mistake-solution"
          class="cf-textarea"
          bind:value={formData.correctApproach}
          placeholder="What is the correct approach or solution?"
          rows="3"
        ></textarea>
      </div>

      <div class="form-group">
        <label for="mistake-tags">Tags (comma-separated)</label>
        <input
          id="mistake-tags"
          class="cf-input"
          type="text"
          bind:value={formData.tags}
          placeholder="e.g., calculus, integration, physics"
        />
      </div>

      <div class="modal-actions">
        <button class="cf-btn ghost sm" onclick={() => (showModal = false)}>Cancel</button>
        <button class="cf-btn primary sm" onclick={saveMistake}>
          {editingMistake ? "Update" : "Save"}
        </button>
      </div>
    </div>
  {/snippet}
</Modal>

<style>
  .mistake-ledger {
    margin-top: 32px;
    padding: 0 4px;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  h2 {
    font-size: var(--text-2xl);
    font-weight: 600;
    color: var(--atlas-ink);
    margin: 0;
  }

  .add-btn {
    background: var(--atlas-signal);
    color: var(--atlas-on-fill);
    border: none;
    padding: 6px 14px;
    border-radius: var(--radius-md);
    font-size: var(--text-md);
    cursor: pointer;
    transition: background 0.15s;
  }
  .add-btn:hover {
    background: var(--atlas-signal);
  }
  .add-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .empty,
  .loading {
    color: var(--atlas-ink-3);
    font-size: var(--text-lg);
    text-align: center;
    padding: 24px;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }

  .stat-card {
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    padding: 14px;
  }

  .stat-value {
    font-size: var(--text-metric);
    font-weight: 700;
    color: var(--atlas-ink);
    line-height: 1;
  }

  .stat-label {
    font-size: var(--text-md);
    color: var(--atlas-ink-3);
    margin-top: 4px;
  }

  .top-types .type-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .type-chip {
    padding: 3px 10px;
    border-radius: var(--radius-xl);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .filters {
    display: flex;
    gap: 10px;
    margin-bottom: 16px;
  }

  .filters select {
    flex: 1;
    background: var(--atlas-base);
    color: var(--atlas-ink);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    font-size: var(--text-md);
    cursor: pointer;
  }

  .mistakes-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .mistake-card {
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    padding: 14px;
    transition: border-color 0.15s;
  }
  .mistake-card:hover {
    border-color: var(--atlas-line-2);
  }

  .mistake-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .subject-badge {
    background: var(--atlas-signal)20;
    color: var(--atlas-signal);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .type-badge {
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .date {
    margin-left: auto;
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
  }

  .mistake-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .question,
  .approach {
    font-size: var(--text-md);
    color: var(--atlas-ink-2);
  }

  .question strong,
  .approach strong {
    color: var(--atlas-ink);
    display: block;
    margin-bottom: 4px;
  }

  .question p,
  .approach p {
    margin: 0;
    line-height: 1.5;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .tag {
    background: var(--atlas-line);
    color: var(--atlas-ink-3);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
  }

  .mistake-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--atlas-raise);
  }

  .edit-btn,
  .delete-btn {
    background: transparent;
    border: 1px solid var(--atlas-line);
    color: var(--atlas-ink-3);
    padding: 4px 12px;
    border-radius: var(--radius-sm);
    font-size: var(--text-md);
    cursor: pointer;
    transition: all 0.15s;
  }
  .edit-btn:hover {
    background: var(--atlas-line);
    color: var(--atlas-ink);
  }
  .delete-btn:hover {
    background: var(--atlas-bad)20;
    border-color: var(--atlas-bad);
    color: var(--atlas-bad);
  }

  /* Modal form (the dialog frame itself is the shared Modal primitive). */
  .modal-form {
    display: flex;
    flex-direction: column;
  }

  .form-group {
    margin-bottom: 16px;
  }

  .form-group label {
    display: block;
    font-size: var(--text-md);
    color: var(--atlas-ink-2);
    margin-bottom: 6px;
  }

  .form-group input,
  .form-group select,
  .form-group textarea {
    width: 100%;
  }

  .modal-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 20px;
  }

</style>
