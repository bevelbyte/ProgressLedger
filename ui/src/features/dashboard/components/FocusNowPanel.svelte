<script>
  /**
   * FocusNowPanel — "Focus Now" section on the Dashboard.
   *
   * Renders the top-N subject recommendations from buildAcademicFocus().
   * The component does NOT compute the algorithm — it receives a pre-built
   * `focus` model. The Dashboard owns the IPC + the algorithm call; this
   * component owns only the rendering, the action wiring, and the empty
   * state.
   *
   * Actions are restricted to those the algorithm actually returned
   * (no fake buttons). The two supported actions map to:
   *   openSubject  -> onOpenSubject(subjectId)   (subject workspace)
   *   openRecall   -> onNavigate("flashcards")   (Recall Deck for the subject)
   *
   * Subject filter for "openRecall": the Recall Deck page is global, so
   * we only offer Review when the user has cards due AND the subject
   * appears in the upcoming recall feed. We do not pretend a per-subject
   * recall filter exists in the UI.
   */
  import { ArrowRight, BookOpen, Brain, Sparkles, CheckCircle2 } from "lucide-svelte";

  let {
    focus = null, // {items, empty, message} from buildAcademicFocus
    onOpenSubject = () => {},
    onNavigate = () => {},
  } = $props();
</script>

<section class="focus-now" aria-label="Academic focus">
  <header class="focus-head">
    <h2><Sparkles size={15} aria-hidden="true" /> Focus Now</h2>
    <span class="focus-sub">
      {#if focus?.empty}
        Nothing urgent. Your current workload is under control.
      {:else}
        {focus?.message ?? ""}
      {/if}
    </span>
  </header>

  {#if focus?.empty}
    <p class="focus-empty">
      <CheckCircle2 size={15} aria-hidden="true" /> No subjects need attention right now.
    </p>
  {:else if focus?.items?.length}
    <ol class="focus-list">
      {#each focus.items as item (item.subjectId)}
        <li class="focus-item">
          <div class="focus-row">
            <div class="focus-meta">
              <span class="focus-name">
                {item.subjectName}
                {#if item.code}<span class="focus-code">· {item.code}</span>{/if}
              </span>
              <span class="focus-reason">{item.reason}</span>
            </div>
            <div class="focus-actions">
              {#if item.actions.includes("openSubject")}
                <button
                  type="button"
                  class="focus-cta"
                  onclick={() => onOpenSubject(item.subjectId)}
                  title="Open subject workspace"
                >
                  <BookOpen size={13} aria-hidden="true" /> Open
                </button>
              {/if}
              {#if item.actions.includes("openRecall")}
                <button
                  type="button"
                  class="focus-cta ghost"
                  onclick={() => onNavigate("flashcards")}
                  title="Open Recall Deck"
                >
                  <Brain size={13} aria-hidden="true" /> Review
                </button>
              {/if}
              <span class="focus-go" aria-hidden="true">
                <ArrowRight size={13} />
              </span>
            </div>
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .focus-now {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4) var(--space-5);
  }
  .focus-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }
  .focus-head h2 {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0;
    color: var(--fg);
  }
  .focus-sub {
    font-size: var(--text-sm);
    color: var(--fg-muted);
  }
  .focus-empty {
    margin: 0;
    font-size: var(--text-md);
    color: var(--fg-muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .focus-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .focus-item {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .focus-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
  }
  .focus-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .focus-name {
    font-size: var(--text-md);
    color: var(--fg);
    font-weight: 500;
  }
  .focus-code {
    color: var(--fg-muted);
    font-weight: 400;
  }
  .focus-reason {
    font-size: var(--text-sm);
    color: var(--fg-muted);
  }
  .focus-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .focus-cta {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    font-size: var(--text-sm);
    cursor: pointer;
    transition: var(--trans-fast);
  }
  .focus-cta.ghost {
    background: transparent;
    color: var(--fg-secondary);
    border: 1px solid var(--border);
  }
  .focus-cta.ghost:hover {
    background: var(--bg-hover);
    color: var(--fg);
  }
  .focus-cta:hover {
    background: var(--accent-strong);
  }
  .focus-go {
    color: var(--fg-muted);
  }
</style>
