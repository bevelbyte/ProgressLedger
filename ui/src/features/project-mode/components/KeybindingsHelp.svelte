<script>
  // KeybindingsHelp — a modal overlay listing all keyboard shortcuts in Project Mode.
  // Triggered by Cmd+/ or ? (wired by the parent ProjectModePanel).
  import { X } from "lucide-svelte";

  let { onClose } = $props();

  const shortcuts = [
    { action: "Open command palette", shortcut: "Cmd+K" },
    { action: "Show keybindings help", shortcut: "Cmd+/" },
    { action: "Show keybindings help", shortcut: "?" },
    { action: "Close modal / cancel", shortcut: "Esc" },
    { action: "Navigate palette results", shortcut: "↑ / ↓" },
    { action: "Select in palette / Submit", shortcut: "Enter" },
  ];

  function close() {
    onClose?.();
  }
</script>

<!-- Backdrop — click outside closes -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={close} role="presentation">
  <div
    class="modal"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    tabindex="-1"
    data-testid="keybindings-modal"
  >
    <header class="modal-header" data-testid="keybindings-header">
      <h3>Keyboard Shortcuts</h3>
      <button class="close-btn" onclick={close} data-testid="keybindings-close" aria-label="Close">
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </header>

    <div class="modal-body">
      <table class="shortcuts-table">
        <thead>
          <tr>
            <th>Action</th>
            <th>Shortcut</th>
          </tr>
        </thead>
        <tbody>
          {#each shortcuts as row}
            <tr>
              <td class="action-cell">{row.action}</td>
              <td class="shortcut-cell">
                {#each row.shortcut.split(" / ") as key, i}
                  {#if i > 0}<span class="sep"> / </span>{/if}
                  <kbd data-testid="keybinding-key">{key.trim()}</kbd>
                {/each}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: var(--atlas-scrim);
    backdrop-filter: blur(4px);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
  }

  .modal {
    width: min(520px, 90vw);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl);
    box-shadow: 0 16px 48px var(--atlas-scrim);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 70vh;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
  }

  .modal-header h3 {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text-main);
    margin: 0;
  }

  .close-btn {
    font-size: var(--text-md);
    color: var(--text-muted);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    transition: color var(--trans-fast), border-color var(--trans-fast);
  }

  .close-btn:hover {
    color: var(--text-main);
    border-color: var(--border-strong);
  }

  .modal-body {
    overflow-y: auto;
    padding: 12px 0;
  }

  .shortcuts-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-lg);
  }

  .shortcuts-table th {
    text-align: left;
    padding: 6px 20px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
    border-bottom: 1px solid var(--border);
  }

  .shortcuts-table td {
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  .shortcuts-table tr:last-child td {
    border-bottom: none;
  }

  .action-cell {
    color: var(--text-secondary);
  }

  .shortcut-cell {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  kbd {
    display: inline-block;
    background: var(--surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--accent);
    font-weight: 500;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  .sep {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
</style>
