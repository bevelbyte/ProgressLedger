<script>
  let {
    open = false,
    profileId = null,
    resourceId = null,
    subjectId = null,
    defaultTitle = "",
    onClose,
  } = $props();

  import { X } from "lucide-svelte";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { noteService } from "../services/note.service.js";
  import { createGroundedCitation } from "../../../shared/utils/citations.js";
  import { subjectService } from "../../subjects/services/subject.service.js";

  let title = $state("");
  let content = $state("");
  let loading = $state(false);
  let saving = $state(false);

  // Citation tool state
  let showCiteModal = $state(false);
  let availablePdfs = $state([]);
  let loadingPdfs = $state(false);
  let selectedPdfId = $state(null);
  let citePassage = $state("");
  let citeStyle = $state("markdown");
  let citing = $state(false);

  async function openCitationTool() {
    showCiteModal = true;
    citePassage = "";
    selectedPdfId = null;
    if (profileId && subjectId) {
      loadingPdfs = true;
      try {
        const res = await subjectService.listResources(profileId, subjectId);
        availablePdfs = (Array.isArray(res) ? res : []).filter((r) => r.kind === "pdf");
        if (availablePdfs.length > 0) {
          selectedPdfId = availablePdfs[0].id;
        }
      } catch (e) {
        console.error("Failed to load subject PDFs:", e);
        availablePdfs = [];
      } finally {
        loadingPdfs = false;
      }
    } else {
      availablePdfs = [];
    }
  }

  async function applyCitation() {
    if (!citePassage.trim()) {
      toast.warning("Please provide a passage to cite.", "Empty passage");
      return;
    }
    citing = true;
    try {
      let rawText = "";
      let meta = { title: "Document" };
      if (selectedPdfId && profileId) {
        const doc = await subjectService.getResource(profileId, selectedPdfId);
        if (doc) {
          rawText = doc.content || "";
          meta = {
            title: doc.title || "Document",
            resourceId: doc.id,
          };
        }
      }
      const grounded = createGroundedCitation({
        rawText,
        passage: citePassage.trim(),
        meta,
        style: citeStyle,
      });

      if (grounded.valid) {
        const prefix = content.trim() ? content + "\n\n" : "";
        content = prefix + grounded.citation + "\n";
        if (grounded.grounded) {
          toast.success(`Cited page ${grounded.pageNumber}`, "Citation Grounded");
        } else {
          toast.info(grounded.warning || "Citation added (ungrounded)", "Citation Added");
        }
        showCiteModal = false;
      } else {
        toast.warning(grounded.warning || "Failed to create citation", "Invalid Citation");
      }
    } catch (e) {
      reportError(e, "Could not generate citation");
    } finally {
      citing = false;
    }
  }

  $effect(() => {
    if (!open) return;
    if (resourceId != null) {
      // The owning profile is part of the read: `resources:get` is scoped by
      // profileId. Without it the load silently failed and the editor opened
      // BLANK, so the next Save overwrote the note with an empty title/body.
      if (!profileId) {
        loading = false;
        title = "";
        content = "";
        return;
      }
      loading = true;
      noteService
        .get(profileId, resourceId)
        .then((r) => {
          title = r?.title ?? "";
          content = r?.content ?? "";
        })
        .catch((e) => {
          console.error(e);
          reportError(e, "Could not open the note");
          title = "";
          content = "";
        })
        .finally(() => (loading = false));
    } else {
      title = defaultTitle;
      content = "";
    }
  });

  async function save() {
    if (!title.trim()) {
      toast.warning("Please give the note a title.", "Missing title");
      return;
    }
    // Every note write is PROFILE-SCOPED: `resources:add-note` and
    // `resources:update-note` take (profileId, subjectId|resourceId, title,
    // content). Omitting the profile id shifts every argument one slot left,
    // which files the note against the subject id as a profile and writes the
    // body into the title column. Refuse rather than misfile.
    if (!profileId) {
      toast.warning("Select a profile first.", "No profile");
      return;
    }
    saving = true;
    try {
      if (resourceId != null) {
        await noteService.updateNote(profileId, resourceId, title.trim(), content);
      } else {
        if (!subjectId) {
          toast.warning(
            "Add a subject in the Degree Planner first — notes live inside a subject.",
            "No subject"
          );
          return;
        }
        await noteService.addNote(profileId, subjectId, title.trim(), content);
      }
      window.dispatchEvent(
        new CustomEvent("cf:resources-changed", { detail: { subjectId } })
      );
      window.dispatchEvent(new Event("cf:data-changed"));
      onClose?.();
    } catch (e) {
      reportError(e, "Save failed");
    } finally {
      saving = false;
    }
  }
</script>

{#if open}
  <div
    class="backdrop"
    role="button"
    tabindex="0"
    aria-label="Close note editor"
    onclick={() => onClose?.()}
    onkeydown={(e) => (e.key === "Enter" || e.key === " ") && onClose?.()}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <header>
        <input class="title" placeholder="Note title" bind:value={title} />
      </header>
      {#if loading}
        <div class="loading">Loading…</div>
      {:else}
        <textarea
          class="body"
          placeholder="Write your notes here… (Markdown supported)"
          bind:value={content}
        ></textarea>
      {/if}
      {#if showCiteModal}
        <div class="cite-drawer" data-testid="cite-drawer">
          <div class="cite-header">
            <h4>Grounded PDF Citation</h4>
            <button
              type="button"
              class="close-cite"
              aria-label="Close citation tool"
              onclick={() => (showCiteModal = false)}
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          <div class="cite-body">
            {#if loadingPdfs}
              <p class="cite-hint">Loading subject attachments…</p>
            {:else if availablePdfs.length > 0}
              <label for="cite-pdf-select">Source PDF:</label>
              <select
                id="cite-pdf-select"
                data-testid="cite-pdf-select"
                bind:value={selectedPdfId}
              >
                {#each availablePdfs as pdf}
                  <option value={pdf.id}>{pdf.title}</option>
                {/each}
              </select>
            {:else}
              <p class="cite-hint">
                No PDF attachments found for this subject. Citations will be formatted as ungrounded quotes.
              </p>
            {/if}

            <label for="cite-passage-input">Quoted passage:</label>
            <textarea
              id="cite-passage-input"
              data-testid="cite-passage-input"
              bind:value={citePassage}
              rows="3"
              placeholder="Paste exact quoted passage from the document here…"
            ></textarea>

            <div class="cite-options">
              <label for="cite-style-select">Format:</label>
              <select id="cite-style-select" bind:value={citeStyle}>
                <option value="markdown">Markdown Blockquote</option>
                <option value="inline">Inline Reference</option>
                <option value="apa">APA</option>
                <option value="ieee">IEEE</option>
              </select>
            </div>
          </div>
          <div class="cite-actions">
            <button
              type="button"
              class="cf-btn ghost"
              onclick={() => (showCiteModal = false)}
            >
              Cancel
            </button>
            <button
              type="button"
              class="cf-btn primary"
              data-testid="insert-citation-btn"
              onclick={applyCitation}
              disabled={citing || !citePassage.trim()}
            >
              {citing ? "Grounding…" : "Insert Citation"}
            </button>
          </div>
        </div>
      {/if}
      <footer>
        <div class="left-footer">
          <button
            type="button"
            class="cf-btn secondary cite-btn"
            data-testid="note-cite-btn"
            onclick={openCitationTool}
          >
            Cite PDF
          </button>
          <span class="hint">Markdown · indexed for offline search</span>
        </div>
        <div class="btns">
          <button class="cf-btn ghost" onclick={() => onClose?.()}>Cancel</button>
          <button class="cf-btn primary" onclick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; background: var(--atlas-scrim); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { position: relative; width: min(760px, 92vw); height: min(80vh, 720px); background: var(--atlas-base); border: 1px solid var(--atlas-line); border-radius: var(--radius-xl); display: flex; flex-direction: column; box-shadow: 0 16px 48px var(--atlas-scrim); }
  header { padding: 14px 16px; border-bottom: 1px solid var(--atlas-raise); }
  .title { width: 100%; background: transparent; border: none; color: var(--atlas-ink); font-size: var(--text-xl); font-weight: 600; }
  .title:focus { outline: none; }
  .loading { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--atlas-ink-3); }
  .body { flex: 1; resize: none; background: var(--atlas-base); color: var(--atlas-ink-2); border: none; padding: 16px; font-family: ui-monospace, "Cascadia Code", monospace; font-size: var(--text-lg); line-height: 1.5; }
  .body:focus { outline: none; }
  footer { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-top: 1px solid var(--atlas-raise); }
  .left-footer { display: flex; align-items: center; gap: 10px; }
  .cite-btn { font-size: var(--text-xs); padding: 4px 10px; }
  .hint { color: var(--atlas-ink-3); font-size: var(--text-sm); }
  .btns { display: flex; gap: 8px; }
  .cite-drawer { position: absolute; bottom: 0; left: 0; right: 0; background: var(--atlas-panel); border-top: 1px solid var(--atlas-line); border-radius: 0 0 var(--radius-xl) var(--radius-xl); padding: 16px; z-index: 10; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 -8px 24px var(--atlas-scrim); }
  .cite-header { display: flex; align-items: center; justify-content: space-between; }
  .cite-header h4 { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--atlas-ink); }
  .close-cite { background: transparent; border: none; color: var(--atlas-ink-3); cursor: pointer; font-size: 14px; }
  .cite-body { display: flex; flex-direction: column; gap: 8px; }
  .cite-hint { margin: 0; font-size: var(--text-xs); color: var(--atlas-ink-3); }
  .cite-body label { font-size: var(--text-xs); color: var(--atlas-ink-2); font-weight: 500; }
  .cite-body select, .cite-body textarea { background: var(--atlas-base); border: 1px solid var(--atlas-line); border-radius: var(--radius-sm); color: var(--atlas-ink); padding: 6px 8px; font-size: var(--text-sm); }
  .cite-options { display: flex; align-items: center; gap: 8px; }
  .cite-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>
