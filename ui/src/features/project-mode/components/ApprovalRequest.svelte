<script>
  // ApprovalRequest — modal the user sees when the agent needs a tool
  // that requires approval. The agent core emits a status; the IPC layer
  // mints an approval token via project:approve-tool once the user
  // clicks Approve. On Reject, the token is NOT minted and the agent
  // loop is told the user declined.

  import { projectModeService } from "../services/projectMode.service.js";
  import { projectModeStore, resolveApprovalRequest } from "../stores/projectMode.svelte.js";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null, onResolved = () => {} } = $props();

  let busy = $state(false);

  // The store has the queue; we show the first pending request.
  const request = $derived(projectModeStore.pendingApprovals[0] || null);

  async function approve() {
    if (!request) return;
    busy = true;
    // The decision is only resolved once the approval actually succeeded.
    // The previous `finally` block called `resolveApprovalRequest(id,
    // "approved")` UNCONDITIONALLY, so a failed approve (or a thrown error)
    // still removed the row from the store as "approved" while no token had
    // been minted and no tool had run — the agent stayed blocked on its
    // approval promise and the user believed it had been approved.
    let approved = false;
    try {
      const res = await projectModeService.approveTool(request.toolName, request.input || {});
      if (res && res.ok) {
        approved = true;
        // Re-invoke the tool with the freshly minted token. This drives
        // it through the IPC tool runtime once; the agent loop will pick
        // up the result via the live tool activity feed.
        const inv = await projectModeService.invokeTool(request.toolName, request.input || {}, {
          approvalToken: res.token,
        });
        if (inv && inv.ok) {
          toast.success("Tool approved and run.");
        } else {
          toast.warning("Approved, but tool failed: " + (inv && inv.error && inv.error.message || "unknown"));
        }
      } else {
        reportError(new Error("approve-tool failed"), "Could not approve tool");
      }
    } catch (e) {
      reportError(e, "Approval failed");
    } finally {
      busy = false;
      if (approved) {
        resolveApprovalRequest(request.id, "approved");
        onResolved();
      }
      // On failure the row stays in the queue so the user can retry or deny it.
    }
  }

  function reject() {
    if (!request) return;
    resolveApprovalRequest(request.id, "rejected");
    toast.info("Tool rejected.");
    onResolved();
  }
</script>

{#if request}
  <div class="backdrop" role="dialog" aria-modal="true" data-testid="approval-modal">
    <div class="modal">
      <h3>Approval required</h3>
      <p class="lead">The agent wants to run a tool that needs your sign-off.</p>
      <dl class="kv">
        <dt>Tool</dt><dd class="tool-name">{request.toolName}</dd>
        <dt>Permission</dt><dd>{request.permission || "—"}</dd>
        <dt>Input</dt><dd><pre>{JSON.stringify(request.input || {}, null, 2)}</pre></dd>
      </dl>
      <div class="actions">
        <button class="btn btn-ghost" onclick={reject} disabled={busy} data-testid="approval-reject">Reject</button>
        <button class="btn btn-primary" onclick={approve} disabled={busy} data-testid="approval-approve">
          {busy ? "Running…" : "Approve"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; background: var(--atlas-scrim);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .modal {
    background: var(--bg-main); color: var(--text-main);
    border: 1px solid var(--border); border-radius: var(--radius-lg);
    padding: 20px 24px; min-width: 360px; max-width: 540px;
    box-shadow: 0 8px 24px var(--atlas-scrim);
  }
  h3 { margin: 0 0 6px 0; }
  .lead { color: var(--text-secondary); margin: 0 0 12px 0; font-size: var(--text-lg); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0 0 16px 0; }
  .kv dt { color: var(--text-muted); font-size: var(--text-sm); text-transform: uppercase; }
  .kv dd { margin: 0; font-size: var(--text-lg); }
  .tool-name { font-family: ui-monospace, monospace; color: var(--accent); }
  .kv pre { background: var(--surface); padding: 8px; border-radius: var(--radius-sm); font-size: var(--text-sm); white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .btn { padding: 6px 14px; border-radius: var(--radius-md); border: 1px solid var(--border); cursor: pointer; font-size: var(--text-lg); }
  .btn-ghost { background: transparent; color: var(--text-secondary); }
  .btn-primary { background: var(--accent); color: var(--bg-main); border-color: var(--accent); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>