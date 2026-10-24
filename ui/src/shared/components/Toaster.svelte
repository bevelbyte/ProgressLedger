<script>
  // Single global host for toasts + the confirm modal. Mount ONCE (in App.svelte).
  import { X, CircleCheck, Info, TriangleAlert, CircleX } from "lucide-svelte";
  import { toastState, dismissToast } from "../stores/toasts.svelte.js";

  // Real icons, not text glyphs: a unicode tick renders in whatever font the
  // OS picks, at whatever weight and baseline that font has, so four toasts in
  // a column looked like four different products' notifications.
  const ICONS = {
    success: CircleCheck,
    error: CircleX,
    warning: TriangleAlert,
    info: Info,
  };

  function resolveConfirm(value) {
    toastState.confirm?.resolve(value);
  }

  // Esc cancels the confirm dialog.
  $effect(() => {
    function onKey(e) {
      if (e.key === "Escape" && toastState.confirm) resolveConfirm(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<!-- ===== Toast stack ===== -->
<div class="toast-stack" role="region" aria-live="polite" aria-label="Notifications">    {#each toastState.items as t (t.id)}
      {@const Icon = ICONS[t.type] ?? ICONS.info}
      <div class="toast {t.type}" role="alert">
        <span class="icon"><Icon size={14} strokeWidth={2} aria-hidden="true" /></span>
      <div class="content">
        {#if t.title}<div class="title">{t.title}</div>{/if}
        {#if t.message}<div class="msg">{t.message}</div>{/if}
      </div>
      <button class="close" aria-label="Dismiss" title="Dismiss" onclick={() => dismissToast(t.id)}
        ><X size={12} strokeWidth={2} aria-hidden="true" /></button>
    </div>
  {/each}
</div>

<!-- ===== Confirm modal ===== -->
{#if toastState.confirm}
  <div
    class="cf-backdrop"
    role="button"
    tabindex="0"
    aria-label="Cancel confirmation"
    onclick={() => resolveConfirm(false)}
    onkeydown={(e) => (e.key === "Enter" || e.key === " ") && resolveConfirm(false)}
  >
    <div
      class="cf-modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <h3>{toastState.confirm.title}</h3>
      {#if toastState.confirm.message}<p>{toastState.confirm.message}</p>{/if}
      <div class="cf-btns">
        <button class="ghost" onclick={() => resolveConfirm(false)}>
          {toastState.confirm.cancelLabel}
        </button>
        <button
          class={toastState.confirm.danger ? "danger" : "primary"}
          onclick={() => resolveConfirm(true)}
        >
          {toastState.confirm.confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .toast-stack {
    position: fixed;
    /* Clear the 26px status bar with the same 16px gap: at bottom 16px
       the stack painted over the bar (it covered the CTRL K readout). */
    bottom: calc(var(--shell-status-h) + 16px);
    right: 16px;
    /* Above every feature overlay (Focus / QuickNote use 1200): a feedback toast
       fired while an overlay is open would otherwise be painted underneath it. */
    z-index: 1400;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: min(380px, calc(100vw - 32px));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: var(--radius-md);
    padding: 11px 12px;
    box-shadow: var(--shadow-2);
    color: var(--fg);
    animation: cf-in 0.16s ease-out;
  }
  @keyframes cf-in {
    from { opacity: 0; transform: translateX(12px); }
    to { opacity: 1; transform: translateX(0); }
  }
  .toast.success { border-left-color: var(--success); }
  .toast.error { border-left-color: var(--danger); }
  .toast.warning { border-left-color: var(--warning); }
  .toast.info { border-left-color: var(--accent); }

  .icon { font-size: var(--text-md); line-height: 1.4; flex: none; width: 16px; text-align: center; }
  .toast.success .icon { color: var(--success); }
  .toast.error .icon { color: var(--danger); }
  .toast.warning .icon { color: var(--warning); }
  .toast.info .icon { color: var(--accent-strong); }

  .content { flex: 1; min-width: 0; }
  .title { font-weight: 600; font-size: var(--text-md); }
  .msg { font-size: var(--text-sm); color: var(--fg-secondary); margin-top: 2px; line-height: 1.4; word-wrap: break-word; }
  .close {
    flex: none;
    background: none;
    border: none;
    color: var(--fg-muted);
    cursor: pointer;
    font-size: var(--text-sm);
    padding: 0 2px;
    line-height: 1.4;
  }
  .close:hover { color: var(--fg); }

  .cf-backdrop {
    position: fixed;
    inset: 0;
    background: var(--atlas-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    /* Above every feature overlay (Focus / QuickNote use 1200). A confirm
       prompt must always be clickable: at 1100 it rendered *under* the Focus
       backdrop, so the click hit the backdrop, re-entered discard(), and the
       superseded prompt was resolved as "no" — the session could never be
       ended. */
    z-index: 1300;
  }
  .cf-modal {
    width: min(420px, 92vw);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    box-shadow: var(--shadow-3);
  }
  .cf-modal h3 { margin: 0 0 8px; font-size: var(--text-xl); font-weight: 650; color: var(--fg); }
  .cf-modal p { margin: 0 0 18px; font-size: var(--text-md); color: var(--fg-secondary); line-height: 1.5; }
  .cf-btns { display: flex; justify-content: flex-end; gap: 8px; }
  .cf-btns button { border-radius: var(--radius-md); padding: 8px 16px; cursor: pointer; font-size: var(--text-md); font-weight: 500; transition: var(--trans-fast); }
  .ghost { background: transparent; border: 1px solid var(--border); color: var(--fg-secondary); }
  .ghost:hover { border-color: var(--border-strong); color: var(--fg); background: var(--bg-hover); }
  .primary { background: var(--accent); border: none; color: var(--accent-ink); font-weight: 600; }
  .primary:hover { background: var(--accent-strong); }
  .danger { background: var(--danger-bg); border: 1px solid transparent; color: var(--danger); font-weight: 600; }
  .danger:hover { background: var(--atlas-bad-bg); }
</style>
