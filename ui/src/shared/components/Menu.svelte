<script>
  // Atlas §14 — the row-overflow menu primitive.
  //
  // Dense surfaces (saved places, runs, library tables) each need the same
  // thing: one primary action visible, every other action one click away
  // without stacking eight buttons into a row. This is that mechanism.
  //
  // Owned behaviours (the parts that are product behaviour, not styling):
  //   * `aria-haspopup="menu"` / `aria-expanded` on the trigger, real
  //     `role="menu"` + `role="menuitem"` on the popover.
  //   * Arrow keys, Home/End move within the menu; Escape closes and returns
  //     focus to the trigger so a keyboard user is never stranded.
  //   * Pointer-down outside closes. `pointerdown` rather than `click` so the
  //     menu is gone before the click lands on whatever is underneath.
  //   * The menu is rendered next to the trigger, so it scrolls with its row.

  import { MoreHorizontal } from "lucide-svelte";
  import { onDestroy, tick } from "svelte";

  /**
   * @type {{
   *   label?: string,
   *   items?: Array<{id?: string, label?: string, danger?: boolean,
   *                  disabled?: boolean, separator?: boolean,
   *                  onselect?: () => void}>,
   *   align?: "start" | "end",
   *   icon?: any,
   *   size?: number,
   *   variant?: string,
   *   onOpenChange?: (open: boolean) => void,
   * }}
   */
  let {
    label = "More actions",
    items = [],
    align = "end",
    icon: Icon = MoreHorizontal,
    size = 14,
    variant = "ghost",
    onOpenChange = () => {},
  } = $props();

  let open = $state(false);
  let root = $state(null);
  let menuEl = $state(null);
  let triggerEl = $state(null);

  const actionable = () =>
    items.filter((it) => !it.separator && !it.disabled);

  function close(refocus = false) {
    if (open) {
      open = false;
      onOpenChange(false);
    }
    if (refocus) triggerEl?.focus();
  }

  function toggle() {
    open = !open;
    onOpenChange(open);
  }

  onDestroy(() => {
    // The native page is globally occluded while this popover is open. If its
    // pane unmounts during a context switch, release that occlusion as well.
    if (open) onOpenChange(false);
  });

  function move(from, delta) {
    const list = actionable();
    if (list.length === 0) return;
    const nodes = [...(menuEl?.querySelectorAll('[role="menuitem"]:not([disabled])') ?? [])];
    const i = nodes.indexOf(from);
    const next = nodes[(i + delta + nodes.length) % nodes.length];
    next?.focus();
  }

  $effect(() => {
    if (!open) return;
    tick().then(() => {
      const first = menuEl?.querySelector('[role="menuitem"]:not([disabled])');
      first?.focus();
    });

    const onDown = (e) => {
      if (root && !root.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  });

  function choose(item) {
    close();
    item.onselect?.();
  }
</script>

<div class="menu" bind:this={root}>
  <button
    type="button"
    class="cf-btn {variant} icon"
    bind:this={triggerEl}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    title={label}
    onclick={toggle}
  >
    <Icon size={size} strokeWidth={2} aria-hidden="true" />
  </button>

  {#if open}
    <div class="menu-pop" class:align-end={align === "end"} role="menu" aria-label={label} bind:this={menuEl}>
      {#each items as item, i (item.id ?? i)}
        {#if item.separator}
          <div class="atl-rule" role="separator"></div>
        {:else}
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            class:danger={item.danger}
            disabled={item.disabled}
            onclick={() => choose(item)}
            onkeydown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); move(e.currentTarget, 1); }
              else if (e.key === "ArrowUp") { e.preventDefault(); move(e.currentTarget, -1); }
              else if (e.key === "Home") {
                e.preventDefault();
                menuEl?.querySelector('[role="menuitem"]:not([disabled])')?.focus();
              } else if (e.key === "End") {
                e.preventDefault();
                const nodes = menuEl?.querySelectorAll('[role="menuitem"]:not([disabled])');
                nodes?.[nodes.length - 1]?.focus();
              }
            }}
          >
            {item.label}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu {
    position: relative;
    display: inline-flex;
  }

  .cf-btn.icon {
    width: var(--ctl-h);
    padding: 0;
  }

  .menu-pop {
    position: absolute;
    top: calc(100% + 4px);
    min-width: 168px;
    z-index: var(--z-overlay);
    padding: var(--space-1);
    background: var(--atlas-raise);
    border: 1px solid var(--atlas-line-2);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2), var(--lift);
    display: flex;
    flex-direction: column;
  }

  .menu-pop.align-end {
    right: 0;
  }

  .menu-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 7px var(--space-2);
    border-radius: var(--radius-xs);
    font-size: var(--text-md);
    color: var(--atlas-ink);
    background: none;
    border: 0;
    cursor: pointer;
    white-space: nowrap;
  }

  .menu-item:hover:not(:disabled),
  .menu-item:focus-visible {
    background: var(--atlas-wash-2);
  }

  .menu-item.danger {
    color: var(--atlas-bad);
  }

  .menu-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
