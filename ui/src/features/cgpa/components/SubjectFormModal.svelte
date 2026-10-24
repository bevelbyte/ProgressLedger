<script>
  // Presentational subject add/edit modal. Owns its own form fields; validation
  // is delegated to the pure validateSubjectForm helper. Emits normalized values.
  import { validateSubjectForm } from "../cgpa-view.js";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { Modal } from "../../../shared/components";

  let { open = false, editing = null, onSave, onClose } = $props();

  let name = $state("");
  let code = $state("");
  let obtained = $state(null);
  let max = $state(null);
  let credits = $state(null);

  $effect(() => {
    if (open) {
      name = editing?.name ?? "";
      code = editing?.code ?? "";
      obtained = editing?.marksObtained ?? null;
      max = editing?.maxMarks ?? null;
      credits = editing?.credits ?? null;
    }
  });

  function submit() {
    const result = validateSubjectForm({ name, obtainedRaw: obtained, maxRaw: max, creditsRaw: credits });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSave?.({ name: name.trim(), code: code.trim() || null, ...result.value });
  }
</script>

<Modal
  {open}
  title={editing ? "Edit subject" : "Add subject"}
  subtitle="Marks are optional — a subject can exist before it is graded."
  width={480}
  onClose={onClose}
>
  {#snippet children()}
    <form class="subject-form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label class="field">
        <span class="atl-label">Subject name</span>
        <input class="cf-input" type="text" bind:value={name} placeholder="e.g. Engineering Mathematics I" />
      </label>
      <label class="field">
        <span class="atl-label">Subject code</span>
        <input class="cf-input" type="text" bind:value={code} placeholder="e.g. MATH-101 (optional)" />
      </label>
      <div class="dual-inputs">
        <label class="field">
          <span class="atl-label">Obtained Marks</span>
          <input class="cf-input" type="number" min="0" bind:value={obtained} />
        </label>
        <label class="field">
          <span class="atl-label">Max Marks</span>
          <input class="cf-input" type="number" min="1" bind:value={max} />
        </label>
      </div>
      <label class="field">
        <span class="atl-label">Credits</span>
        <input class="cf-input" type="number" min="0" step="0.5" bind:value={credits} placeholder="e.g. 4" />
      </label>
      <div class="form-actions">
        <button type="button" class="minimal-btn" onclick={onClose}>Cancel</button>
        <button type="submit" class="minimal-btn primary-btn">Save</button>
      </div>
    </form>
  {/snippet}
</Modal>

<style>
  .subject-form { display: flex; flex-direction: column; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .dual-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
  .form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }

  /* Class names are a functional contract (e2e/subject-rename.spec.js drives
     `button.minimal-btn.primary-btn`), so they stay — only the styling is Atlas. */
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
