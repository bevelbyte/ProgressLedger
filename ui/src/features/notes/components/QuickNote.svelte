<script>
  import { X } from "lucide-svelte";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { noteService } from "../services/note.service.js";

  let { open = false, profileId = null, academicTree = [], onClose } = $props();

  let title = $state("");
  let content = $state("");
  let subjectId = $state(null);
  let saving = $state(false);

  // Get all subjects from academic tree for the picker
  let allSubjects = $derived.by(() => {
    const subjects = [];
    for (const track of academicTree) {
      for (const sem of track.semesters || []) {
        for (const ms of sem.milestones || []) {
          for (const subj of ms.subjects || []) {
            subjects.push({
              id: subj.id,
              name: subj.name,
              path: `${track.name} › ${sem.name} › ${ms.title}`,
            });
          }
        }
      }
    }
    return subjects;
  });

  // Reset form when opening
  $effect(() => {
    if (open) {
      title = "";
      content = "";
      saving = false;
      subjectId = allSubjects[0]?.id ?? null;
      // Focus the title input after a tick
      setTimeout(() => {
        document.querySelector(".quick-note-modal input")?.focus();
      }, 50);
    }
  });

  async function save() {
    if (!title.trim()) {
      toast.warning("Please give the note a title.", "Missing title");
      return;
    }
    if (!profileId) {
      toast.warning("Select a profile first.", "No profile");
      return;
    }
    // Notes are owned by a subject: attaching them to a real subject keeps
    // them inside the planner's managed tree. The old auto-created inbox
    // track was silently deleted by the next planner sync.
    if (!subjectId) {
      toast.warning("Add a subject in the Degree Planner first — notes live inside a subject.", "No subject");
      return;
    }

    saving = true;
    try {
      // profileId FIRST: noteService.addNote(profileId, subjectId, title,
      // content). Dropping it shifted every argument one slot left and filed
      // the note against the subject id as a profile, with the body written
      // into the title column and no body at all.
      await noteService.addNote(profileId, subjectId, title.trim(), content);
      toast.success("Quick note saved!", "Alt+N");
      window.dispatchEvent(new Event("cf:data-changed"));
      onClose?.();
    } catch (e) {
      reportError(e, "Could not save quick note");
    } finally {
      saving = false;
    }
  }

  function handleKeydown(e) {
    if (e.key === "Escape") {
      onClose?.();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      save();
    }
  }
</script>

{#if open}
  <div
    class="quick-note-backdrop"
    role="button"
    tabindex="0"
    aria-label="Close quick note"
    onclick={() => onClose?.()}
    onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onClose?.()}
  >
    <div
      class="quick-note-modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { e.stopPropagation(); handleKeydown(e); }}
    >
      <header>
        <div class="head-left">
          <span class="shortcut-badge">Alt+N</span>
          <h2>Quick Note</h2>
        </div>
        <button class="close-btn" onclick={() => onClose?.()} aria-label="Close" title="Close"
          ><X size={13} strokeWidth={2} aria-hidden="true" /></button>
      </header>

      <div class="body">
        {#if allSubjects.length === 0}
          <p class="no-subjects">
            This profile has no subjects yet. Quick notes live inside a subject —
            add one in the Degree Planner, then press Alt+N again.
          </p>
        {:else}
          <select class="subject-select" bind:value={subjectId} aria-label="Attach note to subject">
            {#each allSubjects as s (s.id)}
              <option value={s.id}>{s.path} › {s.name}</option>
            {/each}
          </select>
        {/if}
        <input
          type="text"
          class="title-input"
          placeholder="Note title..."
          bind:value={title}
          onkeydown={(e) => e.key === "Enter" && document.querySelector('.content-input')?.focus()}
        />
        <textarea
          class="content-input"
          placeholder="What's on your mind? (Markdown supported)"
          bind:value={content}
          rows="8"
        ></textarea>
      </div>

      <footer>
        <div class="hints">
          <span class="hint">Ctrl+Enter to save</span>
          <span class="hint">Esc to close</span>
        </div>
        <div class="actions">
          <button class="cf-btn ghost" onclick={() => onClose?.()}>Cancel</button>
          <button class="cf-btn primary" onclick={save} disabled={saving || !title.trim() || !subjectId}>
            {saving ? "Saving…" : "Save Note"}
          </button>
        </div>
      </footer>
    </div>
  </div>
{/if}

<style>
  .quick-note-backdrop {
    position: fixed;
    inset: 0;
    background: var(--atlas-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1200;
    backdrop-filter: blur(4px);
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(20px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .quick-note-modal {
    width: min(600px, 92vw);
    background: var(--atlas-base);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-xl);
    box-shadow: 0 24px 64px var(--atlas-scrim);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: slideUp 0.2s ease-out;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--atlas-raise);
    background: linear-gradient(180deg, var(--atlas-panel), var(--atlas-base));
  }

  .head-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .shortcut-badge {
    font-size: var(--text-xs);
    font-family: ui-monospace, monospace;
    background: var(--atlas-raise);
    color: var(--atlas-signal);
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--atlas-line);
  }

  h2 {
    font-size: var(--text-xl);
    margin: 0;
    color: var(--atlas-ink);
  }

  .close-btn {
    background: transparent;
    border: none;
    color: var(--atlas-ink-3);
    font-size: var(--text-2xl);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius-md);
    transition: all 0.15s;
  }

  .close-btn:hover {
    background: var(--atlas-raise);
    color: var(--atlas-ink);
  }

  .body {
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .title-input {
    width: 100%;
    padding: 12px 14px;
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    color: var(--atlas-ink);
    font-size: var(--text-2xl);
    font-weight: 600;
    transition: border-color 0.15s;
  }

  .title-input:focus {
    outline: none;
    border-color: var(--atlas-signal);
    box-shadow: 0 0 0 3px var(--atlas-signal-soft);
  }

    .subject-select {
    width: 100%;
    padding: 10px 12px;
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    color: var(--atlas-ink);
    font-size: var(--text-lg);
  }

  .subject-select:focus {
    outline: none;
    border-color: var(--atlas-signal);
  }

  .no-subjects {
    margin: 0;
    padding: 12px 14px;
    background: var(--atlas-warn-bg);
    border: 1px solid var(--atlas-warn-bg);
    border-radius: var(--radius-lg);
    color: var(--atlas-warn);
    font-size: var(--text-md);
    line-height: 1.5;
  }

  .title-input::placeholder {
    color: var(--atlas-line-2);
  }

  .content-input {
    width: 100%;
    padding: 12px 14px;
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
    color: var(--atlas-ink-2);
    font-family: ui-monospace, "Cascadia Code", monospace;
    font-size: var(--text-lg);
    line-height: 1.6;
    resize: vertical;
    min-height: 160px;
    transition: border-color 0.15s;
  }

  .content-input:focus {
    outline: none;
    border-color: var(--atlas-signal);
    box-shadow: 0 0 0 3px var(--atlas-signal-soft);
  }

  .content-input::placeholder {
    color: var(--atlas-line-2);
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-top: 1px solid var(--atlas-raise);
    background: var(--atlas-base);
  }

  .hints {
    display: flex;
    gap: 12px;
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--atlas-ink-3);
    font-family: ui-monospace, monospace;
  }

  .actions {
    display: flex;
    gap: 8px;
  }
</style>
