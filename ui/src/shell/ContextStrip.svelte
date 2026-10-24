<script>
  /**
   * Context strip — the workspace's top row.
   *
   * Adapted from the Space Bunny v2 context strip
   * (`CareerFlow-Frontend-Lab/v1/shots/regression-v2z/01-desk.png`): a row of
   * named working contexts, each carrying a live count, plus the arrangement and
   * split controls that reshape the stage. It answers "which body of work am I
   * in, and what is open in it" in one line.
   *
   * Deliberately NOT a second navigation surface: the chips switch context, they
   * do not list destinations. Destinations stay in the rail (a contract the E2E
   * suite drives) and in each pane's tabs.
   *
   * COUNTS ARE NOT IN `textContent`. The rail's labels are matched by anchored
   * regexes (`/^\s*Subjects\s*$/`), so counts are painted from `data-count` by a
   * pseudo-element — the same discipline NavRail already uses for its badges.
   */

  import { ARRANGEMENTS, ARRANGEMENT_LABELS } from "./workspace/model.js";

  let {
    contexts = [],
    activeId = null,
    counts = () => ({ panes: 1, tabs: 0 }),
    immersed = false,
    onSelect = () => {},
    onCreate = () => {},
    onDissolve = () => {},
    onArrange = () => {},
    onSplit = () => {},
    onToggleImmerse = () => {},
    /** Reports every open/close of the Arrange menu, so App can count it as an
     *  overlay that must hide the native browser views (Phase 2, D2-D6). */
    onArrangeOpenChange = () => {},
  } = $props();

  let arrangeOpen = $state(false);

  function setArrangeOpen(value) {
    arrangeOpen = value;
    onArrangeOpenChange?.(value);
  }

  function chooseArrange(arr) {
    setArrangeOpen(false);
    onArrange(arr);
  }
</script>

<div class="ctx-strip" role="tablist" aria-label="Working contexts">
  <div class="ctx-chips">
    {#each contexts as ctx (ctx.id)}
      <span class="ctx-chip-wrap" class:active={ctx.id === activeId}>
        <button
          type="button"
          role="tab"
          class="ctx-chip"
          data-ctx={ctx.name.toLowerCase()}
          aria-selected={ctx.id === activeId ? "true" : "false"}
          data-count={counts(ctx).tabs || undefined}
          title="{counts(ctx).panes} pane{counts(ctx).panes === 1 ? '' : 's'} · {counts(ctx).tabs} open"
          onclick={() => onSelect(ctx.id)}
        >
          {ctx.name}
        </button>
        {#if ctx.id === activeId && contexts.length > 1}
          <button
            type="button"
            class="ctx-dissolve"
            aria-label="Close context {ctx.name}"
            title="Close context"
            onclick={() => onDissolve(ctx.id)}
          >
            <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
              <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
            </svg>
          </button>
        {/if}
      </span>
    {/each}

    <button type="button" class="ctx-new" onclick={onCreate} aria-label="New context" title="New context">
      +
    </button>
  </div>

  <div class="ctx-tools">
    <div class="arrange">
      <button
        type="button"
        class="tool"
        aria-expanded={arrangeOpen}
        onclick={() => setArrangeOpen(!arrangeOpen)}
        title="Reshape this context from the tabs already open"
      >
        Arrange
      </button>
      {#if arrangeOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="menu"
          role="menu"
          tabindex="-1"
          onkeydown={(e) => e.key === "Escape" && setArrangeOpen(false)}
        >
          {#each ARRANGEMENTS as arr (arr)}
            <button type="button" role="menuitem" class="menu-item" onclick={() => chooseArrange(arr)}>
              {ARRANGEMENT_LABELS[arr]}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <button type="button" class="tool" onclick={() => onSplit("row")} title="Split the focused pane (Ctrl+\)">
      Split
    </button>
    <button
      type="button"
      class="tool"
      class:on={immersed}
      aria-pressed={immersed}
      onclick={onToggleImmerse}
      title="Hide the workspace chrome (Ctrl+Shift+E)"
    >
      Immerse
    </button>
    <span class="hint atl-label" aria-hidden="true">
      Ctrl+Alt+←/→ context · Ctrl+\ split
    </span>
  </div>
</div>

<style>
  .ctx-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    height: var(--shell-ctxstrip-h, 34px);
    flex: 0 0 var(--shell-ctxstrip-h, 34px);
    padding: 0 10px;
    background: var(--atlas-chrome);
    border-bottom: 1px solid var(--atlas-line);
    /* Deliberately NOT `overflow: hidden`. The Arrange menu is a dropdown that
       opens BELOW this 34px strip, and an ancestor clip made it unreachable: the
       140px menu survived as 3px of pixels, so elementFromPoint at every item's
       centre returned the header underneath and a person could not click any of
       the five shapes (measured in the real app; jsdom does no layout, so no unit
       test could see it). The strip never needed the clip anyway - the chips row
       owns its own horizontal scrolling (`overflow-x: auto` below) and `.stage`
       still bounds everything one level up - so the clip is simply gone. */
  }

  .ctx-chips {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .ctx-chips::-webkit-scrollbar {
    height: 0;
  }

  .ctx-chip-wrap {
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-sm);
    flex: 0 0 auto;
  }

  .ctx-chip-wrap.active {
    background: var(--atlas-panel);
    box-shadow: inset 0 -2px 0 var(--atlas-signal);
  }

  .ctx-chip {
    padding: 0 8px;
    height: 24px;
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    white-space: nowrap;
    border-radius: var(--radius-sm);
  }

  .ctx-chip-wrap.active .ctx-chip {
    color: var(--atlas-ink);
  }

  .ctx-chip:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink-2);
  }

  /* The live tab count, painted outside textContent. */
  .ctx-chip[data-count]::after {
    content: attr(data-count);
    margin-left: 6px;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-variant-numeric: tabular-nums;
    color: var(--atlas-ink-4);
  }

  .ctx-chip-wrap.active .ctx-chip[data-count]::after {
    color: var(--atlas-signal-2, var(--atlas-signal));
  }

  .ctx-dissolve {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 24px;
    color: var(--atlas-ink-4);
    border-radius: var(--radius-sm);
  }

  .ctx-dissolve:hover {
    color: var(--atlas-bad);
  }

  .ctx-new {
    width: 22px;
    height: 24px;
    margin-left: 4px;
    border-radius: var(--radius-sm);
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    flex: 0 0 auto;
  }

  .ctx-new:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink);
  }

  .ctx-tools {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .arrange {
    position: relative;
  }

  .tool {
    padding: 0 8px;
    height: 22px;
    border-radius: var(--radius-sm);
    font-size: var(--text-micro);
    color: var(--atlas-ink-3);
    white-space: nowrap;
  }

  .tool:hover,
  .tool.on {
    background: var(--atlas-wash);
    color: var(--atlas-ink-2);
  }

  .menu {
    position: absolute;
    top: 26px;
    right: 0;
    z-index: 40;
    min-width: 120px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    background: var(--atlas-overlay);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-md);
  }

  .menu-item {
    text-align: left;
    padding: 5px 8px;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--atlas-ink-2);
  }

  .menu-item:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink);
  }

  .hint {
    color: var(--atlas-ink-4);
  }

  @media (max-width: 1100px) {
    .hint {
      display: none;
    }
  }
</style>
