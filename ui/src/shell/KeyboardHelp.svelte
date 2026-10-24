<script>
  // Atlas shell — the global keyboard reference.
  //
  // Opened with `?` from anywhere that is not a text field. This is the shell's
  // copy of the shortcut map; Project Mode keeps its own, more detailed
  // `KeybindingsHelp` for chords that only exist inside the Runs console.
  //
  // The reference is grouped by *scope*, not alphabetically, because the useful
  // question is never "what does Ctrl+1 do" — it is "what can I do right now,
  // from here". Every group below is answerable from anywhere in the app, which
  // is why nothing here is view-local.

  import { X } from "lucide-svelte";

  let { open = false, onClose = () => {} } = $props();

  let dialogEl = $state(null);

  const GROUPS = [
    {
      id: "command",
      label: "Command",
      rows: [
        { keys: ["Ctrl", "K"], what: "Search everything, or run a command" },
        { keys: ["Alt", "N"], what: "Quick note, filed to a subject" },
        { keys: ["Esc"], what: "Close the topmost layer" },
      ],
    },
    {
      id: "navigate",
      label: "Navigate",
      rows: [
        { keys: ["Ctrl", "1…9"], what: "Jump to the Nth destination on the rail" },
        { keys: ["Ctrl", "B"], what: "Cycle the rail: labels, counts, icons" },
        { keys: ["Ctrl", "Alt", "←/→"], what: "Switch working context" },
        { keys: ["Ctrl", "Alt", "↑/↓"], what: "Move focus between panes" },
        { keys: ["Ctrl", "\\"], what: "Split the focused pane side by side" },
        { keys: ["Ctrl", "Alt", "\\"], what: "Split the focused pane top and bottom" },
        { keys: ["Ctrl", "Shift", "T"], what: "Reopen the most recently closed tab" },
        { keys: ["Ctrl", "Shift", "E"], what: "Immerse: hide the workspace chrome" },
        { keys: ["?"], what: "This reference" },
      ],
    },
    {
      id: "operator",
      label: "Operator",
      rows: [
        { keys: ["Ctrl", "Shift", "A"], what: "Open the operator console" },
        { keys: ["a"], what: "Allow the focused approval (in the console)" },
        { keys: ["d"], what: "Deny the focused approval (in the console)" },
      ],
    },
  ];

  // Escape closes; focus moves into the dialog on open and returns to whatever
  // held it before on close, so `?` never strands keyboard focus.
  $effect(() => {
    if (!open) return;
    const previous = document.activeElement;
    dialogEl?.focus();
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
  <div class="kbd-backdrop" onclick={onClose} role="presentation">
    <div
      class="kbd-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-title"
      tabindex="-1"
      bind:this={dialogEl}
      onclick={(e) => e.stopPropagation()}
    >
      <header class="kbd-head">
        <div>
          <h2 id="kbd-title">Keyboard</h2>
          <p class="kbd-sub">Every chord below works from anywhere in CareerFlow.</p>
        </div>
        <button type="button" class="cf-btn ghost sm" onclick={onClose} aria-label="Close keyboard reference" title="Close (Esc)">
          <X size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <div class="kbd-body">
        {#each GROUPS as group (group.id)}
          <section class="kbd-group">
            <p class="atl-label">{group.label}</p>
            <ul class="kbd-rows">
              {#each group.rows as row (row.what)}
                <li class="kbd-row">
                  <span class="kbd-what">{row.what}</span>
                  <span class="kbd-keys">
                    {#each row.keys as k (k)}
                      <kbd class="cf-kbd">{k}</kbd>
                    {/each}
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .kbd-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-dialog);
    background: var(--atlas-scrim);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 14vh;
  }

  .kbd-dialog {
    width: 100%;
    max-width: 520px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line-2);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-3), var(--lift);
    overflow: hidden;
    animation: kbd-in var(--dur-slow) var(--ease);
  }

  @keyframes kbd-in {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .kbd-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-4) var(--space-3);
    border-bottom: 1px solid var(--atlas-line);
  }

  .kbd-head h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }

  .kbd-sub {
    margin-top: 2px;
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
  }

  .kbd-body {
    padding: var(--space-3) var(--space-4) var(--space-4);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .kbd-rows {
    list-style: none;
  }

  /* Hairlines, not cards: this is a dense reference list. */
  .kbd-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: var(--row-h);
  }

  .kbd-row + .kbd-row {
    border-top: 1px solid var(--atlas-line);
  }

  .kbd-what {
    font-size: var(--text-md);
    color: var(--atlas-ink-2);
  }

  .kbd-keys {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
  }
</style>
