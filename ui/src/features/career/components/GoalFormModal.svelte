<script>
  // Presentational goal add/edit dialog. Owns its form fields; emits values.
  //
  // Now built on the shared Modal (§24) instead of a private overlay: focus
  // restore, Escape handling and footer order are product behaviour, and a
  // hand-rolled copy of them is how a dialog ends up focusing "Delete" first.

  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import Modal from "../../../shared/components/Modal.svelte";

  let { open = false, editing = null, onSave, onClose } = $props();

  let title = $state("");
  let targetRole = $state("");
  let domain = $state("");
  let description = $state("");
  let targetDate = $state("");
  let status = $state("active");

  $effect(() => {
    if (open) {
      title = editing?.title ?? "";
      targetRole = editing?.targetRole ?? "";
      domain = editing?.domain ?? "";
      description = editing?.description ?? "";
      targetDate = editing?.targetDate ?? "";
      status = editing?.status ?? "active";
    }
  });

  function submit() {
    if (!title.trim()) {
      toast.error("Goal title is required.");
      return;
    }
    onSave?.({
      title: title.trim(),
      targetRole: targetRole.trim() || null,
      domain: domain.trim() || null,
      description: description.trim() || null,
      targetDate: targetDate || null,
      status,
    });
  }
</script>

<Modal
  {open}
  title={editing ? "Edit career goal" : "Add career goal"}
  subtitle="Where you are heading. Milestones turn it into a path."
  width={540}
  {onClose}
>
  {#snippet children()}
    <form class="form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label class="field">
        <span class="atl-label">Goal title *</span>
        <input class="cf-input" type="text" bind:value={title} placeholder="e.g. Become a Backend Engineer" />
      </label>

      <div class="row">
        <label class="field">
          <span class="atl-label">Target role</span>
          <input class="cf-input" type="text" bind:value={targetRole} placeholder="e.g. Backend Engineer" />
        </label>
        <label class="field">
          <span class="atl-label">Domain</span>
          <input class="cf-input" type="text" bind:value={domain} placeholder="e.g. Fintech" />
        </label>
      </div>

      <label class="field">
        <span class="atl-label">Description</span>
        <textarea class="cf-textarea" rows="3" bind:value={description} placeholder="What does this goal mean to you?"></textarea>
      </label>

      <div class="row">
        <label class="field">
          <span class="atl-label">Target date</span>
          <input class="cf-input" type="date" bind:value={targetDate} />
        </label>
        {#if editing}
          <label class="field">
            <span class="atl-label">Status</span>
            <select class="cf-select" bind:value={status}>
              <option value="active">Active</option>
              <option value="achieved">Achieved</option>
              <option value="paused">Paused</option>
            </select>
          </label>
        {/if}
      </div>

      <div class="actions">
        <button type="button" class="cf-btn ghost sm" onclick={onClose}>Cancel</button>
        <button type="submit" class="cf-btn primary sm">{editing ? "Save" : "Create goal"}</button>
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

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--atlas-line);
  }

  @media (max-width: 620px) {
    .row { grid-template-columns: 1fr; }
  }
</style>
