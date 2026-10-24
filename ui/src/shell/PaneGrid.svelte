<script>
  /**
   * Pane grid — renders one context's pane layout tree.
   *
   * A split is a node (`row`/`col`, with fractional `sizes`); a pane is a leaf
   * holding tabs. This is the Space Bunny workspace model
   * (`CareerFlow-Frontend-Lab/src/shell/workspace.ts` → `LayoutTree`), rebuilt
   * for CareerFlow's own views.
   *
   * Two behaviours are deliberately unlike the Lab's, both from its own critique:
   *   - the leaf renders the pane's TAB STRIP and its active view, while the
   *     stage keeps one context header for the focused pane. The Lab gave every
   *     pane its own header copy; at CareerFlow's window sizes that duplicated
   *     the same title in two panes.
   *   - an empty pane says what it is and how to fill it, rather than offering a
   *     hardcoded list of unrelated destinations (the Lab's weakness #7).
   */

  import PaneHeader from "./PaneHeader.svelte";
  import PaneView from "./PaneView.svelte";
  import { leafOrder, trailState } from "./workspace/model.js";

  let {
    ctx,
    viewDeps = {},
    /** Re-point which record a pane's tab shows. The identity travels with the
     *  tab (`active.entity`), so a pane is told only about ITS OWN identity and
     *  two panes can hold two different subjects at once. */
    onSetTabEntity = () => {},
    onFocusPane = () => {},
    onActivateTab = () => {},
    /** Pane-internal back/forward — see store.trailStep. */
    onTrailStep = () => {},
    onCloseTab = () => {},
    onSplit = () => {},
    onClosePane = () => {},
    onSetSizes = () => {},
    onSetMode = () => {},
    /** Open a new CareerFlow browser page in a specific pane. */
    onNewPage = () => {},
    /** Hide native browser views while the pane's destination menu is open. */
    onNewTabMenuOpenChange = () => {},
    /** Move a tab between panes of THIS context — `ws.moveTab`. */
    onMoveTab = () => {},
    /** Live state per record, keyed by a tab's `entity` (the state dot). */
    tabDots = {},
  } = $props();

  const paneCount = $derived(Object.keys(ctx.panes).length);

  // Visual order, not insertion order. The Lab's critique (weakness #4) caught
  // its pane numbers coming from object-key order, so after a drag-to-edge split
  // the pane labelled "2" could sit third from the left. Numbers are a readout;
  // a readout that lies is worse than no readout.
  const order = $derived(leafOrder(ctx.layout, ctx.panes));

  /* ---- drag-resize between two adjacent panes of one split ---- */
  let drag = $state(null);

  function startResize(event, split, index) {
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    drag = {
      split,
      index,
      box,
      startX: event.clientX,
      startY: event.clientY,
      sizes: [...(split.sizes ?? split.children.map(() => 1 / split.children.length))],
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endResize);
  }

  function onMove(event) {
    if (!drag) return;
    const { split, index, box, sizes } = drag;
    const horizontal = split.dir === "row";
    const span = horizontal ? box.width : box.height;
    if (!span) return;
    const moved = (horizontal ? event.clientX - drag.startX : event.clientY - drag.startY) / span;
    const min = 0.15;
    const before = sizes[index - 1] ?? 0;
    const after = sizes[index] ?? 0;
    const delta = Math.max(min - before, Math.min(after - min, moved));
    const next = [...sizes];
    next[index - 1] = before + delta;
    next[index] = after - delta;
    onSetSizes(split.id, next);
  }

  function endResize() {
    drag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", endResize);
  }

  /* ---- drag a tab onto another pane to move it there ---- */
  // The dragged tab and the pane it started in. The pane is needed because a
  // move is a relation between two panes, and a tab id alone would not say which
  // pane it came from (`ws.moveTab(paneId, tabId, toPaneId)`).
  let dragging = $state(null);
  let dropPaneId = $state(null);

  function startTabDrag(paneId, tabId) {
    dragging = { paneId, tabId };
  }

  function endTabDrag() {
    dragging = null;
    dropPaneId = null;
  }

  function onPaneDragOver(event, paneId) {
    // Dropping a tab back where it came from is not a move; leaving the default
    // handler alone also keeps a dragged tab's text from being "dropped" into
    // the pane as content.
    if (!dragging || dragging.paneId === paneId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (dropPaneId !== paneId) dropPaneId = paneId;
  }

  function onPaneDragLeave(event, paneId) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if (dropPaneId === paneId) dropPaneId = null;
  }

  function onPaneDrop(event, paneId) {
    if (!dragging || dragging.paneId === paneId) return;
    event.preventDefault();
    const tabId = event.dataTransfer?.getData("text/cf-tab") || dragging.tabId;
    const from = dragging.paneId;
    endTabDrag();
    if (tabId && from) onMoveTab(from, tabId, paneId);
  }

  /** The pane after this one in VISUAL order, wrapping — the move control's target. */
  function nextPaneId(paneId) {
    if (order.length < 2) return null;
    const i = order.indexOf(paneId);
    return i === -1 ? null : order[(i + 1) % order.length];
  }

  function moveActiveTab(pane) {
    const target = nextPaneId(pane.id);
    const active = pane.tabs.find((t) => t.id === pane.activeTabId);
    if (!target || !active) return;
    onMoveTab(pane.id, active.id, target);
  }
</script>

{#snippet node(n)}
  {#if n.kind === "pane"}
      {@const pane = ctx.panes[n.paneId]}
      {#if pane}
        {@const active = pane.tabs.find((t) => t.id === pane.activeTabId) ?? null}
        {@const boundPane = pane.mode === "margin" && pane.boundTo ? ctx.panes[pane.boundTo] : null}
        {@const boundActive = boundPane?.tabs.find((t) => t.id === boundPane.activeTabId) ?? null}
        {@const activeResearchPageId = active?.view === "page" && active.entity
          ? active.entity
          : pane.mode === "margin" && boundActive?.view === "page" && boundActive.entity
            ? boundActive.entity
            : active?.view === "research-ledger" && typeof viewDeps.researchPageId === "string"
              ? viewDeps.researchPageId
              : null}
        {@const trail = trailState(pane)}
      <section
        class="pane"
        class:focused={ctx.focusedPaneId === pane.id}
        class:margin={pane.mode === "margin"}
        class:ledge={pane.mode === "ledge"}
        class:dropping={dropPaneId === pane.id}
        data-pane-id={pane.id}
        data-pane-mode={pane.mode}
        aria-label="Pane {ctx.focusedPaneId === pane.id ? "focused" : "unfocused"}"
        onpointerdown={() => onFocusPane(pane.id)}
        ondragover={(event) => onPaneDragOver(event, pane.id)}
        ondragleave={(event) => onPaneDragLeave(event, pane.id)}
        ondrop={(event) => onPaneDrop(event, pane.id)}
      >
        <PaneHeader
          index={order.indexOf(pane.id) + 1}
          tabs={pane.tabs}
          active={pane.activeTabId}
          mode={pane.mode}
          canClose={paneCount > 1}
          canBack={trail.canBack}
          canForward={trail.canFwd}
          onSelect={(id) => onActivateTab(pane.id, id)}
          onClose={(id) => onCloseTab(pane.id, id)}
          onSplit={(dir) => onSplit(dir)}
          onClosePane={() => onClosePane(pane.id)}
          onModeChange={(mode) => onSetMode(pane.id, mode)}
          onTrailBack={() => onTrailStep(pane.id, -1)}
          onTrailForward={() => onTrailStep(pane.id, 1)}
          onNewPage={() => onNewPage(pane.id)}
          onNewTabMenuOpenChange={onNewTabMenuOpenChange}
          dots={tabDots}
          canMove={paneCount > 1}
          onMoveTab={() => moveActiveTab(pane)}
          onTabDragStart={(tabId) => startTabDrag(pane.id, tabId)}
          onTabDragEnd={endTabDrag}
        />
        <div class="pane-body">
          {#if active}
            <PaneView
              {...viewDeps}
              view={active.view}
              entity={active.entity ?? null}
              paneMode={pane.mode}
              researchPageId={activeResearchPageId}
              onEntityChange={(entity) => onSetTabEntity(pane.id, active.id, entity)}
            />
          {:else}
            <div class="pane-empty">
              <p class="empty-question atl-label">Nothing open in this pane</p>
              <p class="empty-help">
                Pick a destination from the rail, press <kbd>Ctrl</kbd>+<kbd>K</kbd>, or move a tab
                here from another pane.
              </p>
            </div>
          {/if}
        </div>
      </section>
    {/if}
  {:else}
    <div class="split" class:row={n.dir === "row"} class:col={n.dir === "col"} data-split-id={n.id}>
      {#each n.children as child, i (child.kind === "pane" ? child.paneId : child.id)}
        {#if i > 0}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="handle"
            class:horizontal={n.dir === "row"}
            role="separator"
            aria-orientation={n.dir === "row" ? "vertical" : "horizontal"}
            onpointerdown={(e) => startResize(e, n, i)}
          ></div>
        {/if}
        {@const size = n.sizes?.[i] ?? 1 / n.children.length}
        <div class="slot" style:flex-grow={String(size)}>
          {@render node(child)}
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

<div class="pane-grid">
  {@render node(ctx.layout)}
</div>

<style>
  .pane-grid {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  /* A split owns its own direction, so nesting works without the parent
     knowing what is inside it. */
  .split {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .split.row {
    flex-direction: row;
  }

  .split.col {
    flex-direction: column;
  }

  /* flex-basis:0 + flex-grow:<fraction> is the whole sizing model: the sizes are
     ratios, so a nested split and a top-level one behave identically. */
  .slot {
    display: flex;
    flex-direction: column;
    flex-basis: 0;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .handle {
    flex: 0 0 4px;
    background: var(--atlas-line);
  }

  .handle.horizontal {
    cursor: col-resize;
  }

  .handle:not(.horizontal) {
    cursor: row-resize;
  }

  .handle:hover {
    background: var(--atlas-signal-soft, var(--atlas-line));
  }

  .pane {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    background: var(--atlas-base);
    /* A pane is the density unit, not the window: "a 400px pane is not a small
       window, it is a margin" (Lab README §3 / workspace.css). Declaring the
       container here is what lets a view adapt to the space it actually got
       instead of to the viewport. */
    container-type: inline-size;
    container-name: pane;
  }

  /* Focus is a hairline on the pane's leading edge, not a glow: with two panes
     open the user needs to find the keyboard target at a glance. */
  .pane.focused {
    box-shadow: inset 2px 0 0 var(--atlas-signal-soft, transparent);
  }

  /* The pane that would receive a dragged tab. An inset outline, not a fill:
     the pane's own content must stay readable while the drag is in flight. */
  .pane.dropping {
    outline: 1px dashed var(--atlas-signal);
    outline-offset: -3px;
  }

  .pane.margin .pane-body {
    background: var(--atlas-panel);
  }

  .pane-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .pane-empty {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: var(--space-6);
    text-align: center;
  }

  .empty-question {
    color: var(--atlas-ink-3);
  }

  .empty-help {
    max-width: 34ch;
    font-size: var(--text-sm);
    color: var(--atlas-ink-4);
  }

  kbd {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 0 3px;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-xs);
    color: var(--atlas-ink-3);
  }

  /* W1-level pane density only: the empty state and the pane's own controls
     give way as the pane narrows. Deeper per-view recomposition (the Lab's
     weakness #5) is deliberately a later wave. */
  @container pane (max-width: 560px) {
    .pane-empty {
      padding: var(--space-4);
    }
  }

  @container pane (max-width: 420px) {
    .pane-empty {
      padding: var(--space-3);
    }

    .empty-help {
      display: none;
    }
  }
</style>
