<script>
  // Presentational degree add/edit modal. Owns its own form field state;
  // emits the collected values via onSave. No persistence or domain logic here.
  import { Modal } from "../../../shared/components";

  let { open = false, editing = null, onSave, onClose } = $props();

  let name = $state("");
  let specialization = $state("");
  let semestersCount = $state(null);

  // Re-seed fields whenever the modal opens or the target changes.
  $effect(() => {
    if (open) {
      name = editing?.name ?? "";
      specialization = editing?.specialization ?? "";
      semestersCount = editing ? (editing.semestersCount || editing.semesters.length) : null;
    }
  });

  function submit() {
    onSave?.({
      name: name.trim(),
      specialization: specialization.trim(),
      semestersCount: semestersCount,
    });
  }
</script>

<Modal
  {open}
  title={editing ? "Edit degree" : "Add degree"}
  subtitle="A degree is the container every semester and subject lives in."
  width={480}
  onClose={onClose}
>
  {#snippet children()}
    <form class="degree-form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label class="field">
        <span class="atl-label">Degree title</span>
        <input class="cf-input" type="text" bind:value={name} placeholder="e.g. B.Tech" />
      </label>
      <label class="field">
        <span class="atl-label">Specialization</span>
        <input class="cf-input" type="text" bind:value={specialization} placeholder="e.g. Computer Science & Engineering" />
      </label>
      <label class="field">
        <span class="atl-label">Semesters</span>
        <input class="cf-input" type="number" min="1" max="12" bind:value={semestersCount} placeholder="e.g. 8" disabled={!!editing} />
      </label>
      <div class="form-actions">
        <button type="button" class="minimal-btn" onclick={onClose}>Cancel</button>
        <button type="submit" class="minimal-btn primary-btn">{editing ? "Save" : "Create"}</button>
      </div>
    </form>
  {/snippet}
</Modal>

<style>
  .degree-form { display: flex; flex-direction: column; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }

  /* Kept by contract: the Degree dialogs share the planner's button classes. */
  .minimal-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--ctl-h);
    padding: 0 14px;
    border-radius: var(--radius-md);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
    cursor: pointer;
  }
  .minimal-btn:hover { border-color: var(--atlas-line-2); color: var(--atlas-ink); }
  .primary-btn {
    background: var(--atlas-signal);
    border-color: var(--atlas-signal);
    color: var(--atlas-signal-ink);
    font-weight: 600;
  }
  .primary-btn:hover { background: var(--atlas-signal-2); color: var(--atlas-signal-ink); }
</style>
