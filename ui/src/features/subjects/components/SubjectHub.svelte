<script>
  // SubjectHub — composition only.
  //
  // This file used to carry ~800 lines of `:global()` CSS for the whole subjects
  // feature: a second, shadow design system that every other surface could
  // (and did) reach into. Styling now belongs to the component that renders the
  // markup, so this file holds data loading and nothing else.
  //
  // The public face of the feature is:
  //   SubjectList   — the Spaces index
  //   SubjectDetail — the Space workspace (docs/DESIGN-ATLAS.md §5.2)
  import { Library } from "lucide-svelte";
  import {
    loadSubjectTree,
    loadCourseMarks,
    loadRecentSessions,
    subjectStore
  } from "../stores/subject.svelte.js";
  import SubjectList from "./SubjectList.svelte";
  import SubjectDetail from "./SubjectDetail.svelte";

  let {
    profileId = null,
    onOpenNote,
    onNavigate = () => {},
    onStartFocus = null,
    /** The record this pane's tab is showing (`workspace/model.js` →
     *  `subjectOf`), owned by the shell, not by this component. */
    entity = null,
    /** Ask the shell to re-point (or clear) that identity. */
    onEntityChange = () => {},
  } = $props();

  let viewMode = $state("hub"); // "hub" | "detail"
  let selectedSubject = $state(null);

  // The deep link needs no second channel: the tab's ENTITY is the request.
  // A subject opened from a Today item arrives here as `entity`, and every pane
  // reads its OWN tab, so one pane can hold CS301 while another holds CS410 (the
  // old shell had a single shell-wide pendingSubjectId, which both panes
  // consumed). The write-back below is a no-op once the two agree, which is what
  // keeps this effect from looping.
  $effect(() => {
    const wanted = entity;
    if (wanted == null) {
      if (viewMode !== "hub" || selectedSubject !== null) {
        viewMode = "hub";
        selectedSubject = null;
      }
      return;
    }
    // The subject list is IPC-backed, so the identity may arrive before the
    // rows do; the effect re-runs when they land.
    if (subjectStore.allSubjects.length === 0) return;
    const match = subjectStore.allSubjects.find((s) => String(s.id) === String(wanted));
    if (match && String(selectedSubject?.id ?? "") !== String(wanted)) {
      selectedSubject = match;
      viewMode = "detail";
    }
  });

  // Load subject tree when profileId changes
  $effect(() => {
    if (profileId != null) {
      loadSubjectTree(profileId);
      loadCourseMarks(profileId);
      loadRecentSessions(profileId);
    } else {
      viewMode = "hub";
      selectedSubject = null;
    }
  });

  // Reload course marks when academic/course data changes elsewhere (e.g. CGPA).
  $effect(() => {
    const handler = () => {
      if (profileId != null) {
        loadSubjectTree(profileId);
        loadCourseMarks(profileId);
        loadRecentSessions(profileId);
      }
    };
    window.addEventListener("cf:data-changed", handler);
    return () => window.removeEventListener("cf:data-changed", handler);
  });

  function selectSubject(subj) {
    selectedSubject = subj;
    viewMode = "detail";
    // Keep the tab's identity in step with what the pane shows: the shell's
    // `subjectOf` answer and the visible workspace are then the same fact.
    onEntityChange(subj.id);
  }

  function backToHub() {
    viewMode = "hub";
    selectedSubject = null;
    onEntityChange(null);
  }
</script>

{#if !profileId}
  <div class="cf-empty">
    <Library size={30} />
    <h3>No profile selected</h3>
    <p>Select or create a profile to manage your subjects.</p>
  </div>
{:else if viewMode === "hub"}
  <SubjectList {profileId} onSelect={selectSubject} {onNavigate} />
{:else if viewMode === "detail" && selectedSubject}
  <SubjectDetail
    {profileId}
    bind:selectedSubject
    {onOpenNote}
    {onNavigate}
    {onStartFocus}
    onBack={backToHub}
  />
{/if}

<style>
  .cf-empty h3 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--atlas-ink);
  }
  .cf-empty p {
    margin: 0;
    font-size: var(--text-md);
    color: var(--atlas-ink-3);
  }
</style>
