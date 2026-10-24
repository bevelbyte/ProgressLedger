<script>
  // Career Plan — a profile's career goals and the roadmap toward them.
  //
  // Atlas treatment: the roadmap is a numbered instrument. Each milestone gets a
  // step gutter, so "where am I on this path" is answerable by scanning one
  // column, and the completion state is a worded badge rather than a colour.
  //
  // Numbers stay honest: the readout is a count of real milestones, and there is
  // no readiness score anywhere, because the product has no such data.
  //
  // Preserved deliberately (the subject-link E2E drives these directly, by
  // accessible name and by class): `.milestone`, `.link-picker` + its Save
  // button, `.m-link-subject` + "Remove link", the "Link Subject" label, the
  // "Linked subject no longer exists" state, the `{track} › {semester} › {name}`
  // option label, and the linked project/subject names rendered as button text.

  import {
    Plus, Edit2, Trash2, Check, RotateCcw, ChevronUp, ChevronDown,
    Star, Link, Unlink, BookOpen,
  } from "lucide-svelte";
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { careerService } from "../services/career.service.js";
  import {
    goalStatusLabel, primaryGoal, isComplete, progressText, nextMilestone, formatTargetDate, milestoneDateState, linkedSubjectState,
  } from "../career-view.js";
  import GoalFormModal from "./GoalFormModal.svelte";
  import MilestoneFormModal from "./MilestoneFormModal.svelte";

  let { profileId = null, onNavigate = () => {}, onOpenSubject = () => {} } = $props();

  let goals = $state([]);
  let milestones = $state([]);
  let selectedGoalId = $state(null);
  let loading = $state(false);
  let loadingPid = $state(null);
  let goalModal = $state({ open: false, editing: null });
  let milestoneModal = $state({ open: false, editing: null });
  let linkPickerMilestoneId = $state(null);
  let subjectPickerMilestoneId = $state(null);
  let projectList = $state([]);
  let subjectList = $state([]);
  let linkBusy = $state(false);
  let linkProjectId = $state(null);
  let linkSubjectId = $state(null);

  // Selected goal (defaults to primary/first); falls back if the selection is stale.
  const goal = $derived(goals.find((g) => g.id === selectedGoalId) ?? primaryGoal(goals));
  const next = $derived(nextMilestone(milestones));

  // Real counts, derived from the milestones we actually loaded.
  const doneCount = $derived(milestones.filter((m) => isComplete(m)).length);
  const pct = $derived(milestones.length ? Math.round((doneCount / milestones.length) * 100) : 0);

  async function load(pid) {
    if (pid == null) { goals = []; milestones = []; selectedGoalId = null; projectList = []; return; }
    loadingPid = pid;
    loading = true;
    try {
      const g = await careerService.listGoals(pid);
      if (loadingPid !== pid) return;
      goals = g;
      const keep = g.find((x) => x.id === selectedGoalId);
      const active = keep ?? primaryGoal(g);
      selectedGoalId = active ? active.id : null;
      milestones = active ? await careerService.listMilestones(pid, active.id) : [];
      projectList = await window.careerflow.projects.list(pid);
      // Load academic tree for subject picker
      const tree = await window.careerflow.academic.tree(pid);
      const subjects = [];
      for (const track of tree) {
        for (const sem of track.semesters) {
          for (const ms of sem.milestones) {
            for (const subj of ms.subjects) {
              subjects.push({ id: subj.id, name: subj.name, track: track.name, semester: sem.name });
            }
          }
        }
      }
      subjectList = subjects;
    } catch (e) {
      if (loadingPid === pid) { goals = []; milestones = []; reportError(e, "Could not load career plan"); }
    } finally {
      if (loadingPid === pid) loading = false;
    }
  }

  $effect(() => { load(profileId); });

  async function selectGoal(id) {
    selectedGoalId = id;
    try {
      milestones = await careerService.listMilestones(profileId, id);
    } catch (e) {
      reportError(e, "Could not load roadmap");
    }
  }

  async function makePrimary() {
    if (!goal || goal.isPrimary) return;
    try {
      await careerService.setPrimaryGoal(profileId, goal.id);
      await load(profileId);
      toast.success("Primary goal updated");
    } catch (e) {
      reportError(e, "Could not set primary goal");
    }
  }

  // ---- Goal actions ----
  function openAddGoal() { goalModal = { open: true, editing: null }; }
  function openEditGoal() { goalModal = { open: true, editing: goal }; }

  async function onSaveGoal(input) {
    try {
      if (goalModal.editing) {
        await careerService.updateGoal({ profileId, id: goalModal.editing.id, ...input });
        toast.success("Goal updated");
      } else {
        const newId = await careerService.addGoal({ profileId, ...input, isPrimary: goals.length === 0 });
        selectedGoalId = newId;
        toast.success("Career goal created");
      }
      goalModal = { open: false, editing: null };
      await load(profileId);
    } catch (e) {
      reportError(e, "Could not save goal");
    }
  }

  async function deleteGoal() {
    const ok = await confirmDialog({
      title: "Delete goal",
      message: `Delete "${goal.title}" and its roadmap? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await careerService.deleteGoal(profileId, goal.id);
      await load(profileId);
    } catch (e) {
      reportError(e, "Could not delete goal");
    }
  }

  // ---- Milestone actions ----
  function openAddMilestone() { milestoneModal = { open: true, editing: null }; }
  function openEditMilestone(m) { milestoneModal = { open: true, editing: m }; }

  async function onSaveMilestone(input) {
    try {
      if (milestoneModal.editing) {
        await careerService.updateMilestone({ profileId, id: milestoneModal.editing.id, ...input });
      } else {
        await careerService.addMilestone({ profileId, goalId: goal.id, ...input });
      }
      milestoneModal = { open: false, editing: null };
      await load(profileId);
    } catch (e) {
      reportError(e, "Could not save milestone");
    }
  }

  async function toggleMilestone(m) {
    try {
      await careerService.setMilestoneCompletion(profileId, m.id, !isComplete(m));
      await load(profileId);
    } catch (e) {
      reportError(e, "Could not update milestone");
    }
  }

  async function deleteMilestone(m) {
    const ok = await confirmDialog({ title: "Delete milestone", message: `Delete "${m.title}"?`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await careerService.deleteMilestone(profileId, m.id);
      await load(profileId);
    } catch (e) {
      reportError(e, "Could not delete milestone");
    }
  }

  // Reorder by swapping with a neighbour, then persist the full order.
  async function move(index, dir) {
    const target = index + dir;
    if (target < 0 || target >= milestones.length) return;
    const reordered = [...milestones];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    milestones = reordered; // optimistic
    try {
      await careerService.reorderMilestones(profileId, goal.id, reordered.map((m) => m.id));
    } catch (e) {
      reportError(e, "Could not reorder");
      await load(profileId);
    }
  }

  // ---- Linking ----
  function toggleLinkPicker(milestoneId) {
    linkPickerMilestoneId = linkPickerMilestoneId === milestoneId ? null : milestoneId;
  }

  function toggleSubjectPicker(milestoneId) {
    subjectPickerMilestoneId = subjectPickerMilestoneId === milestoneId ? null : milestoneId;
  }

  async function setMilestoneProject(milestoneId, projectId) {
    linkBusy = true;
    try {
      await careerService.setMilestoneProject(profileId, milestoneId, projectId);
      linkPickerMilestoneId = null;
      toast.success(projectId ? "Project linked" : "Link removed");
      await load(profileId);
    } catch (e) {
      reportError(e, "Could not update project link");
    } finally {
      linkBusy = false;
    }
  }

  async function setMilestoneSubject(milestoneId, subjectId) {
    linkBusy = true;
    try {
      await careerService.setMilestoneSubject(profileId, milestoneId, subjectId);
      subjectPickerMilestoneId = null;
      toast.success(subjectId ? "Subject linked" : "Link removed");
      await load(profileId);
    } catch (e) {
      reportError(e, "Could not update subject link");
    } finally {
      linkBusy = false;
    }
  }

  function openProject(projectId) {
    if (typeof projectId !== "number") return;
    window.dispatchEvent(new CustomEvent("cf:open-project", { detail: { projectId } }));
  }

  /** Status word for the goal, as a badge tone (§21: colour never alone). */
  function statusTone(status) {
    if (status === "achieved") return "success";
    if (status === "paused") return "neutral";
    return "accent";
  }

  /** Date-state word, reusing the deadline vocabulary for the same meaning. */
  function dateWord(state) {
    if (state === "overdue") return "overdue";
    if (state === "today") return "today";
    if (state === "soon") return "soon";
    return "";
  }
</script>

<div class="career-plan">
  {#if profileId == null}
    <div class="empty">
      <h3>No workspace selected</h3>
      <p>Select a profile to plan your career.</p>
    </div>
  {:else if loading && goals.length === 0}
    <div class="empty">
      <p class="atl-label">Career</p>
      <h3>Loading career plan…</h3>
    </div>
  {:else if !goal}
    <div class="empty">
      <p class="atl-label">Career</p>
      <h3>No career goal yet</h3>
      <p>Define where you want to go, then build a roadmap toward it. Milestones can link to the subjects and projects already in your workspace.</p>
      <button class="cf-btn primary" onclick={openAddGoal}><Plus size={14} strokeWidth={2} /> Add Career Goal</button>
    </div>
  {:else}
    <!-- Goal switcher — only when there is a choice to make -->
    {#if goals.length > 1}
      <div class="goal-switcher" role="tablist" aria-label="Career goals">
        {#each goals as g (g.id)}
          <button
            class="goal-pill"
            class:active={g.id === goal.id}
            role="tab"
            aria-selected={g.id === goal.id}
            onclick={() => selectGoal(g.id)}
          >
            {#if g.isPrimary}<Star size={11} strokeWidth={2} aria-hidden="true" />{/if}{g.title}
          </button>
        {/each}
        <button class="goal-pill add" onclick={openAddGoal} title="Add another goal" aria-label="Add another goal">
          <Plus size={12} strokeWidth={2} />
        </button>
      </div>
    {/if}

    <header class="goal-head">
      <div class="goal-title">
        <p class="atl-label">Career goal</p>
        <h2>
          {goal.title}
          <span class="cf-badge {statusTone(goal.status)} status-badge">{goalStatusLabel(goal.status)}</span>
          {#if goal.isPrimary}<span class="cf-badge accent primary-badge"><Star size={10} strokeWidth={2} aria-hidden="true" /> Primary</span>{/if}
        </h2>
        <p class="goal-sub">
          {#if goal.targetRole}{goal.targetRole}{/if}{#if goal.targetRole && goal.domain} · {/if}{#if goal.domain}{goal.domain}{/if}
          {#if goal.targetDate} · target {formatTargetDate(goal.targetDate)}{/if}
        </p>
        {#if goal.description}<p class="goal-desc">{goal.description}</p>{/if}
      </div>
      <div class="goal-actions">
        {#if !goal.isPrimary}
          <button class="cf-btn ghost sm" onclick={makePrimary}><Star size={13} strokeWidth={1.8} /> Make primary</button>
        {/if}
        <button class="cf-btn ghost sm" onclick={openAddGoal}><Plus size={13} strokeWidth={1.8} /> New goal</button>
        <button class="cf-btn ghost sm" onclick={openEditGoal}><Edit2 size={13} strokeWidth={1.8} /> Edit</button>
        <button class="cf-btn ghost sm danger" onclick={deleteGoal}><Trash2 size={13} strokeWidth={1.8} /> Delete</button>
      </div>
    </header>

    <!-- Standing readout: how far, and what is next -->
    <div class="summary">
      <div class="readout">
        <span class="atl-label">Roadmap</span>
        <div class="readout-line">
          <span class="readout-num tabular">{doneCount}<span class="of">/{milestones.length}</span></span>
          <span class="readout-text">{progressText(milestones)}</span>
        </div>
        <div class="bar" aria-hidden="true">
          <div class="bar-fill" class:full={milestones.length > 0 && doneCount === milestones.length} style="width: {pct}%"></div>
        </div>
      </div>

      {#if next}
        {@const nState = milestoneDateState(next)}
        <div class="readout next-chip">
          <span class="atl-label">Next step</span>
          <div class="readout-line">
            <span class="readout-text strong">{next.title}</span>
            {#if next.targetDate}
              <span class="m-date {nState}">{formatTargetDate(next.targetDate)}{#if dateWord(nState)} · {dateWord(nState)}{/if}</span>
            {/if}
          </div>
        </div>
      {:else if milestones.length > 0}
        <div class="readout next-chip done">
          <span class="atl-label">Next step</span>
          <div class="readout-line"><span class="readout-text strong">Every milestone is complete.</span></div>
        </div>
      {/if}
    </div>

    <!-- Roadmap -->
    <section class="roadmap">
      <div class="roadmap-head">
        <span class="atl-label">Roadmap</span>
        <span class="roadmap-count tabular">{milestones.length} step{milestones.length === 1 ? "" : "s"}</span>
        <button class="cf-btn primary sm add-btn" onclick={openAddMilestone}><Plus size={13} strokeWidth={2} /> Add milestone</button>
      </div>

      {#if milestones.length === 0}
        <p class="muted">No milestones yet. Add the first step toward this goal.</p>
      {:else}
        <div class="milestone-list">
          {#each milestones as m, i (m.id)}
            {@const ls = linkedSubjectState(m)}
            {@const mState = milestoneDateState(m)}
            <div class="milestone {isComplete(m) ? 'completed' : ''}" data-step={i + 1}>
              <!-- The step gutter: the path is a sequence, so the order is visible. -->
              <span class="step-gutter tabular">{String(i + 1).padStart(2, "0")}</span>

              <button
                class="check"
                onclick={() => toggleMilestone(m)}
                title={isComplete(m) ? "Reopen" : "Mark complete"}
                aria-label={isComplete(m) ? `Reopen ${m.title}` : `Mark ${m.title} complete`}
                aria-pressed={isComplete(m)}
              >
                {#if isComplete(m)}<Check size={13} strokeWidth={2.4} />{/if}
              </button>

              <div class="m-body">
                <div class="m-head">
                  <span class="m-title">{m.title}</span>
                  {#if m.targetDate}
                    <span class="m-date {mState}">
                      {formatTargetDate(m.targetDate)}
                      {#if dateWord(mState)}· {dateWord(mState)}{/if}
                    </span>
                  {/if}
                </div>

                {#if m.description}<span class="m-desc">{m.description}</span>{/if}

                <!-- Project link -->
                <div class="m-link">
                  {#if m.linkedProjectId !== null && m.linkedProjectId !== undefined}
                    {#if m.linkedProjectName}
                      <span class="link-label">
                        <Link size={12} strokeWidth={1.8} aria-hidden="true" />
                        <button class="link-btn" onclick={() => openProject(m.linkedProjectId)}>{m.linkedProjectName}</button>
                      </span>
                      <button class="mini" onclick={() => setMilestoneProject(m.id, null)} title="Remove link"><Unlink size={12} /></button>
                    {:else}
                      <span class="link-label muted"><Link size={12} strokeWidth={1.8} aria-hidden="true" /> Linked project no longer exists</span>
                      <button class="mini" onclick={() => setMilestoneProject(m.id, null)} title="Remove link"><Unlink size={12} /></button>
                    {/if}
                  {:else}
                    <button class="mini link-action" onclick={() => toggleLinkPicker(m.id)}>
                      <Link size={12} strokeWidth={1.8} aria-hidden="true" /> Link Project
                    </button>
                    {#if linkPickerMilestoneId === m.id}
                      <div class="link-picker">
                        <select class="cf-select" bind:value={linkProjectId} disabled={linkBusy} aria-label="Choose a project to link">
                          <option value={null}>Select a project…</option>
                          {#each projectList as p (p.id)}
                            <option value={p.id}>{p.name}</option>
                          {/each}
                        </select>
                        <button class="mini primary" onclick={() => setMilestoneProject(m.id, linkProjectId)} disabled={linkBusy || !linkProjectId}>
                          Save
                        </button>
                        <button class="mini" onclick={() => { linkPickerMilestoneId = null; }}>Cancel</button>
                      </div>
                    {/if}
                  {/if}
                </div>

                <!-- Subject link -->
                <div class="m-link m-link-subject">
                  {#if ls.state === "linked"}
                    <span class="link-label">
                      <BookOpen size={12} strokeWidth={1.8} aria-hidden="true" />
                      <button class="link-btn" onclick={() => onOpenSubject(ls.id)}>{ls.name}</button>
                    </span>
                    <button class="mini" onclick={() => setMilestoneSubject(m.id, null)} title="Remove link"><Unlink size={12} /></button>
                  {:else if ls.state === "missing"}
                    <span class="link-label muted"><BookOpen size={12} strokeWidth={1.8} aria-hidden="true" /> Linked subject no longer exists</span>
                    <button class="mini" onclick={() => setMilestoneSubject(m.id, null)} title="Remove link"><Unlink size={12} /></button>
                  {:else}
                    <button class="mini link-action" onclick={() => toggleSubjectPicker(m.id)}>
                      <BookOpen size={12} strokeWidth={1.8} aria-hidden="true" /> Link Subject
                    </button>
                    {#if subjectPickerMilestoneId === m.id}
                      <div class="link-picker">
                        <select class="cf-select" bind:value={linkSubjectId} disabled={linkBusy} aria-label="Choose a subject to link">
                          <option value={null}>Select a subject…</option>
                          {#each subjectList as s (s.id)}
                            <option value={s.id}>{s.track} › {s.semester} › {s.name}</option>
                          {/each}
                        </select>
                        <button class="mini primary" onclick={() => setMilestoneSubject(m.id, linkSubjectId)} disabled={linkBusy || !linkSubjectId}>
                          Save
                        </button>
                        <button class="mini" onclick={() => { subjectPickerMilestoneId = null; }}>Cancel</button>
                      </div>
                    {/if}
                  {/if}
                </div>
              </div>

              <div class="m-actions">
                <button class="mini" onclick={() => move(i, -1)} disabled={i === 0} title="Move up" aria-label={`Move ${m.title} up`}><ChevronUp size={13} /></button>
                <button class="mini" onclick={() => move(i, 1)} disabled={i === milestones.length - 1} title="Move down" aria-label={`Move ${m.title} down`}><ChevronDown size={13} /></button>
                {#if isComplete(m)}
                  <button class="mini" onclick={() => toggleMilestone(m)} title="Reopen"><RotateCcw size={13} /></button>
                {/if}
                <button class="mini" onclick={() => openEditMilestone(m)} title="Edit" aria-label={`Edit ${m.title}`}><Edit2 size={13} /></button>
                <button class="mini del" onclick={() => deleteMilestone(m)} title="Delete" aria-label={`Delete ${m.title}`}><Trash2 size={13} /></button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<GoalFormModal open={goalModal.open} editing={goalModal.editing} onSave={onSaveGoal} onClose={() => (goalModal = { open: false, editing: null })} />
<MilestoneFormModal open={milestoneModal.open} editing={milestoneModal.editing} onSave={onSaveMilestone} onClose={() => (milestoneModal = { open: false, editing: null })} />

<style>
  .career-plan {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /* ---- Empty states ---- */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-10) var(--space-4);
    text-align: center;
  }

  .empty h3 {
    margin: 4px 0 0;
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--atlas-ink);
  }

  .empty p {
    margin: 0;
    max-width: 56ch;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    line-height: 1.55;
  }

  .empty .cf-btn {
    margin-top: var(--space-2);
  }

  /* ---- Goal switcher: the same segmented instrument used for view tabs ---- */
  .goal-switcher {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-md);
    background: var(--atlas-chrome);
    width: fit-content;
    max-width: 100%;
  }

  .goal-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: var(--ctl-h-sm);
    padding: 0 10px;
    border-radius: var(--radius-sm);
    color: var(--atlas-ink-2);
    font-size: var(--text-sm);
    max-width: 26ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .goal-pill:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink);
  }

  .goal-pill.active {
    background: var(--atlas-raise);
    color: var(--atlas-ink);
  }

  .goal-pill :global(svg) {
    color: var(--atlas-warn);
    flex-shrink: 0;
  }

  .goal-pill.add {
    color: var(--atlas-ink-3);
  }

  .goal-pill.add:hover {
    color: var(--atlas-signal-2);
  }

  /* ---- Goal header ---- */
  .goal-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-5);
    flex-wrap: wrap;
  }

  .goal-title {
    min-width: 0;
  }

  .goal-title h2 {
    margin-top: 3px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: var(--text-2xl);
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--atlas-ink);
  }

  .status-badge,
  .primary-badge {
    font-size: var(--text-micro);
  }

  .goal-sub {
    margin: 5px 0 0;
    color: var(--atlas-ink-2);
    font-size: var(--text-md);
  }

  .goal-desc {
    margin: 6px 0 0;
    max-width: 70ch;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    line-height: 1.55;
  }

  .goal-actions {
    display: flex;
    gap: var(--space-1);
    flex-wrap: wrap;
  }

  /* ---- Readouts ---- */
  .summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-4);
  }

  .readout {
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-md);
    background: var(--atlas-panel);
    padding: var(--space-3) var(--space-4);
    min-width: 0;
  }

  .readout-line {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-top: 4px;
    flex-wrap: wrap;
  }

  .readout-num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-metric);
    font-weight: 600;
    letter-spacing: -0.03em;
    color: var(--atlas-ink);
    line-height: 1.1;
  }

  .readout-num .of {
    color: var(--atlas-ink-3);
    font-size: var(--text-lg);
  }

  .readout-text {
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
  }

  .readout-text.strong {
    color: var(--atlas-ink);
    font-size: var(--text-md);
  }

  .bar {
    margin-top: var(--space-3);
    height: 3px;
    border-radius: var(--radius-full);
    background: var(--atlas-raise);
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    background: var(--atlas-signal);
    transition: width var(--dur-slow) var(--ease);
  }

  .bar-fill.full {
    background: var(--atlas-ok);
  }

  .next-chip.done .readout-text.strong {
    color: var(--atlas-ok);
  }

  /* ---- Roadmap instrument ---- */
  .roadmap {
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    background: var(--atlas-panel);
    padding: var(--space-4);
  }

  .roadmap-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-bottom: var(--space-2);
    margin-bottom: var(--space-2);
    border-bottom: 1px solid var(--atlas-line);
  }

  .roadmap-count {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--atlas-ink-3);
  }

  .add-btn {
    margin-left: auto;
  }

  .muted {
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    margin: 0;
  }

  .milestone-list {
    display: flex;
    flex-direction: column;
  }

  /* Hairline rows, not cards. A roadmap is one path, not eight objects. */
  .milestone {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3) 0;
  }

  .milestone + .milestone {
    border-top: 1px solid var(--atlas-line);
  }

  .milestone.completed .m-title {
    color: var(--atlas-ink-3);
    text-decoration: line-through;
    text-decoration-color: var(--atlas-line-2);
  }

  .step-gutter {
    flex: 0 0 22px;
    padding-top: 3px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--atlas-ink-3);
    text-align: right;
  }

  .milestone.completed .step-gutter {
    color: var(--atlas-ok);
  }

  .check {
    flex: 0 0 auto;
    margin-top: 1px;
    width: 18px;
    height: 18px;
    border-radius: var(--radius-full);
    border: 1px solid var(--atlas-line-2);
    background: transparent;
    color: var(--atlas-ok);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
  }

  .check:hover {
    border-color: var(--atlas-ok);
  }

  .milestone.completed .check {
    background: var(--atlas-ok-bg);
    border-color: var(--atlas-ok);
  }

  .m-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .m-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .m-title {
    color: var(--atlas-ink);
    font-size: var(--text-md);
    font-weight: 500;
  }

  .m-desc {
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .m-date {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--atlas-ink-3);
  }

  .m-date.overdue { color: var(--atlas-bad); }
  .m-date.today { color: var(--atlas-warn); }
  .m-date.soon { color: var(--atlas-signal-2); }

  .m-link {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .link-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-sm);
    color: var(--atlas-ink-2);
  }

  .link-label.muted {
    color: var(--atlas-ink-3);
  }

  .link-label :global(svg) {
    color: var(--atlas-ink-3);
  }

  .link-btn {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--atlas-signal-2);
    cursor: pointer;
    font: inherit;
    font-size: var(--text-sm);
  }

  .link-btn:hover {
    text-decoration: underline;
  }

  .link-action {
    font-size: var(--text-xs);
  }

  .link-picker {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .link-picker .cf-select {
    height: var(--ctl-h-sm);
    font-size: var(--text-sm);
    max-width: 280px;
  }

  /* Row actions are quiet until the row is engaged, so the path reads first. */
  .m-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0.4;
    transition: opacity var(--dur-fast) var(--ease);
  }

  .milestone:hover .m-actions,
  .milestone:focus-within .m-actions {
    opacity: 1;
  }

  .mini {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: var(--ctl-h-sm);
    min-width: var(--ctl-h-sm);
    padding: 0 6px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
    cursor: pointer;
    font-size: var(--text-xs);
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease);
  }

  .mini:hover:not(:disabled) {
    background: var(--atlas-hover);
    color: var(--atlas-ink);
    border-color: var(--atlas-line-2);
  }

  .mini:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .mini.del:hover {
    color: var(--atlas-bad);
    border-color: var(--atlas-bad);
  }

  .mini.primary {
    background: var(--atlas-signal);
    color: var(--atlas-signal-ink);
    border-color: transparent;
    font-weight: 600;
  }

  .mini.primary:hover:not(:disabled) {
    background: var(--atlas-signal-2);
    color: var(--atlas-signal-ink);
  }

  /* Kept as a class name; Atlas primary is the single signal button. */
  .primary-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--ctl-h);
    padding: 0 12px;
    border-radius: var(--radius-md);
    background: var(--atlas-signal);
    border: none;
    color: var(--atlas-signal-ink);
    font-size: var(--text-md);
    font-weight: 600;
    cursor: pointer;
  }

  .primary-btn:hover {
    background: var(--atlas-signal-2);
  }

  @media (max-width: 900px) {
    .summary { grid-template-columns: 1fr; }
  }
</style>
