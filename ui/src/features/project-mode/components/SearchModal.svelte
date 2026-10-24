<script>
  // SearchModal — global Cmd+K search overlay for Project Mode.
  //
  // Searches across the active agent's messages, memory entries, installed
  // skills, tools, and plugins. All data is fetched once when the modal
  // opens (or when the active agent changes) and filtered client-side on
  // each keystroke with a small debounce. No new IPC channels are added;
  // we reuse the existing agent:list-messages, memory:list, skills:list,
  // tools:list, and plugins:list calls.
  //
  // Clicking a result closes the modal. The user is already in Project
  // Mode where the relevant panels are accessible.

  import { Brain, FileText, MessageSquare, Puzzle, Search, Target, Wrench, X } from "lucide-svelte";
  import { searchModalService } from "../services/searchModal.service.js";
  import { reportError } from "../../../shared/utils/errors.js";

  let { visible = false, profileId = null, agentId = null, projectId = null, onClose } = $props();

  let q = $state("");
  let hits = $state([]);
  let selected = $state(0);
  let loading = $state(false);
  let data = $state({ messages: [], memory: [], skills: [], tools: [], plugins: [] });
  let timer;

  // Keyboard navigation inside the modal: Up/Down move the highlight,
  // Enter closes the modal (the user can then interact with the panel
  // that contains the chosen item), Esc closes outright.
  function onInputKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, Math.max(0, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(0, selected - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hits[selected]) choose(hits[selected]);
    }
  }

  // Debounced filter over the already-fetched data blob.
  $effect(() => {
    const query = q;
    clearTimeout(timer);
    if (!query.trim()) {
      hits = [];
      selected = 0;
      return;
    }
    timer = setTimeout(() => {
      hits = searchModalService.search(data, query);
      selected = 0;
    }, 150);
  });

  // Keep the highlighted row in view. jsdom does not implement
  // scrollIntoView so we optional-chain the call.
  $effect(() => {
    selected;
    document.querySelector(`[data-hit-index="${selected}"]`)?.scrollIntoView?.({ block: "nearest" });
  });

  // Fetch all searchable data when the modal opens or the agent changes.
  $effect(() => {
    if (!visible) return;
    if (profileId == null) {
      data = { messages: [], memory: [], skills: [], tools: [], plugins: [] };
      hits = [];
      return;
    }
    loading = true;
    searchModalService
      .fetchAll(profileId, agentId, projectId)
      .then((blob) => {
        data = blob;
        // Re-filter with the current query in case data just arrived.
        if (q.trim()) {
          hits = searchModalService.search(blob, q);
        }
      })
      .catch((e) => reportError(e, "Search modal: failed to load data"))
      .finally(() => {
        loading = false;
      });
  });

  // Reset state when the modal closes so the next open starts fresh.
  $effect(() => {
    if (!visible) {
      q = "";
      hits = [];
      selected = 0;
    }
  });

  function close() {
    onClose?.();
  }

  function choose(hit) {
    close();
  }

  // Result kind → icon component. Was a switch returning emoji, which meant
  // six different typefaces inside one result list.
  const KIND_ICONS = {
    message: MessageSquare,
    memory: Brain,
    skill: Target,
    tool: Wrench,
    plugin: Puzzle,
    file: FileText,
  };

  function kindIcon(kind) {
    return KIND_ICONS[kind] ?? FileText;
  }

  function kindLabel(kind) {
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }

  // Group hits by kind for display, preserving the order messages,
  // memory, skill, tool, plugin.
  const KIND_ORDER = ["message", "memory", "skill", "tool", "plugin"];
  let groups = $derived.by(() => {
    const g = {};
    for (const k of KIND_ORDER) g[k] = [];
    for (const h of hits) {
      if (g[h.kind]) g[h.kind].push(h);
    }
    return g;
  });
</script>

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={close} role="presentation" data-testid="search-backdrop">
    <div
      class="modal"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
      tabindex="-1"
      data-testid="search-modal"
    >
      <header class="modal-header" data-testid="search-header">
        <span class="search-icon" aria-hidden="true"><Search size={15} strokeWidth={2} /></span>
        <input
          bind:value={q}
          onkeydown={onInputKeydown}
          role="combobox"
          aria-controls="search-results"
          aria-expanded={visible && q.trim().length > 0}
          aria-autocomplete="list"
          aria-activedescendant={hits[selected] ? `search-hit-${hits[selected].id}` : undefined}
          aria-label="Search messages, memory, skills, tools, plugins"
          placeholder="Type to search messages, memory, skills, tools, plugins…"
          data-testid="search-input"
          spellcheck="false"
          autocomplete="off"
        />
        <button class="close-btn" onclick={close} data-testid="search-close" aria-label="Close search">
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <div class="modal-body" id="search-results" data-testid="search-results" role="listbox" aria-label="Search results">
        {#if loading}
          <div class="loading-state" data-testid="search-loading">Loading search index…</div>
        {:else if q.trim() === ""}
          <div class="empty-state" data-testid="search-empty">
            <p>Type to search across messages, memory, skills, tools, and plugins.</p>
            <p class="hint">Press <kbd>Esc</kbd> to close.</p>
          </div>
        {:else if hits.length === 0}
          <div class="no-res" data-testid="search-no-match">
            No matches found for "{q}"
          </div>
        {:else}
          {#each KIND_ORDER as kind}
            {#if groups[kind].length > 0}
              <div class="group" data-testid="search-group-{kind}">
                <div class="group-label">{kindLabel(kind)} ({groups[kind].length})</div>
                {#each groups[kind] as hit, i (hit.id)}
                  {@const HitIcon = kindIcon(hit.kind)}
                  {@const globalIndex = KIND_ORDER.indexOf(hit.kind) === 0
                    ? groups[kind].indexOf(hit)
                    : hits.indexOf(hit)}
                  <button
                    class="hit {hits.indexOf(hit) === selected ? 'hit-active' : ''}"
                    id="search-hit-{hit.id}"
                    role="option"
                    aria-selected={hits.indexOf(hit) === selected}
                    data-hit-index={hits.indexOf(hit)}
                    onclick={() => choose(hit)}
                    onmouseenter={() => selected = hits.indexOf(hit)}
                    data-testid="search-hit-{hit.kind}"
                  >
                    <div class="hit-top">
                      <span class="hit-icon" aria-hidden="true">
                        <HitIcon size={13} strokeWidth={2} />
                      </span>
                      <span class="hit-title">{hit.title}</span>
                      {#if hit.subtitle}
                        <span class="hit-sub">{hit.subtitle}</span>
                      {/if}
                    </div>
                    {#if hit.snippet}
                      <div class="hit-snip">{hit.snippet}</div>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          {/each}
        {/if}
      </div>

      <footer class="modal-footer" data-testid="search-footer">
        <span class="count" data-testid="search-count">
          {hits.length} result{hits.length !== 1 ? "s" : ""}
        </span>
        <span class="nav-hint">
          <kbd>↑↓</kbd> navigate &nbsp; <kbd>Enter</kbd> select &nbsp; <kbd>Esc</kbd> close
        </span>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 600;
    background: var(--atlas-scrim);
    backdrop-filter: blur(4px);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 8vh;
  }

  .modal {
    width: min(640px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl);
    box-shadow: 0 16px 48px var(--atlas-scrim);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 75vh;
  }

  .modal-header {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
    gap: 10px;
  }

  .search-icon {
    font-size: var(--text-2xl);
    flex-shrink: 0;
  }

  .modal-header input {
    flex: 1;
    background: transparent;
    color: var(--text-main);
    border: none;
    font-size: var(--text-xl);
    outline: none;
    font-family: inherit;
  }

  .close-btn {
    font-size: var(--text-xl);
    color: var(--text-muted);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    flex-shrink: 0;
    transition: color var(--trans-fast), border-color var(--trans-fast);
  }

  .close-btn:hover {
    color: var(--text-main);
    border-color: var(--border);
  }

  .modal-body {
    overflow-y: auto;
    flex: 1;
    padding: 8px 0;
  }

  .loading-state, .empty-state, .no-res {
    padding: 32px 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--text-lg);
  }

  .empty-state .hint {
    margin-top: 8px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .group-label {
    padding: 6px 16px 4px;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .hit {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    padding: 10px 16px;
    cursor: pointer;
    color: var(--text-main);
    transition: background var(--trans-fast, 120ms ease);
  }

  .hit:last-child { border-bottom: none; }

  .hit:hover, .hit-active {
    background: var(--surface-raised);
  }

  .hit-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .hit-icon {
    font-size: var(--text-xl);
    flex-shrink: 0;
  }

  .hit-title {
    font-weight: 600;
    font-size: var(--text-lg);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hit-sub {
    font-size: var(--text-sm);
    color: var(--text-muted);
    background: var(--bg-main);
    padding: 1px 8px;
    border-radius: var(--radius-full);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .hit-snip {
    margin-top: 4px;
    font-size: var(--text-sm);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    background: var(--surface-raised);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .nav-hint kbd {
    display: inline-block;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1px 5px;
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    white-space: nowrap;
  }
</style>
