<script>
  import { ChevronLeft, ChevronRight, Plus } from "lucide-svelte";
  import { Menu } from "../shared/components/index.js";
  import { pageFor } from "../shared/stores/browser.svelte.js";

  // Atlas shell — pane header (the tab strip above the work surface).
  //
  // SPACE BUNNY DIRECTION. In the reference the pane header is a thin instrument
  // strip: a pane number, the pane's trail arrows, the tab row, and per-tab
  // controls on the right. It is deliberately NOT a second navigation surface —
  // the rail is where you go, this is only where you already are. It answers
  // "what have I open, and what do I close", and nothing else.
  //
  // The trail arrows are route-level back/forward for THIS pane only — the
  // reference shows them right after the pane number (`Progress Ledger-Frontend-Lab
  // /src/shell/PaneShell.tsx` → `.pane__trail`), and they step the trail the
  // workspace model already records on every activation (G11: the write-only
  // half is gone because this control is its consumer).
//
// Tabs are honest: a tab exists because the user navigated somewhere. Nothing is
// pre-seeded, and a tab whose destination is profile-gated is not opened at all,
// so the strip can never offer a view that would immediately stall.
//
// CONTRACT: renders `role="tablist"`. The active tab carries `aria-selected`,
// and every tab is a real <button> so it is keyboard-reachable in tab order.

let {
  tabs = [],
  active = null,
  /** 1-based position in the context's pane tree — a readout, not a control. */
  index = 1,
  /** "content" | "margin" | "ledge" (see workspace/model.js PANE_MODES). */
  mode = "content",
  /** Whether closing this pane is meaningful (never for the last pane). */
  canClose = false,
  /** Pane trail readout: whether a step back / forward leads anywhere. */
  canBack = false,
  canForward = false,
  /**
   * Live state per RECORD, keyed by the tab's `entity` (D2-D6 plan, Phase 2).
   * A browser page tab shows a state dot in the same slot the strip already
   * uses for tab state — the Lab's `tab__dot`/`tab__live` pattern — so a
   * loading or crashed page is visible in the strip, not only inside the pane.
   * A tab with no entity, or an entity with no live state, shows no dot.
   */
  dots = {},
  /** Whether moving the active tab to another pane is meaningful. */
  canMove = false,
  onSelect = () => {},
  onClose = () => {},
  onSplit = () => {},
  onClosePane = () => {},
  onModeChange = () => {},
  onTrailBack = () => {},
  onTrailForward = () => {},
  /** Open a new Progress Ledger browser page in this pane (D2-D6 plan, Phase 1). */
  onNewPage = () => {},
  /** Native WebContentsView must be hidden while this menu overlays the pane. */
  onNewTabMenuOpenChange = () => {},
  /** Move the active tab to the next pane in visual order (Phase 2, keyboard
   *  equivalent of the drag that `PaneGrid` implements). */
  onMoveTab = () => {},
  /** Tab drag: a tab can be dragged onto another pane to move it there. */
  onTabDragStart = () => {},
  onTabDragEnd = () => {},
} = $props();

/** Tooltips for the state dot. The dot is decorative; this is what it means. */
const DOT_TITLES = {
  loading: "Loading",
  ready: "Loaded",
  failed: "This page could not be loaded",
  crashed: "This page crashed",
  sleeping: "Sleeping",
};

function dotFor(tab) {
  return tab.entity == null ? null : (dots?.[tab.entity] ?? null);
}

// Keep the active tab visible. The strip scrolls horizontally with hidden
// scrollbars, so without this an active tab can sit half-clipped at the
// strip's edge (reference screenshots: the "Goal" tab cut off at the right
// edge of the Study tab strip). `nearest` never scrolls a fully-visible tab.
$effect(() => {
  const id = active;
  if (id == null) return;
  const el = document.querySelector(`[data-pane-tab="${id}"]`);
  // jsdom (unit tests) has no scrollIntoView; skip there, never throw.
  if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", inline: "nearest" });
});

function onKeydown(event, index) {
  // Left/Right move between tabs, Home/End jump to the ends. The strip is a
  // single row, so Up/Down are deliberately NOT bound: in a horizontal tablist
  // they read as a vertical one and strand keyboard users in a dead key.
  const last = tabs.length - 1;
  let next = null;
  if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
  else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  if (next == null) return;
  event.preventDefault();
  const t = tabs[next];
  if (t) {
    onSelect(t.id);
    // Move focus with selection so the keyboard user stays on the tab they moved to.
    requestAnimationFrame(() => {
      document.querySelector(`[data-pane-tab="${t.id}"]`)?.focus();
    });
  }
}
</script>

<div class="panehead">
  <div class="pane-num" aria-hidden="true">{index}</div>

  <div class="pane-trail">
    <button
      type="button"
      class="pane-control"
      aria-label="Back"
      title="Back in this pane"
      disabled={!canBack}
      onclick={onTrailBack}
    >
      <ChevronLeft size={13} />
    </button>
    <button
      type="button"
      class="pane-control"
      aria-label="Forward"
      title="Forward in this pane"
      disabled={!canForward}
      onclick={onTrailForward}
    >
      <ChevronRight size={13} />
    </button>
  </div>

  {#if mode !== "content"}
    <span class="pane-mode atl-label" data-mode={mode}>{mode}</span>
  {/if}

  {#if tabs.length}
    <div class="tabs" role="tablist" aria-label="Open views">
      {#each tabs as tab, i (tab.id)}
        {@const dot = dotFor(tab)}
        <div class="tab-wrap" class:active={tab.id === active}>
          <button
            type="button"
            role="tab"
            class="tab"
            data-pane-tab={tab.id}
            data-view={tab.view}
            aria-selected={tab.id === active ? "true" : "false"}
            tabindex={tab.id === active ? 0 : -1}
            title={tab.label}
            draggable="true"
            onclick={() => onSelect(tab.id)}
            onkeydown={(e) => onKeydown(e, i)}
            ondragstart={(event) => {
              // The drag payload is the tab id; the pointer state that tells
              // PaneGrid which pane the drag STARTED in lives there.
              event.dataTransfer?.setData("text/cf-tab", tab.id);
              if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
              onTabDragStart(tab.id);
            }}
            ondragend={onTabDragEnd}
          >
            {#if dot}
              <span
                class="tab-dot"
                data-tab-dot={dot}
                title={DOT_TITLES[dot] ?? dot}
                aria-label={DOT_TITLES[dot] ?? dot}
                role="img"
              ></span>
            {/if}
            {#if tab.view === "page"}
              {@const pageProfile = pageFor(tab.entity)?.browserProfile ?? null}
              {#if pageProfile}
                <span
                  class="tab-profile-dot"
                  style="--profile-color: {pageProfile.color ?? "#888888"}"
                  title={pageProfile.displayName}
                  aria-label="Profile: {pageProfile.displayName}"
                  role="img"
                ></span>
              {/if}
            {/if}
            <span class="tab-label">{tab.label}</span>
          </button>
          {#if tabs.length > 1}
            <button
              type="button"
              class="tab-close"
              aria-label={`Close ${tab.label}`}
              title={`Close ${tab.label}`}
              onclick={() => onClose(tab.id)}
            >
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
              </svg>
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <div class="tabs-empty atl-label">No open view</div>
  {/if}

  <div class="pane-tail">
    <!-- Move the active tab to the next pane. The drag on the tab itself is the
         mouse equivalent; this is the same act without a pointer, and it is
         disabled (not hidden) with a single pane, like the trail chevrons. -->
    <button
      type="button"
      class="pane-control"
      aria-label="Move active tab to the next pane"
      title="Move the active tab to the next pane"
      disabled={!canMove}
      onclick={onMoveTab}
    >
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <path d="M2 2v8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" />
        <path d="M5 6h5M8 3.5 10.5 6 8 8.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <!-- Destinations live in the pane's New tab menu, as in Space Bunny.
         A web page is one destination and becomes an ordinary workspace tab. -->
    <div class="pane-new-tab-menu">
      <Menu
        label="New tab"
        icon={Plus}
        size={12}
        variant="ghost"
        onOpenChange={onNewTabMenuOpenChange}
        items={[{ id: "new-web-page", label: "New web page", onselect: onNewPage }]}
      />
    </div>
    <!-- Mode is reclaimable in both directions. The Lab's critique (weakness
         #2) was that a pane could become a margin or a ledge and never return,
         because its model had no `content` transition. This control is the way
         back, so `content` is a destination rather than an absence. -->
    <select
      class="pane-mode-select"
      aria-label="Pane mode"
      title="Process mode: content, a margin beside the work, or a reference band"
      value={mode}
      onchange={(e) => onModeChange(e.currentTarget.value)}
    >
      <option value="content">Content</option>
      <option value="margin">Margin</option>
      <option value="ledge">Ledge</option>
    </select>
    <button
      type="button"
      class="pane-control"
      aria-label="Split pane vertically"
      title="Split side by side (Ctrl+backslash)"
      onclick={() => onSplit("row")}
    >
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <rect x="1.5" y="2" width="9" height="8" rx="1" stroke="currentColor" stroke-width="1.2" fill="none" />
        <path d="M6 2v8" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    <button
      type="button"
      class="pane-control"
      aria-label="Split pane horizontally"
      title="Split top and bottom (Ctrl+Alt+backslash)"
      onclick={() => onSplit("col")}
    >
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <rect x="1.5" y="2" width="9" height="8" rx="1" stroke="currentColor" stroke-width="1.2" fill="none" />
        <path d="M1.5 6h9" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    {#if canClose}
      <button
        type="button"
        class="pane-control pane-close"
        aria-label="Close pane"
        title="Close this pane"
        onclick={onClosePane}
      >
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" />
        </svg>
      </button>
    {/if}
  </div>
</div>

<style>
  .panehead {
    position: relative;
    z-index: 2;
    height: var(--shell-panehead-h);
    flex: 0 0 var(--shell-panehead-h);
    display: flex;
    align-items: stretch;
    gap: 8px;
    padding: 0 10px 0 8px;
    background: var(--atlas-base);
    border-bottom: 1px solid var(--atlas-line);
    overflow: visible;
  }

  /* The pane number. It is a readout, not a control -- with one pane there is
     nothing to switch between, so it is hidden from assistive tech. */
  .pane-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    flex: 0 0 18px;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    color: var(--atlas-ink-4);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-xs);
    align-self: center;
    height: 16px;
  }

  .tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tabs::-webkit-scrollbar { height: 0; }

  .tab-wrap {
    display: flex;
    align-items: stretch;
    border-radius: var(--radius-sm);
    background: transparent;
    transition: background-color var(--dur-fast) var(--ease);
    flex: 0 0 auto;
    max-width: 220px;
  }

  .tab-wrap:hover { background: var(--atlas-wash); }

  .tab-wrap.active {
    background: var(--atlas-panel);
    box-shadow: inset 0 -2px 0 var(--atlas-signal);
  }

  .tab {
    display: flex;
    align-items: center;
    min-width: 0;
    padding: 0 4px 0 10px;
    height: 100%;
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    white-space: nowrap;
    transition: color var(--dur-fast) var(--ease);
  }

  .tab-wrap.active .tab { color: var(--atlas-ink); }

  .tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Tab state dot (the Lab's `tab__dot`). A readout, not a control: it carries
     a title/aria-label so the state reaches assistive tech too. */
  .tab-dot {
    display: inline-flex;
    width: 6px;
    height: 6px;
    flex: 0 0 6px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--atlas-ink-4);
  }
  .tab-profile-dot {
    display: inline-flex;
    width: 6px;
    height: 6px;
    flex: 0 0 6px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--profile-color, #888888);
  }

  .tab-dot[data-tab-dot="loading"] { background: var(--atlas-signal); }
  .tab-dot[data-tab-dot="ready"] { background: var(--atlas-ink-4); }
  .tab-dot[data-tab-dot="sleeping"] { background: var(--atlas-ink-4); }
  .tab-dot[data-tab-dot="failed"],
  .tab-dot[data-tab-dot="crashed"] { background: var(--atlas-bad); }

  .tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    flex: 0 0 20px;
    height: 100%;
    color: var(--atlas-ink-4);
    opacity: 0;
    border-radius: var(--radius-sm);
    transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  /* The close affordance appears on hover, on keyboard focus of the tab, and
     permanently on the active tab -- so it is always reachable without a mouse. */
  .tab-wrap:hover .tab-close,
  .tab:focus-visible + .tab-close,
  .tab-wrap.active .tab-close { opacity: 1; }

  .tab-close:hover { color: var(--atlas-bad); }

  .tabs-empty {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
  }

  /* The tail holds the pane's own controls. It is no longer a spacer, so it
     must not be aria-hidden: every control in it is a real button or select. */
  .pane-tail {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    padding-right: 4px;
  }

  .pane-new-tab-menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex: 0 0 20px;
  }

  .pane-new-tab-menu :global(.cf-btn.icon) {
    width: 20px;
    min-height: 20px;
    height: 20px;
    padding: 0;
    border-radius: var(--radius-sm);
  }

  .pane-mode {
    display: inline-flex;
    align-items: center;
    align-self: center;
    height: 16px;
    padding: 0 5px;
    margin-right: 2px;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-xs);
    color: var(--atlas-ink-3);
  }

  .pane-control {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: var(--radius-sm);
    color: var(--atlas-ink-4);
  }

  .pane-control:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink-2);
  }

  .pane-close:hover {
    color: var(--atlas-bad);
  }

  /* Compact by design: it sits in the pane strip at --text-micro. */
  .pane-mode-select {
    height: 20px;
    padding: 0 2px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--atlas-ink-4);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    cursor: pointer;
  }

  .pane-mode-select:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink-2);
  }

  .pane-mode-select option {
    background: var(--atlas-overlay);
    color: var(--atlas-ink);
  }

  /* The trail arrows sit between the pane number and the tabs, as in the
     reference. Disabled, not hidden: a control that vanishes and reappears
     reads as the strip lying about what exists. */
  .pane-trail {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    align-self: stretch;
    margin-right: 2px;
  }

  .pane-control:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .pane-control:disabled:hover {
    background: transparent;
    color: var(--atlas-ink-4);
  }

  @media (prefers-reduced-motion: reduce) {
    .tab-wrap, .tab, .tab-close { transition: none; }
  }
</style>
