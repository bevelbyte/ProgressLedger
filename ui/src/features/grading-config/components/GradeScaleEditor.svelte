<script>
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { gradingService, validateBandsLocally } from "../services/grading.service.js";
  import { Plus, Trash2, RotateCcw, GraduationCap } from "lucide-svelte";

  // Grade scale is per-profile academic configuration. This panel lives in
  // Settings; CGPA consumes the saved scale but does not own this UI.
  let { activeProfile = null } = $props();

  let bands = $state([]); // { minPercent, gradePoint, label }
  let loading = $state(true);
  let working = $state(false);

  // Sorted highest-threshold-first for display (matches how the engine matches).
  const sortedBands = $derived([...bands].sort((a, b) => Number(b.minPercent) - Number(a.minPercent)));
  const validationError = $derived(validateBandsLocally(bands));

  function fromDto(list) {
    return (list ?? []).map((b) => ({
      minPercent: b.minPercent,
      gradePoint: b.gradePoint,
      label: b.label ?? "",
    }));
  }
  function toDto(list) {
    return list.map((b) => ({
      minPercent: Number(b.minPercent),
      gradePoint: Number(b.gradePoint),
      label: (b.label ?? "").trim(),
    }));
  }

  async function load() {
    if (!activeProfile) {
      bands = [];
      loading = false;
      return;
    }
    loading = true;
    try {
      bands = fromDto(await gradingService.getScale(activeProfile.id));
    } catch (e) {
      reportError(e, "Could not load grade scale");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    activeProfile?.id;
    load();
  });

  function addBand() {
    bands = [...bands, { minPercent: 0, gradePoint: 0, label: "" }];
  }

  function removeBand(index) {
    bands = bands.filter((_, i) => i !== index);
  }

  async function save() {
    if (!activeProfile) return;
    const local = validateBandsLocally(bands);
    if (local) {
      toast.error(local, "Invalid grade scale");
      return;
    }
    working = true;
    try {
      // Rust re-validates and rejects an inconsistent scale with a coded error.
      await gradingService.save(activeProfile.id, toDto(bands));
      // Recomputes any CGPA that consumers show against the new scale.
      window.dispatchEvent(new Event("cf:data-changed"));
      toast.success("Grade scale saved.", "Grading configuration");
    } catch (e) {
      reportError(e, "Could not save grade scale");
    } finally {
      working = false;
    }
  }

  async function restoreDefault() {
    working = true;
    try {
      bands = fromDto(await gradingService.getDefaultScale());
      toast.info("Default scale loaded — remember to Save to apply it.", "Grading configuration");
    } catch (e) {
      reportError(e, "Could not load default scale");
    } finally {
      working = false;
    }
  }
</script>

<section class="grade-scale">
  <div class="head">
    <div class="title">
      <GraduationCap size={18} />
      <div>
        <h2>Grade Scale</h2>
        <p class="sub">
          How marks convert to grade points for SGPA/CGPA. Applies to
          {activeProfile ? ` "${activeProfile.name}"` : " the active profile"}.
        </p>
      </div>
    </div>
    <button class="ghost-btn" onclick={restoreDefault} disabled={working || !activeProfile}>
      <RotateCcw size={14} /> Restore default
    </button>
  </div>

  {#if !activeProfile}
    <p class="empty">Select a profile to configure its grade scale.</p>
  {:else if loading}
    <p class="empty">Loading…</p>
  {:else}
    <div class="band-table">
      <div class="band-row band-header">
        <span>Min %</span>
        <span>Grade point</span>
        <span>Label</span>
        <span></span>
      </div>
      {#each sortedBands as band (band)}
        {@const idx = bands.indexOf(band)}
        <div class="band-row">
          <input type="number" min="0" max="100" step="1" bind:value={band.minPercent} />
          <input type="number" min="0" step="0.1" bind:value={band.gradePoint} />
          <input type="text" placeholder="e.g. A+" bind:value={band.label} />
          <button class="icon-btn danger" title="Remove band" onclick={() => removeBand(idx)}>
            <Trash2 size={14} />
          </button>
        </div>
      {/each}
    </div>

    <div class="actions">
      <button class="ghost-btn" onclick={addBand} disabled={working}>
        <Plus size={14} /> Add band
      </button>
      <div class="spacer"></div>
      {#if validationError}
        <span class="err">{validationError}</span>
      {/if}
      <button class="primary-btn" onclick={save} disabled={working || !!validationError}>
        Save
      </button>
    </div>
    <p class="hint">
      A mark earns the grade point of the highest band whose Min % it reaches. A
      band at 0% is required so every mark maps to a grade point.
    </p>
  {/if}
</section>

<style>
  .grade-scale {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    margin-bottom: 24px;
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
  }
  .title {
    display: flex;
    gap: 10px;
  }
  .title :global(svg) {
    color: var(--accent);
    margin-top: 2px;
  }
  h2 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 650;
    color: var(--text-main);
  }
  .sub {
    margin: 2px 0 0;
    font-size: var(--text-md);
    color: var(--text-secondary);
  }
  .empty {
    color: var(--text-muted);
    font-size: var(--text-md);
  }
  .band-table {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .band-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1.4fr 40px;
    gap: 8px;
    align-items: center;
  }
  .band-header {
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    font-weight: 600;
  }
  .band-row input {
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 7px 9px;
    color: var(--text-main);
    font-size: var(--text-md);
  }
  .band-row input:focus {
    border-color: var(--border-strong, var(--accent));
    outline: none;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
  }
  .spacer {
    flex: 1;
  }
  .err {
    color: var(--color-danger, var(--atlas-bad));
    font-size: var(--text-md);
    text-align: right;
  }
  .hint {
    margin: 12px 0 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .primary-btn {
    background: var(--accent);
    color: var(--atlas-on-fill);
    border: none;
    border-radius: var(--radius-md);
    padding: 8px 16px;
    font-size: var(--text-md);
    font-weight: 600;
    cursor: pointer;
  }
  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ghost-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 7px 12px;
    color: var(--text-secondary);
    font-size: var(--text-md);
    cursor: pointer;
  }
  .ghost-btn:hover:not(:disabled) {
    color: var(--text-main);
    border-color: var(--border-strong, var(--accent));
  }
  .ghost-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 6px;
    border-radius: var(--radius-md);
  }
  .icon-btn.danger:hover {
    color: var(--color-danger, var(--atlas-bad));
    background: var(--bg-main);
  }
</style>
