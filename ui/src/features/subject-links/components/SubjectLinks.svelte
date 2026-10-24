<script>
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { Link, Plus, Trash2, Star, Edit2, Globe, ExternalLink } from "lucide-svelte";
  import { subjectLinksService } from "../services/subject-links.service.js";

  let { subjectId, subjectName, profileId = null } = $props();

  let links = $state([]);
  let loading = $state(false);
  let showAddForm = $state(false);
  let editingLink = $state(null);
  let formData = $state({ label: "", url: "" });

  $effect(() => {
    if (subjectId != null) {
      loadLinks();
    }
  });

  async function loadLinks() {
    if (subjectId == null) return;
    loading = true;
    try {
      links = await subjectLinksService.list(profileId, subjectId);
    } catch (e) {
      console.error("loadLinks failed:", e);
      links = [];
    } finally {
      loading = false;
    }
  }

  function openAddForm() {
    editingLink = null;
    formData = { label: "", url: "" };
    showAddForm = true;
  }

  function openEditForm(link) {
    editingLink = link;
    formData = { label: link.label, url: link.url };
    showAddForm = true;
  }

  function cancelForm() {
    showAddForm = false;
    editingLink = null;
    formData = { label: "", url: "" };
  }

  async function saveLink() {
    if (!formData.label.trim() || !formData.url.trim()) {
      toast.warning("Please fill in both label and URL");
      return;
    }

    // Basic URL validation
    let url = formData.url.trim();
    if (!url.match(/^https?:\/\//i)) {
      url = "https://" + url;
    }

    try {
      if (editingLink) {
        await subjectLinksService.update(profileId, editingLink.id, formData.label.trim(), url);
        toast.success("Link updated!");
      } else {
        await subjectLinksService.add(profileId, subjectId, formData.label.trim(), url);
        toast.success("Link added!");
      }
      cancelForm();
      await loadLinks();
      window.dispatchEvent(new Event("cf:data-changed"));
    } catch (e) {
      reportError(e, "Could not save link");
    }
  }

  async function deleteLink(linkId, label) {
    const ok = await confirmDialog({
      title: "Delete Link",
      message: `Delete "${label}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await subjectLinksService.remove(profileId, linkId);
      toast.success("Link deleted");
      await loadLinks();
      window.dispatchEvent(new Event("cf:data-changed"));
    } catch (e) {
      reportError(e, "Could not delete link");
    }
  }

  async function setPrimary(linkId) {
    try {
      await subjectLinksService.setPrimary(profileId, subjectId, linkId);
      toast.success("Set as primary link!");
      await loadLinks();
    } catch (e) {
      reportError(e, "Could not set primary");
    }
  }

  // Browser choice is infrastructure, not a user-facing setting: the main
  // process picks Donut when available and falls back to the system browser.
  let openingUrl = $state(null);

  async function openLink(url) {
    if (openingUrl !== null) return;
    openingUrl = url;
    try {
      const res = await window.careerflow.donut.openSubjectLink(url, profileId);
      if (!res || res.opened !== true) {
        toast.error("Couldn't open this link.");
        return;
      }
      if (res.provider === "donut") toast.success("Opened in Donut");
    } catch (e) {
      console.error("openSubjectLink failed:", e?.message ?? String(e));
      toast.error("Couldn't open this link.");
    } finally {
      openingUrl = null;
    }
  }

  function openInEmbeddedBrowser(url) {
    window.dispatchEvent(
      new CustomEvent("cf:open-page", {
        detail: { url, subjectId, subjectName },
      }),
    );
  }
</script>

<section class="subject-links">
  <div class="links-head">
    <h3>
      <Link size={16} />
      Study Links
      <span class="subject-badge">{subjectName}</span>
    </h3>
    <button class="add-link-btn" onclick={openAddForm} disabled={loading}>
      <Plus size={14} />
      Add Link
    </button>
  </div>

  {#if showAddForm}
    <div class="add-form">
      <input
        type="text"
        class="label-input"
        placeholder="Label (e.g., Wikipedia, NPTEL)"
        bind:value={formData.label}
      />
      <input
        type="text"
        class="url-input"
        placeholder="URL (e.g., https://...)"
        bind:value={formData.url}
      />
      <button class="save-btn" onclick={saveLink}>
        {editingLink ? "Update" : "Add"}
      </button>
      <button class="cancel-btn" onclick={cancelForm}>Cancel</button>
    </div>
  {/if}

  {#if loading}
    <p class="loading">Loading links...</p>
  {:else if links.length === 0}
    <p class="empty">No study links yet. Add Wikipedia, YouTube, NPTEL, or other resources.</p>
  {:else}
    <div class="links-list">
      {#each links as link (link.id)}
        <div class="link-item" class:primary={link.isPrimary}>
          <div class="link-main">
            {#if link.isPrimary}
              <span class="primary-badge" title="Primary link">
                <Star size={12} />
              </span>
            {/if}
            <button
              type="button"
              class="link-title-btn"
              title="Open in CareerFlow Browser"
              onclick={() => openInEmbeddedBrowser(link.url)}
            >
              <span class="link-label">{link.label}</span>
            </button>
            <span class="link-url">{link.url}</span>
          </div>
          <div class="link-actions">
            <button
              class="icon-btn"
              title="Open in CareerFlow Browser"
              onclick={() => openInEmbeddedBrowser(link.url)}
            >
              <Globe size={14} />
            </button>
            <button
              class="icon-btn"
              title="Open in external browser / Donut"
              disabled={openingUrl !== null}
              onclick={() => openLink(link.url)}
            >
              <ExternalLink size={14} />
            </button>
            {#if !link.isPrimary}
              <button
                class="icon-btn"
                title="Set as primary"
                onclick={() => setPrimary(link.id)}
              >
                <Star size={14} />
              </button>
            {/if}
            <button
              class="icon-btn"
              title="Edit"
              onclick={() => openEditForm(link)}
            >
              <Edit2 size={14} />
            </button>
            <button
              class="icon-btn del"
              title="Delete"
              onclick={() => deleteLink(link.id, link.label)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .subject-links {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 16px;
    margin-top: 16px;
  }

  .links-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .links-head h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-xl);
    font-weight: 650;
    margin: 0;
    color: var(--text-main);
  }

  .subject-badge {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
    background: var(--bg-main);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
  }

  .add-link-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--accent);
    color: var(--atlas-on-fill);
    border: none;
    padding: 6px 12px;
    border-radius: var(--radius-md);
    font-size: var(--text-md);
    cursor: pointer;
    transition: all 0.15s;
  }

  .add-link-btn:hover:not(:disabled) {
    background: var(--accent-hover, var(--atlas-signal));
  }

  .add-link-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .add-form {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .label-input,
  .url-input {
    flex: 1;
    min-width: 150px;
    padding: 8px 12px;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-main);
    font-size: var(--text-md);
  }

  .label-input:focus,
  .url-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .save-btn,
  .cancel-btn {
    padding: 8px 16px;
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--text-md);
    cursor: pointer;
    transition: all 0.15s;
  }

  .save-btn {
    background: var(--color-success);
    color: var(--atlas-on-fill);
  }

  .save-btn:hover {
    background: var(--color-success-hover, var(--atlas-signal));
  }

  .cancel-btn {
    background: var(--bg-main);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .cancel-btn:hover {
    background: var(--surface);
    color: var(--text-main);
  }

  .loading,
  .empty {
    color: var(--text-muted);
    font-size: var(--text-md);
    text-align: center;
    padding: 20px;
    margin: 0;
  }

  .links-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .link-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition: all 0.15s;
  }

  .link-item:hover {
    border-color: var(--border-strong);
  }

  .link-item.primary {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .link-main {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .primary-badge {
    display: flex;
    align-items: center;
    color: var(--accent);
    flex-shrink: 0;
  }

  .link-title-btn {
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    text-align: left;
    display: inline-flex;
    align-items: center;
  }

  .link-title-btn:hover .link-label {
    color: var(--accent);
    text-decoration: underline;
  }

  .link-label {
    font-weight: 600;
    color: var(--text-main);
    font-size: var(--text-md);
    flex-shrink: 0;
  }

  .link-url {
    color: var(--text-secondary);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .icon-btn:hover {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text-main);
  }

  .icon-btn.del:hover {
    color: var(--color-danger);
    border-color: var(--color-danger);
  }

  @media (max-width: 768px) {
    .add-form {
      flex-direction: column;
    }

    .label-input,
    .url-input {
      min-width: 100%;
    }

    .link-item {
      flex-direction: column;
      align-items: flex-start;
    }

    .link-actions {
      width: 100%;
      justify-content: flex-end;
    }
  }
</style>
