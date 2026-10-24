<script>
  /**
   * Pane view resolver.
   *
   * The shell used to hold ONE `{#if currentView === "..."}` chain in App.svelte.
   * A workspace can show several destinations at once, so the chain has to be
   * callable per pane. Moving it here (unchanged in behaviour, identical props)
   * is what makes multiple panes possible without duplicating the mapping, and it
   * keeps App.svelte responsible for composition rather than for every view's
   * wiring.
   *
   * `view` is a view-registry id. An unknown id renders nothing rather than
   * throwing — a restored or future destination must degrade, not blank the app.
   */

  import { SubjectHub } from "../features/subjects";
  import { DeadlineRadar } from "../features/deadlines";
  import { MistakeLedger } from "../features/mistakes";
  import { RecallDeck } from "../features/recall-deck";
  import { Dashboard } from "../features/dashboard";
  import { StudySessions } from "../features/study-sessions";
  import { CgpaPlanner } from "../features/cgpa";
  import { LabTracker } from "../features/labs";
  import { ProjectTracker } from "../features/projects";
  import { FormulaBoard } from "../features/formula-board";
  import { ProjectModePanel } from "../features/project-mode";
  import { GoalsView } from "../features/goals";
  import { CareerPlan } from "../features/career";
  import { ProfileManager } from "../features/profiles";
  import BrowserSurface from "../features/browser/components/BrowserSurface.svelte";
  import ResearchLedger from "../features/browser/components/ResearchLedger.svelte";
  import SettingsHub from "./SettingsHub.svelte";

  let {
    view,
    paneMode = "content",
    profileId = null,
    profiles = [],
    activeProfile = null,
    onSelectProfile = () => {},
    onOpenSubject = () => {},
    onNavigate = () => {},
    onStartFocus = () => {},
    onOpenNote = () => {},
    /** The record the ACTIVE TAB of this pane is showing (null = a plain
     *  surface). Passed down, not shared: each pane holds its own. */
    entity = null,
    onEntityChange = () => {},
    pendingAgentId = null,
    pendingProjectId = null,
    onBackupRestored = () => {},
    onOpenResearchSource = () => {},
    researchPageId = null,
    /** True while a shell overlay is open: a native browser view cannot be
     *  z-covered by DOM, so it is hidden instead of layered. */
    occluded = false,
  } = $props();
</script>

{#if view === "home"}
  <div class="view-container wide">
    <Dashboard
      {profileId}
      {profiles}
      {activeProfile}
      {onSelectProfile}
      {onOpenSubject}
      {onNavigate}
      {onStartFocus}
    />
  </div>
{:else if view === "cgpa"}
  <div class="view-container">
    <CgpaPlanner {profileId} {onOpenSubject} {onNavigate} />
  </div>
{:else if view === "tree"}
  <div class="view-container wide">
    <SubjectHub
      {profileId}
      {onOpenNote}
      {onNavigate}
      onStartFocus={(subjectId) => onStartFocus(subjectId)}
      entity={entity ?? null}
      {onEntityChange}
    />
  </div>
{:else if view === "labs"}
  <div class="view-container">
    <LabTracker {profileId} />
  </div>
{:else if view === "projects"}
  <div class="view-container">
    <ProjectTracker {profileId} />
  </div>
{:else if view === "flashcards"}
  <div class="view-container">
    <RecallDeck {profileId} />
  </div>
{:else if view === "mistakes"}
  <div class="view-container">
    <MistakeLedger {profileId} />
  </div>
{:else if view === "formulas"}
  <div class="view-container">
    <FormulaBoard {profileId} />
  </div>
{:else if view === "deadlines"}
  <div class="view-container">
    <DeadlineRadar {profileId} />
  </div>
{:else if view === "sessions"}
  <div class="view-container">
    <StudySessions {profileId} />
  </div>
{:else if view === "profiles"}
  <div class="view-container">
    <ProfileManager onSelect={onSelectProfile} />
  </div>
{:else if view === "settings"}
  <div class="view-container">
    <SettingsHub {profiles} {activeProfile} onRestored={onBackupRestored} />
  </div>
{:else if view === "project"}
  <div class="view-container flush">
    <ProjectModePanel {profileId} {pendingAgentId} {pendingProjectId} />
  </div>
{:else if view === "goals"}
  <div class="view-container">
    <GoalsView {profileId} />
  </div>
{:else if view === "career"}
  <div class="view-container">
    <CareerPlan {profileId} {onOpenSubject} />
  </div>
{:else if view === "page"}
  <!-- The embedded browser (D2-D6 plan, Phase 1). `entity` IS the opaque
       browser page id: the workspace carries the identity on the tab, exactly
       as it does for a subject, so a page tab is an ordinary workspace tab. -->
  <div class="view-container flush">
    {#if paneMode === "margin"}
      <!-- A margin that follows browser work yields the source/capture ledger, not a duplicate browser chrome. -->
      {#key profileId}
        <ResearchLedger {profileId} {researchPageId} {onOpenResearchSource} />
      {/key}
    {:else}
      <BrowserSurface
        pageId={entity ?? null}
        {profileId}
        {occluded}
        onPageChange={(id) => onEntityChange(id)}
      />
    {/if}
  </div>
{:else if view === "research-ledger"}
  <div class="view-container flush">
    {#key profileId}
      <ResearchLedger {profileId} {researchPageId} {onOpenResearchSource} />
    {/key}
  </div>
{/if}

<style>
  /* The container rules live with the resolver because every pane uses them.
     They are the same three shapes App.svelte had: padded readable default,
     full width for multi-column views, and flush for views that own their own
     panes (the Runs console). */
  .view-container {
    padding: var(--space-6);
    max-width: 1400px;
    margin: 0 auto;
    animation: view-in var(--dur-slow) var(--ease);
  }

  .view-container.wide {
    max-width: none;
  }

  .view-container.flush {
    padding: 0;
    max-width: none;
    height: 100%;
    animation: none;
  }

  @keyframes view-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
