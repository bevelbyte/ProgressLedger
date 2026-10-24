<script>
  // Deadlines — the Plan surface for everything dated.
  //
  // Was: two parallel lanes ("Exams" / "Placements and competitive exams") plus a
  // third completed lane — the same "two columns for one timeline" mistake the
  // Desk's old deadline band made. Rows carried `✓ Done` / `Edit` / glyph
  // buttons that appeared only on hover (invisible on keyboard focus), and a
  // hand-rolled modal.
  //
  // Atlas structure:
  //   1. HEAD      — view name + the honest count readout.
  //   2. BODY      — ONE chronological instrument: overdue → soonest → later,
  //                  active rows above a collapsed-feel completed history.
  //                  The category is a badge on the row; it is metadata, not a
  //                  reason to split the timeline in two.
  //
  // Pace stays: days remaining + the study pace the backend derives from your
  // logged sessions — it is real information, not decoration. Completion,
  // editing, deleting and reopening keep their exact service calls.
  import { Check, RotateCcw, CalendarClock, Plus, CircleAlert } from "lucide-svelte";
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { Menu, Modal } from "../../../shared/components";
  import { deadlinesService } from "../services/deadlines.service.js";
  import { todayLocalISO } from "../../../shared/utils/local-date.js";

  let { profileId = null } = $props();

  let deadlines = $state([]);
  let paces = $state({}); // deadlineId -> DeadlinePace
  let tree = $state([]); // Academic tree for subject dropdown
  let loading = $state(false);
  let showAddModal = $state(false);
  let editingDeadline = $state(null);

  // Form state
  let formSubjectId = $state(null);
  let formDate = $state("");
  let formCategory = $state("exam");
  let formTitle = $state("");
  let formNotes = $state("");

  const allSubjects = $derived.by(() => {
    const subjects = [];
    for (const track of tree) {
      for (const sem of track.semesters) {
        for (const ms of sem.milestones) {
          for (const subj of ms.subjects) {
            subjects.push({ id: subj.id, name: subj.name, trackName: track.name });
          }
        }
      }
    }
    return subjects;
  });

  // Active = not completed; completed deadlines are kept as history below.
  const activeDeadlines = $derived(
    deadlines
      .filter((d) => !d.completedAt)
      .sort((a, b) => a.deadlineDate.localeCompare(b.deadlineDate))
  );
  const completedDeadlines = $derived(
    deadlines
      .filter((d) => d.completedAt)
      .sort((a, b) => b.deadlineDate.localeCompare(a.deadlineDate))
  );

  async function loadTree() {
    if (profileId == null) {
      tree = [];
      return;
    }
    try {
      tree = await deadlinesService.getTree(profileId);
    } catch (e) {
      console.error("loadTree failed:", e);
      tree = [];
    }
  }

  async function load() {
    if (profileId == null) {
      deadlines = [];
      paces = {};
      tree = [];
      return;
    }
    loading = true;
    try {
      await loadTree();
      deadlines = await deadlinesService.list(profileId);
      // Pace for every active deadline in ONE query (was N+1 IPC calls).
      const rows = await deadlinesService.paces(profileId);
      const newPaces = {};
      for (const row of rows) newPaces[row.deadlineId] = row;
      paces = newPaces;
    } catch (e) {
      reportError(e, "Could not load deadlines");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void profileId;
    load();
  });

  $effect(() => {
    const onChanged = () => load();
    window.addEventListener("cf:data-changed", onChanged);
    return () => window.removeEventListener("cf:data-changed", onChanged);
  });

  function openAddModal() {
    editingDeadline = null;
    formSubjectId = allSubjects[0]?.id ?? null;
    formDate = todayLocalISO();
    formCategory = "exam";
    formTitle = "";
    formNotes = "";
    showAddModal = true;
  }

  function openEditModal(d) {
    editingDeadline = d;
    formSubjectId = d.subjectId;
    formDate = d.deadlineDate;
    formCategory = d.category;
    formTitle = d.title;
    formNotes = d.notes;
    showAddModal = true;
  }

  function closeModal() {
    showAddModal = false;
    editingDeadline = null;
  }

  async function saveDeadline() {
    if (!formSubjectId || !formDate || !formTitle.trim()) {
      toast.warning("A deadline needs a subject, a title and a date.");
      return;
    }
    try {
      if (editingDeadline) {
        await deadlinesService.update(
          profileId,
          editingDeadline.id,
          formDate,
          formCategory,
          formTitle.trim(),
          formNotes
        );
        toast.success("Deadline updated", "Saved");
      } else {
        await deadlinesService.add(
          profileId,
          formSubjectId,
          formDate,
          formCategory,
          formTitle.trim(),
          formNotes
        );
        toast.success("Deadline added", "Created");
      }
      closeModal();
      window.dispatchEvent(new Event("cf:data-changed"));
    } catch (e) {
      reportError(e, "Could not save deadline");
    }
  }

  async function deleteDeadline(d) {
    const ok = await confirmDialog({
      title: "Delete deadline",
      message: `Delete “${d.title}”? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deadlinesService.remove(profileId, d.id);
      toast.success("Deadline deleted", "Removed");
      window.dispatchEvent(new Event("cf:data-changed"));
    } catch (e) {
      reportError(e, "Could not delete deadline");
    }
  }

  // Mark complete / reopen — persisted via the Deadlines service; the deadline
  // is never deleted, just moved between active and completed history.
  async function toggleCompletion(d, completed) {
    try {
      await deadlinesService.setCompletion(profileId, d.id, completed);
      toast.success(completed ? "Marked completed" : "Reopened", "Deadline");
      window.dispatchEvent(new Event("cf:data-changed"));
    } catch (e) {
      reportError(e, "Could not update deadline");
    }
  }

  /** The honest urgency read: the pace engine's verdict in one word. */
  function paceLabel(pace) {
    if (!pace) return { text: "", tone: "muted" };
    if (pace.isOverdue) return { text: "overdue", tone: "bad" };
    if (pace.daysRemaining < 7) return { text: `${pace.daysRemaining}d left`, tone: "warn" };
    if (pace.daysRemaining < 30) return { text: `${pace.daysRemaining}d left`, tone: "live" };
    return { text: `${pace.daysRemaining}d left`, tone: "muted" };
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    if (Number.isNaN(d.valueOf())) return dateStr;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function categoryLabel(category) {
    if (category === "gate") return "GATE";
    return category.charAt(0).toUpperCase() + category.slice(1);
  }

  let overdueCount = $derived(activeDeadlines.filter((d) => paces[d.id]?.isOverdue).length);

  function deadlineMenu(d, completed) {
    return [
      completed
        ? { id: "reopen", label: "Reopen", onselect: () => toggleCompletion(d, false) }
        : { id: "done", label: "Mark completed", onselect: () => toggleCompletion(d, true) },
      { id: "edit", label: "Edit", onselect: () => openEditModal(d) },
      { id: "sep", separator: true },
      { id: "del", label: "Delete", danger: true, onselect: () => deleteDeadline(d) },
    ];
  }
</script>

<div class="radar atl-view">
  <header class="radar-head">
    <div class="head-id">
      <h2>Deadlines</h2>
      <p class="standing">
        {#if overdueCount > 0}
          {overdueCount} overdue ·
        {/if}
        {activeDeadlines.length} active · {completedDeadlines.length} completed
      </p>
    </div>
    {#if profileId != null && allSubjects.length > 0}
      <button class="cf-btn primary" onclick={openAddModal}><Plus size={14} /> Add deadline</button>
    {/if}
  </header>

  {#if profileId == null}
    <p class="cf-empty">Select a profile to view deadlines.</p>
  {:else if loading}
    <div class="cf-skeleton skel"></div>
  {:else if allSubjects.length === 0}
    <div class="cf-empty boxed">
      <CalendarClock size={26} />
      <h3>Nothing to attach a deadline to</h3>
      <p>Deadlines belong to subjects. Add a subject in the Degree planner first.</p>
    </div>
  {:else if deadlines.length === 0}
    <div class="cf-empty boxed">
      <CalendarClock size={26} />
      <h3>No deadlines yet</h3>
      <p>Add one to start tracking exams, placements and submissions.</p>
      <button class="cf-btn" onclick={openAddModal}>Add the first deadline</button>
    </div>
  {:else if activeDeadlines.length === 0 && completedDeadlines.length > 0}
    <div class="cf-empty">
      <Check size={24} />
      <h3>No active deadlines</h3>
      <p>Everything here is completed. The history is below.</p>
    </div>
    {@render completedSection()}
  {:else}
    <section class="atl-band">
      <div class="atl-band-head">
        <h3>Active</h3>
        <p class="atl-band-note">Soonest first · pace is derived from your logged study sessions</p>
      </div>
      <div class="deadline-list">
        {#each activeDeadlines as d (d.id)}
          {@const pace = paces[d.id]}
          {@const pl = paceLabel(pace)}
          <div class="deadline" data-tone={pl.tone}>
            <span class="gutter" data-tone={pl.tone}>
              {#if pl.tone === "bad"}<CircleAlert size={11} aria-hidden="true" />{/if}
              {pl.text || formatDate(d.deadlineDate)}
            </span>
            <div class="deadline-main">
              <span class="deadline-title">{d.title}</span>
              <span class="deadline-subject">{d.subjectName}</span>
            </div>
            <span class="cf-badge">{categoryLabel(d.category)}</span>
            {#if pace && !pace.isOverdue && pace.topicsPerDay > 0}
              <span class="pace-rate mono">{pace.topicsPerDay.toFixed(1)}/day</span>
            {:else}
              <span class="pace-rate mono"></span>
            {/if}
            <span class="deadline-date mono">{formatDate(d.deadlineDate)}</span>
            <button
              class="done-btn"
              onclick={() => toggleCompletion(d, true)}
              title="Mark completed"
              aria-label="Mark {d.title} completed"
            >
              <Check size={12} strokeWidth={2.5} aria-hidden="true" /> Done
            </button>
            <Menu label="Deadline options" items={deadlineMenu(d, false)} />
          </div>
        {/each}
      </div>
    </section>

    {@render completedSection()}
  {/if}
</div>

{#snippet completedSection()}
  {#if completedDeadlines.length > 0}
    <section class="atl-band">
      <div class="atl-band-head">
        <h3>Completed</h3>
        <p class="atl-band-note">{completedDeadlines.length} kept as history</p>
      </div>
      <div class="deadline-list">
        {#each completedDeadlines as d (d.id)}
          <div class="deadline completed">
            <span class="gutter" data-tone="muted">
              <RotateCcw size={11} aria-hidden="true" />
            </span>
            <div class="deadline-main">
              <span class="deadline-title">{d.title}</span>
              <span class="deadline-subject">{d.subjectName}</span>
            </div>
            <span class="cf-badge">{categoryLabel(d.category)}</span>
            <span class="pace-rate mono"></span>
            <span class="deadline-date mono">{formatDate(d.deadlineDate)}</span>
            <button class="reopen-btn" onclick={() => toggleCompletion(d, false)} title="Reopen" aria-label="Reopen {d.title}">
              <RotateCcw size={11} aria-hidden="true" /> Reopen
            </button>
            <Menu label="Deadline options" items={deadlineMenu(d, true)} />
          </div>
        {/each}
      </div>
    </section>
  {/if}
{/snippet}

<Modal
  open={showAddModal}
  title={editingDeadline ? "Edit deadline" : "Add deadline"}
  subtitle="A deadline belongs to one subject and one date."
  width={500}
  onClose={closeModal}
>
  {#snippet children()}
    <form class="form" onsubmit={(e) => { e.preventDefault(); saveDeadline(); }}>
      <label class="field">
        <span class="atl-label">Subject</span>
        <select class="cf-select" bind:value={formSubjectId}>
          {#each allSubjects as s}
            <option value={s.id}>{s.trackName} › {s.name}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span class="atl-label">Title</span>
        <input class="cf-input" type="text" bind:value={formTitle} placeholder="e.g. Mid-semester exam" />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="atl-label">Date</span>
          <input class="cf-input" type="date" bind:value={formDate} />
        </label>
        <label class="field">
          <span class="atl-label">Category</span>
          <select class="cf-select" bind:value={formCategory}>
            <option value="exam">Exam</option>
            <option value="placement">Placement</option>
            <option value="gate">GATE / Competitive</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span class="atl-label">Notes</span>
        <textarea class="cf-textarea" bind:value={formNotes} placeholder="Optional notes…" rows="3"></textarea>
      </label>
      <div class="form-actions">
        <button type="button" class="cf-btn ghost sm" onclick={closeModal}>Cancel</button>
        <button type="submit" class="cf-btn primary sm">{editingDeadline ? "Save changes" : "Add deadline"}</button>
      </div>
    </form>
  {/snippet}
</Modal>

<style>
  .radar-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .head-id { display: flex; flex-direction: column; gap: 4px; }
  .radar-head h2 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
  }
  .standing { margin: 0; font-size: var(--text-md); color: var(--atlas-ink-3); font-variant-numeric: tabular-nums; }

  .atl-band-head h3 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--atlas-ink); }

  .deadline-list { display: flex; flex-direction: column; }

  .deadline {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-h);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
    border-top: 1px solid var(--atlas-line);
    font-size: var(--text-md);
  }
  .deadline:hover { background: var(--atlas-wash); }

  .gutter {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
    min-width: 10ch;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
    font-variant-numeric: tabular-nums;
  }
  .gutter[data-tone="bad"] { color: var(--atlas-bad); }
  .gutter[data-tone="warn"] { color: var(--atlas-warn); }
  .gutter[data-tone="live"] { color: var(--atlas-signal); }

  .deadline-main { flex: 1; display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
  .deadline-title {
    font-weight: 550;
    color: var(--atlas-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .deadline.completed .deadline-title { text-decoration: line-through; color: var(--atlas-ink-3); }
  .deadline-subject {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pace-rate {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    min-width: 7ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .mono { font-family: var(--font-mono); }
  .deadline-date { font-size: var(--text-micro); color: var(--atlas-ink-3); min-width: 6.5ch; text-align: right; }

  .done-btn, .reopen-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 9px;
    border-radius: var(--radius-full);
    border: 1px solid var(--atlas-line);
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
    font-size: var(--text-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  .done-btn:hover { color: var(--atlas-ok); border-color: var(--atlas-ok); background: var(--atlas-ok-bg); }
  .reopen-btn:hover { color: var(--atlas-signal); border-color: var(--atlas-signal); }

  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
  .form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }

  .skel { height: 160px; }
</style>
