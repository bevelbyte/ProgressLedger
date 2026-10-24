<script>
  // Atlas §24 — the dialog primitive.
  //
  // One dialog, one shape, used by every surface that needs to interrupt: a
  // centred panel on the void backdrop, a header that states what it is, a body
  // that scrolls independently, and a footer whose primary action is rightmost.
  //
  // Behaviours that are easy to get wrong and are therefore owned here rather
  // than re-implemented per surface:
  //   * Escape closes, and the event is stopped so the shell does not see it
  //     as "close the next layer" too.
  //   * Clicking the backdrop closes; clicking inside does not.
  //   * Focus moves into the dialog on open and returns to whatever held it
  //     before on close, so a keyboard user is never stranded at the top of
  //     the document.
  //   * The destructive action is never the default focus.

  import { X } from "lucide-svelte";

  let {
    open = false,
    title = "",
    subtitle = "",
    width = 520,
    onClose = () => {},
    children = null,
    footer = null,
  } = $props();

  let panelEl = $state(null);

  $effect(() => {
    if (!open) return;
    const previous = document.activeElement;
    panelEl?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={onClose} role="presentation">
    <div
      class="modal-panel"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      bind:this={panelEl}
      style:width="{width}px"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="modal-head">
        <div class="modal-head-text">
          <h2>{title}</h2>
          {#if subtitle}<p class="modal-sub">{subtitle}</p>{/if}
        </div>
        <button
          type="button"
          class="cf-btn ghost sm"
          onclick={onClose}
          aria-label="Close dialog"
          title="Close (Esc)"
        >
          <X size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <div class="modal-body">
        {#if children}{@render children()}{/if}
      </div>

      {#if footer}
        <footer class="modal-foot">{@render footer()}</footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-dialog);
    background: var(--atlas-scrim);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }

  .modal-panel {
    max-width: min(100%, 680px);
    max-height: 78vh;
    display: flex;
    flex-direction: column;
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line-2);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-3), var(--lift);
    overflow: hidden;
    animation: modal-in var(--dur-slow) var(--ease);
  }

  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .modal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-4) var(--space-3);
    border-bottom: 1px solid var(--atlas-line);
  }

  .modal-head-text {
    min-width: 0;
  }

  .modal-head h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }

  .modal-sub {
    margin-top: 2px;
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
  }

  .modal-body {
    padding: var(--space-4);
    overflow-y: auto;
  }

  /* Actions are right-aligned with the primary action last, so the
     "commit" position is the same in every dialog in the product. */
  .modal-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--atlas-line);
    background: var(--atlas-chrome);
  }
</style>
