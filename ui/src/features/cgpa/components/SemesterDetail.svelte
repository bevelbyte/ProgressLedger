<script>
  // Semester detail — the subject-and-marks half of the Degree structure face.
  //
  // Presentational: mutations are delegated up via callbacks, and SGPA text
  // comes from the store (Rust-computed). No persistence or calculation here.
  //
  // Structure: identity (semester + status control) · evaluation pattern scope ·
  // one hairline marks table with a total row. The panel is no longer a bordered
  // card floating inside a bordered page — it is a band beside the semester rail.
  //
  // E2E contracts preserved: `.semester-details-panel`, `.pattern-btn`,
  // `[title="Edit Subject"]`, `[title="Delete Subject"]`, and the subject name
  // as visible text.
  import { Plus, Pencil, Trash2 } from "lucide-svelte";
  import { EVALUATION_PATTERNS, patternMarkSummary } from "../cgpa-view.js";

  let {
    semester,
    activePatternName = "Internal - I",
    onSelectPattern,
    onSetStatus,
    onAddSubject,
    onEditSubject,
    onDeleteSubject,
    onCopyFrom,
  } = $props();

  const activePattern = $derived(semester?.patterns?.[activePatternName]);
  const patternTotal = $derived(patternMarkSummary(activePattern));

</script>

{#if semester}
  <div class="semester-details-panel">
    <header class="detail-head">
      <div class="detail-id">
        <h3>Semester {semester.number}</h3>
        <span class="status-badge {semester.status.toLowerCase().replace(' ', '-')}">{semester.status}</span>
      </div>
      <label class="status-field">
        <span class="atl-label">Status</span>
        <select
          class="cf-select"
          value={semester.status}
          onchange={(e) => onSetStatus?.(e.currentTarget.value)}
        >
          <option value="Upcoming">Upcoming</option>
          <option value="In Progress">In Progress</option>
          <option value="Completed">Completed</option>
        </select>
      </label>
    </header>

    <div class="pattern-row">
      <span class="atl-label">Evaluation</span>
      <div class="pattern-selector" role="group" aria-label="Evaluation pattern">
        {#each EVALUATION_PATTERNS as pattern}
          <button
            class="pattern-btn"
            class:active={activePatternName === pattern}
            aria-pressed={activePatternName === pattern}
            onclick={() => onSelectPattern?.(pattern)}
          >
            {pattern}
          </button>
        {/each}
      </div>
    </div>

    <div class="subjects-section">
      <div class="subjects-header">        <h4>{activePatternName}</h4>
        <div class="subjects-head-actions">
          {#if patternTotal.max > 0}
            <span class="total-readout mono">
              {patternTotal.obtained} / {patternTotal.max}
              <span class="atl-label">marks</span>
            </span>
          {/if}
          <button class="minimal-btn add-sub-btn" onclick={onAddSubject}>
            <Plus size={12} /> Add subject
          </button>
        </div>
      </div>

      <div class="subjects-table">
        <div class="table-header">
          <span class="col-n">#</span>
          <span>Subject</span>
          <span>Code</span>
          <span class="right">Marks</span>
          <span class="right">Actions</span>
        </div>

        <div class="table-body">
          {#if !activePattern || !activePattern.subjects || activePattern.subjects.length === 0}
            <div class="no-subjects">
              <p class="atl-label">No subjects in {activePatternName}</p>
              {#if EVALUATION_PATTERNS.some((p) => p !== activePatternName && semester.patterns[p]?.subjects.length > 0)}
                <div class="copy-options">
                  {#each EVALUATION_PATTERNS as pName}
                    {#if pName !== activePatternName && semester.patterns[pName]?.subjects.length > 0}
                      <button class="minimal-btn copy-action-btn" onclick={() => onCopyFrom?.(pName)}>
                        Copy subjects from {pName}
                      </button>
                    {/if}
                  {/each}
                </div>
              {:else}
                <p class="empty-note">Add the subjects you are taking in this evaluation pattern.</p>
              {/if}
            </div>
          {:else}
            {#each activePattern.subjects as sub, sIdx (sub.id)}
              <div class="table-row">
                <span class="col-n mono muted">{sIdx + 1}</span>
                <span class="subject-name">{sub.name}</span>
                <span class="mono muted">{sub.code || "—"}</span>
                <span class="right mono marks">
                  {#if sub.maxMarks !== null && sub.maxMarks !== undefined}
                    {sub.marksObtained !== null && sub.marksObtained !== undefined ? sub.marksObtained : "—"} / {sub.maxMarks}
                  {:else}
                    —
                  {/if}
                </span>
                <div class="right actions">
                  <button class="icon-action-btn" onclick={() => onEditSubject?.(sub)} title="Edit Subject">
                    <Pencil size={13} />
                  </button>
                  <button
                    class="icon-action-btn delete-btn"
                    onclick={() => onDeleteSubject?.(sub.id)}
                    title="Delete Subject"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            {/each}
            <div class="table-total-row">
              <span class="col-n"></span>
              <span>Total</span>
              <span></span>
              <span class="right mono">
                {#if patternTotal.max > 0}{patternTotal.obtained} / {patternTotal.max}{:else}—{/if}
              </span>
              <span></span>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .semester-details-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
    min-height: 320px;
  }

  .detail-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--atlas-line);
    flex-wrap: wrap;
  }
  .detail-id { display: flex; align-items: center; gap: var(--space-3); }
  .detail-head h3 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--atlas-ink);
  }
  .status-field { display: flex; flex-direction: column; gap: 3px; }

  .status-badge {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 1px 7px;
    border-radius: var(--radius-full);
    white-space: nowrap;
  }
  .status-badge.completed { background: var(--atlas-ok-bg); color: var(--atlas-ok); }
  .status-badge.in-progress { background: var(--atlas-signal-soft); color: var(--atlas-signal); }
  .status-badge.upcoming { background: var(--atlas-wash-2); color: var(--atlas-ink-3); }

  .pattern-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .pattern-selector {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-md);
    background: var(--atlas-raise);
  }
  .pattern-btn {
    padding: 5px 12px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    cursor: pointer;
    white-space: nowrap;
  }
  .pattern-btn:hover { color: var(--atlas-ink); }
  .pattern-btn.active { background: var(--atlas-signal-soft); color: var(--atlas-signal); font-weight: 550; }

  .subjects-section { display: flex; flex-direction: column; gap: var(--space-2); }
  .subjects-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .subjects-header h4 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--atlas-ink);
  }
  .subjects-head-actions { display: flex; align-items: center; gap: var(--space-3); }
  .total-readout {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    font-size: var(--text-md);
    color: var(--atlas-ink-2);
  }

  .subjects-table { display: flex; flex-direction: column; }
  .table-header,
  .table-row,
  .table-total-row {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) 90px 110px 84px;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-2);
    min-height: var(--row-h);
    font-size: var(--text-md);
  }
  .table-header {
    min-height: 30px;
    border-bottom: 1px solid var(--atlas-line);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
  }
  .table-row { border-bottom: 1px solid var(--atlas-line); color: var(--atlas-ink-2); }
  .table-row:hover { background: var(--atlas-wash); }
  .table-total-row {
    font-weight: 600;
    color: var(--atlas-ink);
    background: var(--atlas-wash);
    border-radius: var(--radius-xs);
  }
  .subject-name {
    font-weight: 550;
    color: var(--atlas-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .right { text-align: right; }
  .muted { color: var(--atlas-ink-3); }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .marks { color: var(--atlas-ink); }
  .col-n { color: var(--atlas-ink-3); }

  .actions { display: flex; justify-content: flex-end; gap: var(--space-1); }

  .no-subjects { padding: var(--space-6) var(--space-4); text-align: center; display: flex; flex-direction: column; gap: var(--space-2); align-items: center; }
  .no-subjects p { margin: 0; }
  .empty-note { font-size: var(--text-md); color: var(--atlas-ink-3); }
  .copy-options { display: flex; gap: var(--space-2); justify-content: center; flex-wrap: wrap; }

  .minimal-btn {
    padding: 6px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .minimal-btn:hover { border-color: var(--atlas-signal); color: var(--atlas-ink); }

  .icon-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: none;
    border: 0;
    border-radius: var(--radius-xs);
    color: var(--atlas-ink-3);
    cursor: pointer;
  }
  .icon-action-btn:hover { color: var(--atlas-ink); background: var(--atlas-wash-2); }
  .icon-action-btn.delete-btn:hover { color: var(--atlas-bad); }
</style>
