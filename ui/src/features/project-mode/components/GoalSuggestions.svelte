<script>
  import { tick } from "svelte";

  // GoalSuggestions — quick-start chips for the agent's objective input.
  //
  // New users open Project Mode and stare at an empty objective box
  // without knowing what the agent can do. This renders 7 ready-made
  // goals as chips; clicking one appends its text (plus a trailing
  // space) to the bound objective so the user can immediately type the
  // specifics (file name, test name, error message). A Show/Hide toggle
  // lets a user who has picked up the habit collapse the row.
  //
  // Presentational only: no IPC, no stores, no agent-loop coupling. The
  // parent owns the objective string through a two-way `goal` binding.

  /**
   * @typedef {{ label: string, hint: string }} Suggestion
   */
  /** @type {Suggestion[]} */
  const SUGGESTIONS = [
    { label: "Refactor this file", hint: "File path / pattern to refactor:" },
    { label: "Add tests for", hint: "Module, class, or function to cover:" },
    { label: "Explain this error", hint: "Paste the error message:" },
    { label: "Document this module", hint: "Module to document:" },
    { label: "Find bugs in", hint: "Directory or file to audit:" },
    { label: "Generate a README", hint: "Optional scope for the README:" },
    { label: "Write a plan first", hint: "What should the plan cover?" },
  ];

  /** @type {import("svelte").Bindable<string>} */
  let {
    goal = $bindable(""),
    inputTestId = "goal-input",
    ariaLabel = "Objective for the agent",
    placeholder = "Describe the objective for the agent…",
  } = $props();

  /** Suggestions start expanded: first-time users are the whole point. */
  let open = $state(true);
  let textarea = $state(/** @type {HTMLTextAreaElement | null} */(null));

  async function pick(text) {
    const sep = goal && !goal.endsWith(" ") && !goal.endsWith("\n") ? " " : "";
    goal = `${goal}${sep}${text} `;
    // Focus + end-of-text caret only make sense once the textarea has
    // received the new value, which happens on the next flush.
    await tick();
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }

  function toggle() {
    open = !open;
  }
</script>

<section class="goal-input-block" data-testid="goal-input-block">
  <div class="objective-row">
    <textarea
      class="objective-input"
      bind:this={textarea}
      {ariaLabel}
      {placeholder}
      rows="2"
      bind:value={goal}
      data-testid={inputTestId}
    ></textarea>
    <button
      class="toggle-btn"
      type="button"
      onclick={toggle}
      aria-expanded={open}
      aria-controls="goal-suggestions"
      data-testid="goal-suggestions-toggle"
    >
      {open ? "Hide suggestions" : "Show suggestions"}
    </button>
  </div>

  {#if open}
    <div class="suggestions" id="goal-suggestions" role="group" aria-label="Goal suggestions" data-testid="goal-suggestions">
      {#each SUGGESTIONS as s, i}
        <button
          class="chip"
          type="button"
          onclick={() => pick(s.label)}
          title={s.hint}
          data-testid="goal-suggestion-chip-{i}"
        >{s.label}</button>
      {/each}
    </div>
  {/if}
</section>

<style>
  /* flex:1 so this block fills the row it is mounted in (ProjectWorkspace
     keeps the "Run agent" CTA to its right). Harmless standalone. */
  .goal-input-block { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; }

  .objective-row { display: flex; gap: 8px; align-items: stretch; }

  .objective-input {
    flex: 1; min-height: 56px; resize: vertical;
    background: var(--bg-main); color: var(--text-main);
    border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: 8px 10px; font-family: inherit; font-size: var(--text-lg);
  }
  .objective-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .objective-input::placeholder { color: var(--text-muted); }

  /* Mirrors the "Run agent" button next to it, just quieter. */
  .toggle-btn {
    align-self: flex-end;
    padding: 6px 10px; border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--surface); color: var(--text-muted);
    font-size: var(--text-md); cursor: pointer; white-space: nowrap;
    font-family: inherit;
    transition: color var(--trans-fast), border-color var(--trans-fast), background var(--trans-fast);
  }
  .toggle-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .suggestions {
    display: flex; flex-wrap: wrap; gap: 6px;
    align-items: center;
  }

  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 5px 10px; border-radius: var(--radius-full);
    border: 1px solid var(--border);
    background: var(--surface); color: var(--text-secondary);
    font-size: var(--text-md); font-family: inherit;
    cursor: pointer; line-height: 1.35;
    transition: color var(--trans-fast), border-color var(--trans-fast),
      background var(--trans-fast), transform var(--trans-fast);
  }
  .chip::before {
    content: "+";
    font-size: var(--text-md); line-height: 1;
    color: var(--text-muted);
    transition: color var(--trans-fast);
  }
  .chip:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
    transform: translateY(-1px);
  }
  .chip:hover::before { color: var(--accent); }
  .chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
