<script>
  // Atlas shell — title bar.
  //
  // The command bar lives here, physically, because Atlas is command-first:
  // the affordance to search or run anything is visible at all times instead
  // of hidden behind a shortcut the user has to remember.
  //
  // The profile is a global context chip (popover switcher) rather than a
  // destination the user must navigate away from their work to reach. The
  // `Profiles` rail item still opens the full manager for create/import/export.

  import { onMount } from "svelte";
  import {
    Search,
    ChevronDown,
    Globe,
    PanelRight,
    Bell,
    PanelLeft,
    CircleDot,
  } from "lucide-svelte";
  import { operatorSummary } from "./operator.svelte.js";
import logoUrl from "../assets/logo.svg";

  let {
    profiles = [],
    activeProfile = null,
    onSelectProfile = () => {},
    onOpenProfiles = () => {},
    railCollapsed = false,
    onToggleRail = () => {},
    onOpenPalette = () => {},
    onOpenConsole = () => {},
    onShowTutorial = () => {},
  } = $props();

  let profileMenuOpen = $state(false);
  let profileMenuEl = $state(null);

  const summary = $derived(operatorSummary());

  onMount(() => {
    const onDown = (e) => {
      if (!profileMenuOpen) return;
      if (profileMenuEl && !profileMenuEl.contains(e.target)) profileMenuOpen = false;
    };
    const onKey = (e) => {
      if (e.key === "Escape") profileMenuOpen = false;
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });

  function pick(id) {
    profileMenuOpen = false;
    onSelectProfile(id);
  }
</script>

<header class="titlebar">
  <div class="tb-left">
    <button
      type="button"
      class="tb-icon"
      onclick={onToggleRail}
      aria-label={railCollapsed ? "Expand navigation" : "Collapse navigation"}
      title={railCollapsed ? "Expand navigation (Ctrl+B)" : "Collapse navigation (Ctrl+B)"}
    >
      <PanelLeft size={16} strokeWidth={1.6} />
    </button>
    <span class="brand">
      <img class="brand-mark" src={logoUrl} alt="" aria-hidden="true" />
      <span class="brand-name">Progress Ledger</span>
    </span>
  </div>

  <button
    type="button"
    class="cmdbar"
    onclick={onOpenPalette}
    aria-label="Search or run a command"
    title="Search or run a command (Ctrl+K)"
  >
    <Search size={14} strokeWidth={1.8} aria-hidden="true" />
    <span class="cmdbar-text">Search or run a command…</span>
    <kbd class="cf-kbd">Ctrl K</kbd>
  </button>

  <div class="tb-right">
    <!-- Profile = context, not a destination. -->
    <div class="profile-chip-wrap" bind:this={profileMenuEl}>
      <button
        type="button"
        class="profile-chip"
        onclick={() => (profileMenuOpen = !profileMenuOpen)}
        aria-haspopup="menu"
        aria-expanded={profileMenuOpen}
        title="Switch workspace profile"
      >
        <span class="pc-dot" aria-hidden="true"></span>
        <span class="pc-name">{activeProfile?.name ?? "No profile"}</span>
        <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
      </button>

      {#if profileMenuOpen}
        <div class="profile-menu" role="menu" aria-label="Switch profile">
          <p class="atl-label menu-label">Workspace</p>
          {#if profiles.length === 0}
            <p class="menu-empty">No profiles yet.</p>
          {:else}
            {#each profiles as p (p.id)}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={p.id === activeProfile?.id}
                class="menu-row"
                onclick={() => pick(p.id)}
              >
                <span class="mr-name">{p.name}</span>
                {#if p.id === activeProfile?.id}
                  <span class="mr-check" aria-hidden="true">active</span>
                {/if}
              </button>
            {/each}
          {/if}
          <div class="menu-rule" aria-hidden="true"></div>
          <button
            type="button"
            role="menuitem"
            class="menu-row"
            onclick={() => {
              profileMenuOpen = false;
              onOpenProfiles();
            }}
          >
            <span class="mr-name">Manage profiles…</span>
          </button>
        </div>
      {/if}
    </div>

    <!-- Operator state: always visible, never buried. -->
    <button
      type="button"
      class="operator-chip"
      class:waiting={summary.tone === "warn"}
      class:live={summary.tone === "live"}
      onclick={onOpenConsole}
      aria-label={`Operator: ${summary.text}`}
      title="Operator console (Ctrl+Shift+A)"
    >
      {#if summary.tone === "live" || summary.tone === "warn"}
        <span class="cf-pulse-dot" aria-hidden="true"></span>
      {:else}
        <CircleDot size={12} strokeWidth={2} aria-hidden="true" />
      {/if}
      <span class="oc-text">{summary.text}</span>
    </button>

    <div class="tb-utils">
      <button
        type="button"
        class="tb-icon"
        onclick={onShowTutorial}
        aria-label="Show tutorial"
        title="Show tutorial"
      >
        <Bell size={16} strokeWidth={1.6} />
      </button>
    </div>
  </div>
</header>

<style>
  .titlebar {
    height: var(--shell-titlebar-h);
    flex: 0 0 var(--shell-titlebar-h);
    background: var(--atlas-chrome);
    border-bottom: 1px solid var(--atlas-line);
    display: grid;
    grid-template-columns: minmax(200px, 1fr) minmax(280px, 520px) minmax(200px, 1fr);
    align-items: center;
    gap: var(--space-4);
    padding: 0 12px;
    -webkit-app-region: drag;
    z-index: 20;
  }

  .tb-left,
  .tb-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    -webkit-app-region: no-drag;
  }

  .tb-right {
    justify-content: flex-end;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 2px;
  }

  /* The v2 mark (ui/src/assets/logo.svg): an amber ledger plate. */
  .brand-mark {
    display: block;
    flex: none;
    width: 18px;
    height: 18px;
  }

  .brand-name {
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }

  /* ---- Command bar ---- */
  .cmdbar {
    -webkit-app-region: no-drag;
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    height: 30px;
    padding: 0 8px 0 10px;
    border-radius: var(--radius-md);
    background: var(--atlas-base);
    border: 1px solid var(--atlas-line);
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    transition: border-color var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .cmdbar:hover {
    border-color: var(--atlas-line-2);
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
  }

  .cmdbar-text {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Profile chip ---- */
  .profile-chip-wrap {
    position: relative;
    -webkit-app-region: no-drag;
  }

  .profile-chip {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    max-width: 190px;
    padding: 0 8px;
    border-radius: var(--radius-md);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-base);
    color: var(--atlas-ink-2);
    font-size: var(--text-sm);
    transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .profile-chip:hover {
    border-color: var(--atlas-line-2);
    color: var(--atlas-ink);
  }

  .pc-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--atlas-signal);
    flex-shrink: 0;
  }

  .pc-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .profile-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 224px;
    padding: 6px;
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line-2);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2), var(--lift);
    z-index: 60;
    animation: menu-in var(--dur-med) var(--ease);
  }

  @keyframes menu-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .menu-label {
    padding: 4px 8px 6px;
  }

  .menu-empty {
    padding: 6px 8px;
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
  }

  .menu-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: var(--row-h);
    padding: 0 8px;
    border-radius: var(--radius-sm);
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
    text-align: left;
  }

  .menu-row:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink);
  }

  .mr-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mr-check {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--atlas-signal-2);
  }

  .menu-rule {
    height: 1px;
    margin: 5px 4px;
    background: var(--atlas-line);
  }

  /* ---- Operator chip ---- */
  .operator-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 9px;
    border-radius: var(--radius-full);
    border: 1px solid var(--atlas-line);
    background: transparent;
    color: var(--atlas-ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .operator-chip:hover {
    border-color: var(--atlas-line-2);
    color: var(--atlas-ink-2);
  }

  .operator-chip.live {
    color: var(--atlas-signal-2);
    border-color: var(--atlas-signal-soft);
  }

  .operator-chip.waiting {
    color: var(--atlas-warn);
    border-color: var(--atlas-warn-line);
  }

  .oc-text {
    max-width: 170px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---- Utilities ---- */
  .tb-utils {
    display: flex;
    align-items: center;
    gap: 2px;
    -webkit-app-region: no-drag;
  }

  .tb-icon,
  :global(.duck-sidebar-toggle) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-md);
    color: var(--atlas-ink-3);
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .tb-icon:hover,
  :global(.duck-sidebar-toggle:hover) {
    background: var(--atlas-wash);
    color: var(--atlas-ink);
  }

  :global(.duck-sidebar-toggle[aria-pressed="true"]) {
    color: var(--atlas-signal);
    background: var(--atlas-signal-softer);
  }

  @media (max-width: 1100px) {
    .titlebar {
      grid-template-columns: minmax(140px, 1fr) minmax(200px, 1fr) minmax(140px, 1fr);
    }
    .operator-chip {
      display: none;
    }
  }
</style>
