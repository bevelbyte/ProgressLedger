<script>
  // Atlas shell — the navigation rail.
  //
  // Grouped by activity plane rather than by feature silo.
  //
  // SPACE BUNNY DIRECTION. The rail is an instrument readout, not a menu of
  // words: a glyph, a live count, and a short caption. That is what lets the
  // Desk answer "how much is on me right now" without the user reading sixteen
  // labels. The wide labelled form is still available (Ctrl+B) for anyone who
  // finds counts-before-names slower to scan, because both are honest and the
  // wide form is what the E2E suite drives.
  //
  // The active item is marked by a filled panel plus the signal hue, not a left
  // rule alone: on a narrow rail a rule is too thin to find at a glance.
  //
  // CONTRACT: every destination renders `button.nav-item` whose text content is
  // exactly its rail label. Counts are rendered through a CSS pseudo-element
  // (`content: attr(data-badge)`) so they never enter `textContent` and cannot
  // break the anchored `/^\s*Project\s*$/` match the E2E suite relies on. The
  // caption is likewise hidden from the accessibility name via aria-hidden on a
  // sibling span, so the button's accessible name stays the label alone.

  import { railGroups, isProfileGated, captionFor } from "./view-registry.js";

  let {
    currentView = "home",
    profileReady = false,
    onNavigate = () => {},
    collapsed = false,
    slim = false,
    badges = {},
    operatorWaiting = false,
    /** Optional top-of-rail readout, rendered by the caller as a snippet so the
     *  rail stays the only owner of destination buttons: the Spine lives inside
     *  this <nav> but its controls are a different class, so `button.nav-item`
     *  keeps meaning exactly one thing (a destination). */
    signals = null,
  } = $props();

  const groups = railGroups();

  // Destinations that are meaningless without a selected profile. The rule
  // itself lives in view-registry.js so every navigation entry point honours
  // the same gate; this component only reflects it.
  function isDisabled(id) {
    return isProfileGated(id, profileReady);
  }

  const TESTIDS = { goals: "nav-goals", career: "nav-career" };
</script>

<nav class="rail" class:collapsed class:slim aria-label="Primary">
  {#if signals}
    {@render signals({ slim, collapsed })}
  {/if}

  {#each groups as group (group.id)}
    <div class="plane" class:footer={group.footer}>
      <p class="plane-label atl-label">{group.label}</p>
      <div class="plane-items">
        {#each group.items as view (view.id)}
          <button
            type="button"
            class="nav-item"
            class:active={currentView === view.id}
            aria-current={currentView === view.id ? "page" : undefined}
            disabled={isDisabled(view.id)}
            title={collapsed ? view.label : view.subtitle}
            data-testid={TESTIDS[view.id]}
            data-badge={badges[view.id] || undefined}
            data-operator={view.id === "project" && operatorWaiting ? "waiting" : undefined}
            onclick={() => onNavigate(view.id)}
          >
            <span class="spine" aria-hidden="true"></span>
            <span class="glyph" aria-hidden="true">
              <view.icon size={collapsed ? 18 : 15} strokeWidth={1.6} />
            </span>
            <span class="nav-text">{view.label}</span>
            <!-- The visible caption on the slim rail. It is drawn by CSS from
                 attr(data-caption) and marked aria-hidden, so it neither enters
                 the button's text content nor its accessible name -- the full
                 label above stays the single source of truth for both. It is a
                 separate element rather than a ::after on .nav-text because the
                 slim rail hides .nav-text from sight, and a pseudo-element on a
                 hidden element is hidden too. -->
            <span class="nav-caption" aria-hidden="true" data-caption={captionFor(view.id)}
            ></span>
          </button>
        {/each}
      </div>
    </div>
  {/each}
</nav>

<style>
  .rail {
    width: var(--shell-rail-w);
    flex: 0 0 var(--shell-rail-w);
    background: var(--atlas-chrome);
    border-right: 1px solid var(--atlas-line);
    display: flex;
    flex-direction: column;
    padding: 10px 0 8px;
    overflow-y: auto;
    overflow-x: hidden;
    transition: width var(--dur-med) var(--ease), flex-basis var(--dur-med) var(--ease);
  }

  .rail.collapsed {
    width: var(--shell-rail-w-collapsed);
    flex-basis: var(--shell-rail-w-collapsed);
  }

  /* SPACE BUNNY — the numeric rail.
     Icon on top, count in the middle, caption underneath, stacked. The three
     rows are what make this an instrument rather than a menu: you read the
     count column without reading a single word. */
  .rail.slim {
    width: var(--shell-rail-w-slim);
    flex-basis: var(--shell-rail-w-slim);
    padding: 8px 0 8px;
    align-items: center;
  }

  .plane {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 8px;
  }

  .rail.slim .plane {
    padding: 0 6px;
    width: 100%;
    align-items: center;
    gap: 3px;
  }

  /* The footer plane sits at the bottom, separated by the rail's hairline. */
  .plane.footer {
    margin-top: auto;
    padding-top: 10px;
    position: relative;
  }

  .plane.footer::before {
    content: "";
    position: absolute;
    top: 0;
    left: 12px;
    right: 12px;
    height: 1px;
    background: var(--atlas-line);
  }

  .plane + .plane {
    margin-top: 14px;
  }

  .plane-label {
    padding: 0 8px;
    margin-bottom: 4px;
    color: var(--atlas-ink-3);
    opacity: 0.72;
  }

  .rail.collapsed .plane-label {
    display: none;
  }

  /* On the numeric rail the plane label would eat the vertical budget the
     counts need, so the plane boundary is carried by a hairline instead. */
  .rail.slim .plane-label {
    display: none;
  }

  .rail.slim .plane + .plane {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--atlas-line);
  }

  .rail.slim .plane.footer {
    margin-top: auto;
  }

  .plane-items {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .rail.slim .plane-items {
    width: 100%;
    gap: 2px;
  }

  /* SPACE BUNNY — stacked numeric item. */
  .rail.slim .nav-item {
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    width: 100%;
    min-height: 52px;
    padding: 7px 2px 6px;
    border-radius: var(--radius-md);
    text-align: center;
    background: transparent;
    border: 1px solid transparent;
  }

  .rail.slim .nav-item:hover:not(:disabled) {
    background: var(--atlas-panel);
  }

  /* The active item is a filled, bordered tile. A left rule is invisible at
     64px wide; the tile is findable at a glance and matches the reference. */
  .rail.slim .nav-item.active {
    background: var(--atlas-signal-softer);
    border-color: var(--atlas-signal-soft);
  }

  .rail.slim .nav-item .spine {
    display: none;
  }

  .rail.slim .glyph {
    display: inline-flex;
    color: var(--atlas-ink-3);
    transition: color var(--dur-fast) var(--ease);
  }

  .rail.slim .nav-item:hover:not(:disabled) .glyph {
    color: var(--atlas-ink-2);
  }

  .rail.slim .nav-item.active .glyph {
    color: var(--atlas-signal);
  }

  /* The visible caption on the numeric rail. It is painted by a pseudo-element
     from `attr(data-caption)`, which keeps it out of `textContent` entirely --
     the E2E contract is the full label in `.nav-text`, never this.

     This rule comes BEFORE `.rail.slim .nav-text` in source order but that is
     deliberate: it is scoped to `.rail.slim`, so the two never conflict. */
  .rail.slim .nav-caption {
    display: block;
    max-width: 100%;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    line-height: 1.2;
    text-align: center;
    color: var(--atlas-ink-4);
    overflow: hidden;
    text-overflow: clip;
    white-space: nowrap;
  }

  .rail.slim .nav-caption::after {
    content: attr(data-caption);
  }

  .rail.slim .nav-item.active .nav-caption {
    color: var(--atlas-ink-2);
  }

  /* Off the numeric rail the caption does not exist -- the full label is the
     caption. */
  .nav-caption {
    display: none;
  }

  /* The full label stays in the DOM on the numeric rail (it IS the button's
     accessible name and the text the E2E suite matches), but it is moved out of
     sight with the standard screen-reader-only technique rather than
     `display: none`, so assistive tech keeps reading the real destination. */
  .rail.slim .nav-text {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  /* The count. Rendered by pseudo-element so it never enters textContent. */
  .rail.slim .nav-item[data-badge]::after {
    content: attr(data-badge);
    order: -1;
    margin: 0;
    padding: 0;
    background: none;
    border: none;
    font-family: var(--font-mono);
    font-size: 15px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1.05;
    color: var(--atlas-ink-2);
  }

  .rail.slim .nav-item.active[data-badge]::after {
    color: var(--atlas-signal-2);
  }

  .nav-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: var(--row-h);
    padding: 0 8px 0 12px;
    border-radius: var(--radius-sm);
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
    font-weight: 450;
    text-align: left;
    transition: background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }

  .nav-item :global(svg) {
    flex-shrink: 0;
    color: var(--atlas-ink-3);
    transition: color var(--dur-fast) var(--ease);
  }

  .nav-item:hover:not(:disabled) {
    background: var(--atlas-wash);
    color: var(--atlas-ink);
  }

  .nav-item:hover:not(:disabled) :global(svg) {
    color: var(--atlas-ink-2);
  }

  .nav-item.active {
    color: var(--atlas-ink);
    background: var(--atlas-signal-softer);
  }

  .nav-item.active :global(svg) {
    color: var(--atlas-signal);
  }

  .nav-item:disabled {
    opacity: 0.36;
    cursor: not-allowed;
  }

  /* The spine: a 2px accent rule that replaces the old filled-pill active
     state. It fades in rather than sliding, so it reads as a mark, not motion. */
  .spine {
    position: absolute;
    left: 2px;
    top: 6px;
    bottom: 6px;
    width: 2px;
    border-radius: var(--radius-full);
    background: var(--atlas-signal);
    opacity: 0;
    transform: scaleY(0.4);
    transform-origin: center;
    transition: opacity var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
  }

  .nav-item.active .spine {
    opacity: 1;
    transform: scaleY(1);
  }

  .nav-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rail.collapsed .nav-item {
    padding: 0;
    justify-content: center;
  }

  /* Icon-only rail: neither the full label nor the short caption has anywhere
     to go, and `title` on the button carries the name on hover. */
  .rail.collapsed .nav-text,
  .rail.collapsed .nav-caption {
    display: none;
  }

  /* Counts ride a pseudo-element so they never join `textContent`. */
  .nav-item[data-badge]::after {
    content: attr(data-badge);
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-variant-numeric: tabular-nums;
    color: var(--atlas-ink-3);
    padding: 0 4px;
    border-radius: var(--radius-full);
    background: var(--atlas-hover);
  }

  .rail.collapsed .nav-item[data-badge]::after {
    position: absolute;
    top: 3px;
    right: 6px;
    margin: 0;
    padding: 0 3px;
    background: var(--atlas-signal);
    color: var(--atlas-signal-ink);
  }

  /* The Runs console gets a live marker when the operator is blocked on the
     user, so an approval is findable from the rail too. */
  .nav-item[data-operator="waiting"]::before {
    content: "";
    position: absolute;
    right: 8px;
    width: 5px;
    height: 5px;
    border-radius: var(--radius-full);
    background: var(--atlas-warn);
    animation: cf-pulse-dot 1.8s ease-in-out infinite;
  }

  .rail.collapsed .nav-item[data-operator="waiting"]::before {
    right: 8px;
    top: 6px;
  }

  .nav-item[data-badge][data-operator="waiting"]::before {
    right: 26px;
  }
</style>
