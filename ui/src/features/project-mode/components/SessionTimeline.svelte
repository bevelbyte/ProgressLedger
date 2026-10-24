<script>
  // SessionTimeline — full message stream for an agent with cursor pagination.
  //
  // Mirrors the live conversation view, but reads from a paginated service so
  // long sessions can be scrolled through in chunks. The first page is fetched
  // on mount (or when profileId/agentId change); the "Load more" button pulls
  // older messages using the last seen id as the `before` cursor.
  //
  // Read-only. Does NOT touch the agent loop or any message-storage state.

  import { projectModeService } from "../services/projectMode.service.js";

  let { profileId = null, agentId = null, pageSize = 50 } = $props();

  let messages = $state([]);
  let loading = $state(false);
  let loadingMore = $state(false);
  let error = $state(null);
  let hasMore = $state(true);
  let searchQuery = $state("");

  // Reset + load the first page whenever profileId or agentId changes.
  $effect(() => {
    if (profileId != null && agentId != null) {
      reset();
    } else {
      messages = [];
      hasMore = false;
    }
  });

  function reset() {
    messages = [];
    hasMore = true;
    error = null;
    loadFirst();
  }

  async function loadFirst() {
    if (profileId == null || agentId == null) return;
    loading = true;
    error = null;
    try {
      const res = await projectModeService.listMessagesPaginated(
        profileId,
        agentId,
        pageSize,
        null
      );
      const list = Array.isArray(res) ? res : [];
      messages = list;
      if (list.length < pageSize) hasMore = false;
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      messages = [];
      hasMore = false;
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (!hasMore || loadingMore || messages.length === 0) return;
    const cursor = messages[messages.length - 1].id;
    loadingMore = true;
    error = null;
    try {
      const res = await projectModeService.listMessagesPaginated(
        profileId,
        agentId,
        pageSize,
        cursor
      );
      const list = Array.isArray(res) ? res : [];
      // Avoid duplicates if the cursor moved between calls.
      const existing = new Set(messages.map((m) => m.id));
      const appended = list.filter((m) => !existing.has(m.id));
      messages = [...messages, ...appended];
      if (list.length < pageSize || appended.length === 0) hasMore = false;
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    } finally {
      loadingMore = false;
    }
  }

  function roleIcon(role) {
    if (role === "user") return "[U]";
    if (role === "assistant") return "[A]";
    if (role === "tool_call") return "[>]";
    if (role === "tool_result") return "[R]";
    if (role === "system") return "[S]";
    if (role === "status") return "[i]";
    return "[?]";
  }

  function renderPayload(payloadJson, content) {
    const raw = payloadJson || content;
    if (!raw) return "";
    try {
      const obj = JSON.parse(raw);
      return JSON.stringify(obj, null, 2);
    } catch (_e) {
      return raw;
    }
  }

  function timeAgo(iso) {
    const ts = Date.parse(iso);
    if (!ts || isNaN(ts)) return "";
    const delta = Math.floor((Date.now() - ts) / 1000);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  }

  // Build a single searchable string from a message (text + payload + name).
  function messageText(m) {
    // Native rows are camelCase (`payloadJson`); fixtures use the Rust name.
    // Searching only the snake name never matched a real tool payload.
    const parts = [m.content || "", m.name || "", m.payloadJson ?? m.payload_json ?? ""];
    return parts.join(" ").toLowerCase();
  }

  // Filtered view — empty query returns all messages.
  function getFilteredMessages() {
    if (!searchQuery) return messages;
    const q = searchQuery.toLowerCase();
    return messages.filter((m) => messageText(m).includes(q));
  }

  function clearSearch() {
    searchQuery = "";
  }
</script>

<div class="timeline" data-testid="session-timeline">
  <header class="timeline-header">
    <h3>Session timeline</h3>
    <span class="count" data-testid="timeline-count">
      {#if searchQuery}
        {getFilteredMessages().length} / {messages.length}
      {:else}
        {messages.length} message{messages.length === 1 ? "" : "s"}
      {/if}
    </span>
  </header>

  <div class="search-bar">
    <input
      type="text"
      class="search-input"
      placeholder="Filter messages…"
      value={searchQuery}
      data-testid="timeline-search-input"
      oninput={(e) => { searchQuery = e.currentTarget.value; }}
    />
    {#if searchQuery}
      <button
        type="button"
        class="search-clear"
        data-testid="timeline-search-clear"
        onclick={clearSearch}
        aria-label="Clear search"
      >
        Clear
      </button>
    {/if}
  </div>

  {#if error}
    <p class="error" role="alert" data-testid="timeline-error">{error}</p>
  {/if}

  {#if loading && messages.length === 0}
    <p class="loading" data-testid="timeline-loading">Loading timeline…</p>
  {:else if messages.length === 0 && profileId != null && agentId != null}
    <p class="empty" data-testid="timeline-empty">No messages in this session yet.</p>
  {:else if searchQuery && getFilteredMessages().length === 0}
    <p class="empty" data-testid="timeline-no-match">No messages match "{searchQuery}".</p>
  {:else}
    <ol class="stream" data-testid="timeline-stream">
      {#each getFilteredMessages() as m (m.id)}
        <li class="entry" data-role={m.role} data-testid={`timeline-entry-${m.id}`}>
          <div class="entry-head">
            <span class="role-icon" data-testid={`timeline-role-${m.id}`}>{roleIcon(m.role)}</span>
            <span class="role-pill" data-testid={`timeline-pill-${m.id}`}>{m.role || "unknown"}</span>
            {#if m.name}
              <span class="entry-name" data-testid={`timeline-name-${m.id}`}>{m.name}</span>
            {/if}
            {#if m.createdAt ?? m.created_at}
              <span class="entry-time mono" data-testid={`timeline-time-${m.id}`}>
                {timeAgo(m.createdAt ?? m.created_at)}
              </span>
            {/if}
          </div>
          {#if m.role === "assistant" || m.role === "system" || m.role === "user" || m.role === "status"}
            <div class="text" data-testid={`timeline-text-${m.id}`}>{m.content}</div>
          {:else if m.role === "tool_call"}
            <div class="card call" data-testid={`timeline-card-call-${m.id}`}>
              <div class="card-name">{m.name || "tool"}</div>
              <pre class="args">{renderPayload(m.payloadJson ?? m.payload_json, m.content)}</pre>
            </div>
          {:else if m.role === "tool_result"}
            <div class="card result" data-testid={`timeline-card-result-${m.id}`}>
              <div class="card-name">{m.name || "result"}</div>
              <pre class="args">{renderPayload(m.payloadJson ?? m.payload_json, m.content)}</pre>
            </div>
          {:else}
            <div class="text">{m.content}</div>
          {/if}
        </li>
      {/each}
    </ol>

    <div class="footer">
      {#if hasMore}
        <button
          type="button"
          class="more-btn"
          data-testid="timeline-load-more"
          onclick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      {:else if messages.length > 0}
        <span class="end-marker" data-testid="timeline-end">— end of session —</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface, var(--atlas-panel));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-md);
    padding: 10px 12px;
    color: var(--text-main, var(--atlas-ink));
  }
  .timeline-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .timeline-header h3 {
    margin: 0;
    font-size: var(--text-lg);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted, var(--atlas-ink-2));
  }
  .count {
    font-size: var(--text-sm);
    color: var(--text-muted, var(--atlas-ink-2));
    font-family: var(--mono, monospace);
  }
  .search-bar {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .search-input {
    flex: 1;
    background: var(--bg-main, var(--atlas-void));
    border: 1px solid var(--border, var(--atlas-line-2));
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    font-size: var(--text-md);
    color: var(--text-main, var(--atlas-ink));
    font-family: var(--mono, monospace);
    outline: none;
  }
  .search-input:focus {
    border-color: var(--accent, var(--atlas-signal));
  }
  .search-input::placeholder {
    color: var(--text-muted, var(--atlas-ink-2));
    font-family: var(--font-sans, sans-serif);
  }
  .search-clear {
    background: var(--accent, var(--atlas-signal));
    color: var(--bg-main, var(--atlas-void));
    border: none;
    border-radius: var(--radius-sm);
    padding: 3px 10px;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  .search-clear:hover {
    opacity: 0.85;
  }
  .loading,
  .empty,
  .error {
    font-size: var(--text-md);
    padding: 4px 4px 4px 8px;
  }
  .error {
    color: var(--atlas-bad);
  }
  .empty {
    color: var(--text-muted, var(--atlas-ink-2));
    font-style: italic;
  }
  .stream {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 70vh;
    overflow-y: auto;
  }
  .entry {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-left: 2px solid var(--border, var(--atlas-line-2));
    padding-left: 8px;
  }
  .entry[data-role="assistant"] { border-left-color: var(--accent, var(--atlas-signal)); }
  .entry[data-role="user"] { border-left-color: var(--atlas-ok); }
  .entry[data-role="tool_call"] { border-left-color: var(--atlas-warn); }
  .entry[data-role="tool_result"] { border-left-color: var(--atlas-signal); }
  .entry[data-role="system"] { border-left-color: var(--text-muted, var(--atlas-ink-2)); }
  .entry-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .role-icon {
    font-family: var(--mono, monospace);
    font-size: var(--text-sm);
    color: var(--accent, var(--atlas-signal));
    background: var(--bg-main, var(--atlas-void));
    padding: 1px 6px;
    border-radius: var(--radius-xs);
  }
  .role-pill {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted, var(--atlas-ink-2));
    background: var(--bg-main, var(--atlas-void));
    padding: 1px 8px;
    border-radius: var(--radius-full);
  }
  .entry-name {
    font-size: var(--text-sm);
    color: var(--accent, var(--atlas-signal));
    font-weight: 500;
  }
  .entry-time {
    margin-left: auto;
    font-family: var(--mono, monospace);
    font-size: var(--text-xs);
    color: var(--text-muted, var(--atlas-ink-2));
  }
  .text {
    background: var(--bg-main, var(--atlas-void));
    color: var(--text-main, var(--atlas-ink));
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    font-size: var(--text-md);
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .card {
    background: var(--bg-main, var(--atlas-void));
    border: 1px solid var(--border, var(--atlas-line));
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .card.call { border-color: var(--atlas-warn); }
  .card.result { border-color: var(--atlas-signal); }
  .card-name {
    font-size: var(--text-md);
    font-weight: 500;
    color: var(--accent, var(--atlas-signal));
  }
  .args {
    font-family: ui-monospace, monospace;
    font-size: var(--text-sm);
    color: var(--text-secondary, var(--atlas-ink-2));
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .footer {
    display: flex;
    justify-content: center;
    padding-top: 4px;
  }
  .more-btn {
    background: var(--accent, var(--atlas-signal));
    color: var(--bg-main, var(--atlas-void));
    border: none;
    border-radius: var(--radius-sm);
    padding: 4px 14px;
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .more-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .more-btn:hover:not(:disabled) {
    opacity: 0.85;
  }
  .end-marker {
    font-size: var(--text-sm);
    color: var(--text-muted, var(--atlas-ink-2));
    font-style: italic;
  }
  .mono {
    font-family: var(--mono, monospace);
  }
</style>
