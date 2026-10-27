<script>
  // Atlas shell — Settings.
  //
  // Previously six unrelated panels (grading, backup, cloud sync, sync
  // automation, diagnostics, updates) were stacked into a single scrolling
  // column with no navigation: the user's only way to find "where do I change
  // my grade scale" was to scroll and read every heading. Settings is a
  // *destination with sections*, so it gets a rail and a detail pane, and only
  // the active section mounts — which also keeps opening Settings from firing
  // six panels' IPC lookups at once.
  //
  // CONTRACT: `data` is the default section. The whole-profile backup/restore
  // E2E flow navigates to Settings and immediately drives
  // `button.primary` "Backup Active Profile" and `.restore-btn`, so the vault
  // must be on screen without a second click. The panels themselves are
  // rendered unchanged, which is what keeps `.backup-row`, `.restore-btn`,
  // `.cf-modal` and the confirm-dialog contract intact.

  import { untrack } from "svelte";
  import {
    Database,
    RefreshCw,
    GraduationCap,
    Globe,
    Activity,
    Download,
  } from "lucide-svelte";

  import {
    SEARCH_ENGINE_STORAGE_KEY,
    DEFAULT_SEARCH_ENGINE,
  } from "../features/browser/addressBar.js";

  import { BackupVault } from "../features/backup";
  import { CloudSyncPanel } from "../features/cloud-sync";
  import { SyncAutomationPanel } from "../features/sync-automation";
  import { GradeScaleEditor } from "../features/grading-config";
  import { DiagnosticsPanel } from "../features/diagnostics";
  import { UpdatePanel } from "../features/updates";

  let {
    profiles = [],
    activeProfile = null,
    onRestored = async () => {},
    initialSection = "data",
  } = $props();

  const SECTIONS = [
    {
      id: "data",
      label: "Data",
      icon: Database,
      title: "Data and vault",
      blurb: "Whole-profile snapshots on this machine. Everything is local.",
    },
    {
      id: "sync",
      label: "Sync",
      icon: RefreshCw,
      title: "Sync",
      blurb: "A remote copy of your vault, and whether it happens on its own.",
    },
    {
      id: "grading",
      label: "Grading",
      icon: GraduationCap,
      title: "Grading",
      blurb: "The percentage → grade → grade-point bands CGPA is computed with.",
    },
    {
      id: "browser",
      label: "Browser",
      icon: Globe,
      title: "Browser",
      blurb: "What the address bar searches with. Full addresses still open directly.",
    },
    {
      id: "diagnostics",
      label: "Diagnostics",
      icon: Activity,
      title: "Diagnostics",
      blurb: "What each subsystem reports about itself, right now.",
    },
    {
      id: "updates",
      label: "Updates",
      icon: Download,
      title: "Updates",
      blurb: "Application version and release notes.",
    },
  ];

  // `untrack` is deliberate: a deep link picks the entry section, after which
  // the rail owns the choice. This is an initial value, not a live binding, so
  // a later change to the prop must not yank the user out of the pane they are
  // reading. It also keeps an unknown section id from rendering an empty pane.
  let section = $state(
    untrack(() =>
      SECTIONS.some((s) => s.id === initialSection) ? initialSection : SECTIONS[0].id,
    ),
  );

  // Keep the last valid section if a caller deep-links to an unknown id, so a
  // stale command-palette entry can never render an empty pane.
  const active = $derived(SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]);

  // Browser search engine: a plain localStorage preference (the same
  // mechanism the diagnostics toggles use). Read fresh on mount; the
  // address bar reads the same key on every submit, so a change here
  // takes effect without a reload. Unknown or missing values mean the
  // default, DuckDuckGo.
  function readStoredSearchEngine() {
    try {
      const raw =
        typeof localStorage !== "undefined"
          ? localStorage.getItem(SEARCH_ENGINE_STORAGE_KEY)
          : null;
      if (raw === "duckduckgo" || raw === "bing" || raw === "google") return raw;
    } catch {
      // Storage unavailable: the default is the safe answer.
    }
    return DEFAULT_SEARCH_ENGINE;
  }
  let searchEngine = $state(readStoredSearchEngine());
  function saveSearchEngine() {
    try {
      localStorage.setItem(SEARCH_ENGINE_STORAGE_KEY, searchEngine);
    } catch {
      // Storage unavailable: the choice lasts until reload.
    }
  }
</script>

<div class="settings">
  <nav class="settings-rail" aria-label="Settings sections">
    {#each SECTIONS as s (s.id)}
      <button
        type="button"
        class="sec"
        class:active={active.id === s.id}
        aria-current={active.id === s.id ? "true" : undefined}
        onclick={() => (section = s.id)}
      >
        <span class="sec-spine" aria-hidden="true"></span>
        <s.icon size={15} strokeWidth={1.6} aria-hidden="true" />
        <span class="sec-label">{s.label}</span>
      </button>
    {/each}
  </nav>

  <section class="settings-pane" aria-labelledby="settings-section-title">
    <header class="pane-head">
      <h2 id="settings-section-title">{active.title}</h2>
      <p class="pane-blurb">{active.blurb}</p>
    </header>

    <div class="pane-body">
      {#if active.id === "data"}
        <BackupVault {profiles} {activeProfile} {onRestored} />
      {:else if active.id === "sync"}
        <CloudSyncPanel {profiles} {activeProfile} {onRestored} />
        <SyncAutomationPanel />
      {:else if active.id === "grading"}
        <GradeScaleEditor {activeProfile} />
      {:else if active.id === "browser"}
        <div class="browser-setting">
          <label class="browser-label" for="search-engine-select">
            Address bar search engine
          </label>
          <select
            id="search-engine-select"
            aria-label="Address bar search engine"
            bind:value={searchEngine}
            onchange={saveSearchEngine}
          >
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="bing">Bing</option>
            <option value="google">Google</option>
          </select>
          <p class="browser-hint">
            Plain text typed in the browser address bar searches here.
            Google may show an unusual-traffic check for this browser;
            DuckDuckGo is the default for that reason.
          </p>
        </div>
      {:else if active.id === "diagnostics"}
        <DiagnosticsPanel />
      {:else if active.id === "updates"}
        <UpdatePanel />
      {/if}
    </div>
  </section>
</div>

<style>
  .settings {
    display: grid;
    grid-template-columns: 176px minmax(0, 1fr);
    gap: var(--space-6);
    align-items: start;
  }

  /* The rail sticks to the top of the scrolling work area, so the sections stay
     reachable while reading a long panel (the vault list can be long). */
  .settings-rail {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .sec {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: var(--row-h);
    padding: 0 8px 0 12px;
    border-radius: var(--radius-sm);
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
    text-align: left;
    transition: background-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }

  .sec :global(svg) {
    flex-shrink: 0;
    color: var(--atlas-ink-3);
    transition: color var(--dur-fast) var(--ease);
  }

  .sec:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink);
  }

  .sec:hover :global(svg) {
    color: var(--atlas-ink-2);
  }

  .sec.active {
    color: var(--atlas-ink);
    background: var(--atlas-signal-softer);
  }

  .sec.active :global(svg) {
    color: var(--atlas-signal);
  }

  /* Same spine as the nav rail: one active-state mark across the whole app. */
  .sec-spine {
    position: absolute;
    left: 2px;
    top: 6px;
    bottom: 6px;
    width: 2px;
    border-radius: var(--radius-full);
    background: var(--atlas-signal);
    opacity: 0;
    transform: scaleY(0.4);
    transition: opacity var(--dur-fast) var(--ease),
      transform var(--dur-fast) var(--ease);
  }

  .sec.active .sec-spine {
    opacity: 1;
    transform: scaleY(1);
  }

  .settings-pane {
    min-width: 0;
  }

  .pane-head {
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-4);
    border-bottom: 1px solid var(--atlas-line);
  }

  .pane-head h2 {
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--atlas-ink);
  }

  .pane-blurb {
    margin-top: 2px;
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
  }

  .pane-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /* Browser section: one labelled setting, kept deliberately small. */
  .browser-setting {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 420px;
  }

  .browser-label {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--atlas-ink);
  }

  .browser-setting select {
    padding: 7px 10px;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-sm);
    background: var(--atlas-wash);
    color: var(--atlas-ink);
    font: inherit;
    font-size: var(--text-md);
  }

  .browser-hint {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
  }

  @media (max-width: 1000px) {
    .settings {
      grid-template-columns: 1fr;
    }
    .settings-rail {
      position: static;
      flex-direction: row;
      flex-wrap: wrap;
    }
  }
</style>
