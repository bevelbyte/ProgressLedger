<script>
  // Project Mode — top-level panel. Shows the sidebar of projects
  // (ProjectList) and the active workspace (ProjectWorkspace). Lives at
  // the `project` view in App.svelte.

import ProjectList from "./ProjectList.svelte";
import ProjectWorkspace from "./ProjectWorkspace.svelte";
import KeybindingsHelp from "./KeybindingsHelp.svelte";
import OnboardingTour from "./OnboardingTour.svelte";
import SearchModal from "./SearchModal.svelte";
import ResumeBanner from "./ResumeBanner.svelte";
import { projectModeStore, loadProjects, selectProject } from "../stores/projectMode.svelte.js";

  let { profileId = null, pendingAgentId = null, pendingProjectId = null } = $props();

  // Local view-mode state for the panel itself. The store has the
  // source-of-truth `activeProjectId`; this is just a UI flag.
  let activeView = $state("list"); // 'list' | 'workspace'

  // When GoalsView deep-links into a specific agent via `pendingAgentId`,
  // we jump straight into the workspace and pre-select the agent.
  // We need the agent's project_id so ProjectWorkspace has a valid
  // activeProjectId too — otherwise the agent-detail view shows
  // "No project" headers.
  $effect(() => {
    if (typeof pendingAgentId !== "number" || profileId == null) return;
    let cancelled = false;
    (async () => {
      try {
        // Make sure the project list is loaded so the activeProject
        // lookup succeeds.
        if (
          projectModeStore.projects == null ||
          projectModeStore.projects.length === 0
        ) {
          await loadProjects(profileId);
        }
        const agent = await window.progressLedger.projectMode.getAgent(profileId, pendingAgentId);
        if (cancelled) return;
        if (agent && agent.ok !== false) {
          const projectId = agent.projectId ?? agent.project_id;
          if (typeof projectId === "number") {
            // selectProject also flips activeProjectId on the store.
            selectProject(projectId);
          }
          projectModeStore.activeAgentId = pendingAgentId;
          activeView = "workspace";
        }
      } catch (_e) {
        // Leave the panel on the project list; do not flip workspace
        // mode silently on errors.
      }
    })();
    return () => { cancelled = true; };
  });

  // Career Plan can deep-link to a concrete project. Resolve it through the
  // project store so the workspace receives the same ownership-scoped state
  // as a normal project-list selection.
  $effect(() => {
    if (typeof pendingProjectId !== "number" || profileId == null) return;
    let cancelled = false;
    (async () => {
      try {
        if (projectModeStore.projects == null || projectModeStore.projects.length === 0) {
          await loadProjects(profileId);
        }
        if (cancelled) return;
        const project = projectModeStore.projects.find((p) => p.id === pendingProjectId);
        if (!project) return;
        selectProject(project.id);
        activeView = "workspace";
      } catch (_e) {
        // Keep the normal project list visible if the deep-link cannot resolve.
      }
    })();
    return () => { cancelled = true; };
  });

  // Keybindings help modal.
  let showKeybindings = $state(false);

  // Global search modal (Cmd+K).
  let showSearch = $state(false);

  // Onboarding tour state. Auto-shows on first visit if the localStorage
  // flag is missing. Can be re-opened from the Help menu.
  const TOUR_KEY = "progressledger_v2_project_mode_tour_complete";
  let showTour = $state(false);

  function openTour() {
    showTour = true;
  }

  function closeTour() {
    showTour = false;
  }

  $effect(() => {
    // Only auto-open once, on mount, if the user has never completed it.
    try {
      if (!localStorage.getItem(TOUR_KEY)) {
        showTour = true;
      }
    } catch (_) {
      // localStorage may be unavailable (e.g. in tests); ignore.
    }
  });

  // ? or Cmd+/ opens the keybindings help.
  // Cmd+K opens the global search modal (always fires, even on inputs).
  $effect(() => {
    function onKey(e) {
      const isMod = e.ctrlKey || e.metaKey;
      // Cmd+K — global search, fires regardless of input focus.
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        showSearch = true;
        return;
      }
      // The rest only fire when not focused on an input/textarea/select.
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "?" || (isMod && e.key === "/")) {
        e.preventDefault();
        showKeybindings = true;
      } else if (e.key === "Escape" && showKeybindings) {
        showKeybindings = false;
      } else if (e.key === "Escape" && showSearch) {
        showSearch = false;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="project-mode-root" data-testid="project-mode-panel">
  <aside class="project-mode-sidebar">
    <ProjectList
      {profileId}
      onSelectProject={(p) => {
        activeView = "workspace";
      }}
    />
  </aside>

  <main class="project-mode-main">
    {#if profileId != null}
      <ResumeBanner
        {profileId}
        onResume={() => {
          // Switch to the workspace view when the user picks up the
          // previous run so the timeline + plan panels are visible.
          activeView = "workspace";
        }}
      />
    {/if}
    {#if activeView === "workspace" && profileId != null}
      <ProjectWorkspace {profileId} onShowKeybindings={() => (showKeybindings = true)} />
    {:else}
      <div class="empty-state cf-empty boxed">
        <p>Pick a project to open its run console, or create one on the left.</p>
      </div>
    {/if}
  </main>
</div>

<!-- Floating Help menu — keeps the tour trigger reachable from any view. -->
<div class="help-menu" data-testid="project-mode-help-menu">
  <button
    type="button"
    class="cf-btn secondary sm"
    onclick={() => (showKeybindings = true)}
    data-testid="help-menu-shortcuts"
    aria-label="Keyboard shortcuts"
    title="Keyboard shortcuts (?)"
  >
    ?
  </button>
  <button
    type="button"
    class="cf-btn secondary sm"
    onclick={openTour}
    data-testid="help-menu-tour"
    aria-label="Start guided tour"
    title="Start guided tour"
  >
    Tour
  </button>
</div>

{#if showKeybindings}
  <KeybindingsHelp onClose={() => (showKeybindings = false)} />
{/if}

{#if showTour}
  <OnboardingTour visible={showTour} onClose={closeTour} />
{/if}

{#if showSearch}
  <SearchModal
    visible={showSearch}
    profileId={profileId}
    agentId={projectModeStore.activeAgentId}
    projectId={projectModeStore.activeProjectId}
    onClose={() => (showSearch = false)}
  />
{/if}

<style>
  .project-mode-root {
    display: grid;
    grid-template-columns: var(--shell-rail-w) minmax(0, 1fr);
    gap: var(--space-4);
    height: 100%;
    min-height: 0;
  }

  .project-mode-sidebar {
    border-right: 1px solid var(--atlas-line);
    padding-right: var(--space-3);
    overflow-y: auto;
    min-height: 0;
  }

  .project-mode-main {
    overflow-y: auto;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .empty-state {
    margin: var(--space-4) 0;
    color: var(--atlas-ink-3);
  }

  /* Help stays reachable from any view, but it is support chrome, so it sits
     out of the way in the corner rather than in the run console's own header. */
  .help-menu {
    position: absolute;
    bottom: var(--space-4);
    right: var(--space-4);
    display: flex;
    gap: var(--space-2);
    z-index: var(--z-dock);
  }
</style>
