<script>
  // Presentational milestone add/edit dialog, on the shared Modal (§24).

  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import Modal from "../../../shared/components/Modal.svelte";

  let { open = false, editing = null, onSave, onClose } = $props();

  let title = $state("");
  let description = $state("");
  let targetDate = $state("");

  $effect(() => {
    if (open) {
      title = editing?.title ?? "";
      description = editing?.description ?? "";
      targetDate = editing?.targetDate ?? "";
    }
  });

  function submit() {
    if (!title.trim()) {
      toast.error("Milestone title is required.");
      return;
    }
    onSave?.({ title: title.trim(), description: description.trim() || null, targetDate: targetDate || null });
  }
</script>

<Modal
  {open}
  title={editing ? "Edit milestone" : "Add milestone"}
  subtitle="One verifiable step toward the goal."
  width={500}
  {onClose}
>
  {#snippet children()}
    <form class="form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label class="field">
        <span class="atl-label">Milestone title *</span>
        <input class="cf-input" type="text" bind:value={title} placeholder="e.g. Complete a backend project" />
      </label>

      <label class="field">
        <span class="atl-label">Description</span>
        <textarea class="cf-textarea" rows="3" bind:value={description} placeholder="Optional detail"></textarea>
      </label>

      <label class="field">
        <span class="atl-label">Target date</span>
        <input class="cf-input" type="date" bind:value={targetDate} />
      </label>

      <div class="actions">
        <button type="button" class="cf-btn ghost sm" onclick={onClose}>Cancel</button>
        <button type="submit" class="cf-btn primary sm">{editing ? "Save" : "Add milestone"}</button>
      </div>
    </form>
  {/snippet}
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--atlas-line);
  }
</style>
