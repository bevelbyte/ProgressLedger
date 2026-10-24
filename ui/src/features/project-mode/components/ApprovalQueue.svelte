<script>
  // ApprovalQueue — panel showing pending tool calls awaiting user
  // approval. Reads from the reactive `projectModeStore.pendingApprovals`
  // so it updates automatically when the agent loop emits an
  // `AGENT_APPROVAL_REQUIRED` event (once the main-process bridge is
  // wired). Each row shows the tool name, permission level, truncated
  // arguments (click to expand), and Approve / Deny actions.

  import { projectModeStore, resolveApprovalRequest } from "../stores/projectMode.svelte.js";
  import { projectModeService } from "../services/projectMode.service.js";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null, agentId = null } = $props();

  // Busy state per approval id so buttons show a loading spinner while
  // the IPC call is in flight. Multiple concurrent resolutions are
  // possible if the user rapid-fires clicks.
  let busy = $state({});

  function ensureId(req) {
    // The store's pushApprovalRequest does not generate an id. Fall back
    // to a deterministic one derived from toolName + requestedAt so
    // resolveApprovalRequest can still find the entry.
    if (req.id != null) return req.id;
    return `${req.toolName || "unknown"}-${req.requestedAt || Date.now()}`;
  }

  // Plain-language gloss for the permission being requested. Kept in step with
  // the global Operator Console (ui/src/shell/OperatorConsole.svelte) so the
  // user reads the same sentence wherever the decision is made.
  const PERMISSION_GLOSS = {
    READ: "read project data",
    WRITE: "write files or state",
    EXECUTE: "run a command",
    NETWORK: "reach the network",
    DESTRUCTIVE: "destroy data",
  };

  function permissionGloss(permission) {
    if (!permission) return "perform a privileged action of undeclared kind";
    return PERMISSION_GLOSS[String(permission).toUpperCase()] || "perform a privileged action";
  }

  async function approve(req) {
    const id = ensureId(req);
    if (busy[id]) return;
    busy = { ...busy, [id]: true };
    try {
      // The main-process approval resolver is authoritative. Do not remove
      // the UI row until IPC confirms the decision; otherwise a transient
      // IPC failure leaves the agent blocked while the UI falsely reports
      // that the tool was approved.
      const result = await projectModeService.approveCall(profileId, agentId, id);
      if (!result || result.ok === false) {
        throw new Error((result && (result.error || result.reason)) || "Approval IPC failed");
      }
      resolveApprovalRequest(id, "approved");
      toast.success(`Tool "${req.toolName}" approved.`);
    } catch (e) {
      reportError(e, "Could not approve tool");
    } finally {
      busy = { ...busy, [id]: false };
    }
  }

  async function deny(req) {
    const id = ensureId(req);
    if (busy[id]) return;
    busy = { ...busy, [id]: true };
    try {
      const result = await projectModeService.denyCall(profileId, agentId, id);
      if (!result || result.ok === false) {
        throw new Error((result && (result.error || result.reason)) || "Deny IPC failed");
      }
      resolveApprovalRequest(id, "rejected");
      toast.info(`Tool "${req.toolName}" rejected.`);
    } catch (e) {
      reportError(e, "Could not deny tool");
    } finally {
      busy = { ...busy, [id]: false };
    }
  }

  function permissionClass(p) {
    if (!p) return "perm-unknown";
    return "perm-" + p.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  }
</script>

<section class="approval-queue" data-testid="approval-queue" data-count={projectModeStore.pendingApprovals.length}>
  <header class="panel-header">
    <h3>Approval queue</h3>
    <span class="badge" data-testid="approval-queue-count">
      {projectModeStore.pendingApprovals.length} pending
    </span>
  </header>

  {#if projectModeStore.pendingApprovals.length === 0}
    <div class="empty" data-testid="approval-queue-empty">
      No pending approvals.
    </div>
  {:else}
    <ul class="list" data-testid="approval-queue-list">
      {#each projectModeStore.pendingApprovals as req (ensureId(req))}
        {@const id = ensureId(req)}
        {@const isBusy = !!busy[id]}
        <li class="row" data-testid="approval-row" data-tool={req.toolName}>
          <div class="row-head">
            <span class="tool-name" data-testid="approval-tool-name">{req.toolName}</span>
            {#if req.permission}
              <span class={`perm ${permissionClass(req.permission)}`} data-testid="approval-permission">
                {req.permission}
              </span>
            {/if}
            <span class="time" data-testid="approval-time">
              {new Date(req.requestedAt || Date.now()).toLocaleTimeString()}
            </span>
          </div>

          <div class="args-section">
            <!--
              Arguments are NOT projected to the renderer. This is a
              main-process security boundary, not a display preference:
              `sanitizeApprovalEntry` (shell/src/security/project-mode-auth.js)
              strips `input` from every approval entry before it is sent, so
              `req.input` is always undefined here.

              The old control was a "Show arguments" disclosure that could only
              ever render the literal string "Arguments hidden for security"
              when collapsed and `{}` when expanded. docs/DESIGN-ATLAS.md
              explicitly calls that out as the Meridian behaviour Atlas
              replaced: *"Meridian hid this behind 'Arguments hidden for
              security', which told the user nothing; Atlas states the
              permission in words and sends them to the transcript for the
              payload."* The global Operator Console already implements that;
              this is the same statement, on the same decision.
            -->
            <p class="args-boundary" data-testid="approval-args-boundary">
              This call wants to <strong>{permissionGloss(req.permission)}</strong>.
              Arguments are not projected to the interface — read them in the run transcript.
            </p>
          </div>

          <div class="actions">
            <button
              class="btn btn-deny"
              onclick={() => deny(req)}
              disabled={isBusy}
              data-testid="approval-deny"
            >
              Deny
            </button>
            <button
              class="btn btn-approve"
              onclick={() => approve(req)}
              disabled={isBusy}
              data-testid="approval-approve"
            >
              {isBusy ? "…" : "Approve"}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .approval-queue {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    font-size: var(--text-md);
    color: var(--text-main);
  }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .panel-header h3 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
  }
  .badge {
    font-size: var(--text-xs);
    padding: 1px 8px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: var(--bg-main);
    font-variant-numeric: tabular-nums;
  }

  .empty {
    padding: 14px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    text-align: center;
    font-size: var(--text-md);
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-main);
  }
  .row-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .tool-name {
    font-family: ui-monospace, monospace;
    font-weight: 600;
    font-size: var(--text-md);
    color: var(--text-main);
  }
  .perm {
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .perm-EXECUTE { color: var(--atlas-bad); border-color: var(--atlas-bad); }
  .perm-WRITE { color: var(--atlas-signal); border-color: var(--atlas-signal); }
  .perm-NETWORK { color: var(--atlas-signal); border-color: var(--atlas-signal); }
  .perm-DESTRUCTIVE { color: var(--atlas-bad); border-color: var(--atlas-bad); background: var(--atlas-bad-bg); }
  .perm-READ { color: var(--atlas-signal); border-color: var(--atlas-signal); }
  .time {
    margin-left: auto;
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .args-section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .args-boundary {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
    line-height: 1.45;
  }
  .args-boundary strong {
    color: var(--text-main);
    font-weight: 600;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .btn {
    padding: 4px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: var(--text-md);
    font-family: inherit;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-approve {
    background: var(--accent);
    color: var(--bg-main);
    border-color: var(--accent);
  }
  .btn-deny {
    background: transparent;
    color: var(--text-secondary);
  }
  .btn-deny:hover { border-color: var(--atlas-bad); color: var(--atlas-bad); }
</style>
