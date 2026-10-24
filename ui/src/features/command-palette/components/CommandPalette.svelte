<script>
  import { FileText, Search, StickyNote } from "lucide-svelte";
  import { commandPaletteService } from "../services/command-palette.service.js";
  import { parseSnippet } from "../snippet.js";
  import { moveSelection } from "../selection.js";

  let { profileId = null, onOpen, onOpenChange } = $props();

  let q = $state("");
  let results = $state([]);
  // Keyboard-cursor index into `results`. The list is click-only without this:
  // a palette that must be mouse-driven is a broken keyboard control.
  let selected = $state(0);
  let isOpen = $state(false);
  let inputEl = $state(null);
  let timer;

  // Debounced search; re-runs on q or profile change.
  $effect(() => {
    const query = q;
    const pid = profileId;
    clearTimeout(timer);
    if (!query.trim() || pid == null) {
      results = [];
      return;
    }
    timer = setTimeout(async () => {
      try {
        results = await commandPaletteService.search(pid, query);
      } catch (e) {
        console.error("search failed:", e);
      }
    }, 120);
  });

  // A new query starts at the top of the list.
  $effect(() => {
    q;
    selected = 0;
  });

  // Editing can shrink the list out from under the cursor. Clamp only when the
  // index is past the end; writing while the list is empty would re-trigger
  // this effect forever.
  $effect(() => {
    const count = results.length;
    if (count > 0 && selected >= count) selected = count - 1;
  });

  // Keep the highlighted row in view while the list is keyboard-scrolled. The
  // method is optional-chained too: jsdom does not implement scrollIntoView,
  // and an unguarded call would throw out of this effect.
  $effect(() => {
    selected;
    document.querySelector(`[data-hit-index="${selected}"]`)?.scrollIntoView?.({ block: "nearest" });
  });

  function closePalette() {
    isOpen = false;
    q = "";
    results = [];
    onOpenChange?.(false);
  }

  // Ctrl/Cmd+K to focus/toggle, Esc to dismiss.
  $effect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        isOpen = !isOpen;
        onOpenChange?.(isOpen);
        if (isOpen) {
          setTimeout(() => inputEl?.focus(), 50);
        } else {
          closePalette();
        }
      } else if (e.key === "Escape") {
        closePalette();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function handleInputKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = moveSelection(results.length, selected, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = moveSelection(results.length, selected, -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[selected]);
    }
  }

  function choose(hit) {
    if (!hit) return;
    closePalette();
    onOpen?.(hit);
  }
</script>

{#if isOpen}
  <!-- Backdrop overlay -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="palette-backdrop" onclick={closePalette}>
    <div class="palette-modal" onclick={(e) => e.stopPropagation()}>
      <div class="palette-input-wrapper">
        <span class="search-icon"><Search size={15} strokeWidth={2} aria-hidden="true" /></span>
        <input
          bind:this={inputEl}
          bind:value={q}
          role="combobox"
          aria-controls="palette-results"
          aria-expanded="true"
          aria-activedescendant={results.length > 0 ? `palette-hit-${selected}` : undefined}
          aria-label="Search notes and PDFs"
          placeholder={profileId == null ? "Select a profile to search…" : "Search notes & PDFs…"}
          disabled={profileId == null}
          onkeydown={handleInputKeydown}
        />
        <kbd class="esc-badge">ESC</kbd>
      </div>

      {#if q.trim() !== ""}
        <div class="palette-results" id="palette-results" role="listbox" aria-label="Search results">
          {#if results.length === 0}
            <div class="no-res">No matches found for "{q}"</div>
          {:else}
            {#each results as hit, i (hit.id)}
              <button
                id="palette-hit-{i}"
                class="hit {i === selected ? 'hit-active' : ''}"
                role="option"
                aria-selected={i === selected}
                data-hit-index={i}
                onclick={() => { selected = i; choose(hit); }}
                onmouseenter={() => selected = i}
              >
                <div class="hit-top">
                  <span class="hit-icon">
                {#if hit.kind === "pdf"}
                  <FileText size={13} strokeWidth={2} aria-hidden="true" />
                {:else}
                  <StickyNote size={13} strokeWidth={2} aria-hidden="true" />
                {/if}
              </span>
                  <span class="hit-title">{hit.title}</span>
                  <span class="hit-subject">{hit.subjectName}</span>
                </div>
                <div class="hit-snip">
                  {#each parseSnippet(hit.snippet) as p}<span class={p.hl ? "hl" : ""}>{p.t}</span>{/each}
                </div>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: var(--atlas-scrim);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }
  .palette-modal {
    width: min(600px, 90vw);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-3);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 70vh;
  }
  .palette-input-wrapper {
    display: flex;
    align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    gap: 12px;
    background: var(--bg-base);
  }
  .search-icon {
    font-size: var(--text-2xl);
    color: var(--fg-muted);
  }
  .palette-modal input {
    flex: 1;
    background: transparent;
    color: var(--fg);
    border: none;
    font-size: var(--text-lg);
    outline: none;
  }
  .palette-modal input:disabled {
    opacity: 0.5;
  }
  .esc-badge {
    background: var(--surface-2);
    color: var(--fg-secondary);
    font-size: var(--text-xs);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
  }
  .palette-results {
    overflow-y: auto;
    flex: 1;
  }
  .no-res {
    padding: 16px;
    color: var(--fg-muted);
    font-size: var(--text-md);
    text-align: center;
  }
  .hit {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    padding: 12px 16px;
    cursor: pointer;
    color: var(--fg);
  }
  .hit:last-child {
    border-bottom: none;
  }
  .hit:hover,
  .hit-active {
    background: var(--surface-2);
  }
  .hit-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hit-title {
    font-weight: 500;
    font-size: var(--text-md);
  }
  .hit-subject {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--fg-muted);
    background: var(--surface-3);
    padding: 2px 8px;
    border-radius: var(--radius-full);
  }
  .hit-snip {
    margin-top: 6px;
    font-size: var(--text-sm);
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hit-snip .hl {
    color: var(--accent-strong);
    background: none;
    border-radius: var(--radius-xs);
    padding: 0 1px;
  }
</style>
