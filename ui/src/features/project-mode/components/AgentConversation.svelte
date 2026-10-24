<script>
  // AgentConversation — renders the live transcript for the active agent.
  //
  // Roles we know about: system, user, assistant, tool_call, tool_result,
  // status. Unknown roles fall through as a plain text bubble.

  import { projectModeStore } from "../stores/projectMode.svelte.js";

  function renderPayload(payloadJson) {
    if (!payloadJson) return "";
    try {
      const obj = JSON.parse(payloadJson);
      return JSON.stringify(obj, null, 2);
    } catch (_e) {
      return payloadJson;
    }
  }
</script>

<div class="conversation" data-testid="agent-conversation">
  <h3 class="title">Conversation</h3>

  {#if projectModeStore.loadingMessages}
    <div class="hint">Loading…</div>
  {:else if projectModeStore.messages.length === 0}
    <div class="hint">No messages yet. Run an agent to begin.</div>
  {:else}
    <ol class="messages">
      {#each projectModeStore.messages as m (m.id)}
        <li class="message" data-role={m.role} data-testid={`message-${m.role}`}>
          <div class="role-pill">{m.role}</div>
          {#if m.role === "assistant" || m.role === "system" || m.role === "user" || m.role === "status"}
            <div class="text">{m.content}</div>
          {:else if m.role === "tool_call"}
            <div class="card">
              <div class="card-name">{m.name || "tool"}</div>
              <pre class="args">{renderPayload(m.payloadJson ?? m.payload_json ?? m.content)}</pre>
            </div>
          {:else if m.role === "tool_result"}
            <div class="card result">
              <div class="card-name">{m.name || "result"}</div>
              <pre class="args">{renderPayload(m.payloadJson ?? m.payload_json ?? m.content)}</pre>
            </div>
          {:else}
            <div class="text">{m.content}</div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .conversation {
    display: flex; flex-direction: column; gap: 8px;
    border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: 12px; background: var(--surface);
    min-height: 0; overflow-y: auto;
  }
  .title { margin: 0; font-size: var(--text-md); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
  .hint { color: var(--text-muted); font-size: var(--text-md); }
  .messages { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
  .message { display: flex; flex-direction: column; gap: 4px; }
  .role-pill {
    align-self: flex-start; font-size: var(--text-xs); text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--text-muted);
    background: var(--bg-main); padding: 2px 8px; border-radius: var(--radius-full);
  }
  .text {
    background: var(--bg-main); color: var(--text-main);
    padding: 8px 12px; border-radius: var(--radius-md);
    font-size: var(--text-lg); line-height: 1.4; white-space: pre-wrap;
  }
  .message[data-role="assistant"] .text { background: var(--accent-soft); }
  .message[data-role="user"] .text { background: var(--surface); border: 1px solid var(--border); }
  .card {
    background: var(--bg-main); border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: 8px 12px; display: flex; flex-direction: column; gap: 4px;
  }
  .card-name { font-size: var(--text-md); font-weight: 500; color: var(--accent); }
  .card.result { border-color: var(--border); }
  .args {
    font-family: ui-monospace, monospace; font-size: var(--text-sm); color: var(--text-secondary);
    margin: 0; white-space: pre-wrap; word-break: break-word;
  }
</style>