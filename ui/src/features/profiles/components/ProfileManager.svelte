<script>
  import { confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { 
    profileStore, 
    addProfile, 
    deleteProfile, 
    exportProfile, 
    importProfile 
  } from "../stores/profile.svelte.js";

  let { onSelect = null } = $props();

  let newName = $state("");

  function slugify(s) {
    return s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  const slugPreview = $derived(slugify(newName));

  async function handleAdd() {
    const name = newName.trim();
    const slug = slugify(name);
    if (!name || !slug) return;
    try {
      const created = await addProfile(name, slug);
      newName = "";
      onSelect?.(created.id);
    } catch {
      // Error is already reported by store/reportError
    }
  }

  async function handleImport() {
    try {
      const res = await importProfile();
      if (res?.imported) {
        onSelect?.(res.profile.profileId);
      }
    } catch {
      // Error is already reported by store/reportError
    }
  }

  async function handleDelete(id, ev) {
    ev.stopPropagation();
    const ok = await confirmDialog({
      title: "Delete profile",
      message: "Delete this profile? Everything inside it will be removed. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteProfile(id);
    } catch {
      // Error is already reported by store/reportError
    }
  }

  function handleSelect(id) {
    onSelect?.(id);
  }
</script>

<section class="profiles">
  <header class="section-head">
    <h2>Student Profiles</h2>
  </header>
  <form class="add-form" onsubmit={(e) => { e.preventDefault(); handleAdd(); }}>
    <input type="text" placeholder="New profile name (e.g. John Smith)" bind:value={newName} />
    <button type="submit" disabled={!slugPreview}>Add</button>
    <button type="button" class="ghost-btn" onclick={handleImport} disabled={profileStore.porting}>
      {profileStore.porting ? "Working..." : "Import"}
    </button>
  </form>
  {#if profileStore.profiles.length === 0}
    <p class="empty">No profiles yet. Add one to start an isolated session.</p>
  {:else}
    <div class="card-grid">
      {#each profileStore.profiles as p (p.id)}
        <article class="profile-card {p.id === profileStore.activeProfileId ? 'active' : ''}">
          <button type="button" class="profile-main" onclick={() => handleSelect(p.id)} aria-label={`Select ${p.name}`}></button>
          <div class="card-top">
            <span class="name">{p.name}</span>
            <span class="card-actions">
              <button type="button" class="exp" onclick={(e) => { e.stopPropagation(); exportProfile(p); }}>Export</button>
              <button type="button" class="del" onclick={(e) => handleDelete(p.id, e)}>Delete</button>
            </span>
          </div>
          <span class="slug">{p.slug}</span>
          {#if p.id === profileStore.activeProfileId}<span class="badge">Active</span>{/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .profiles h2 { font-size: var(--text-2xl); margin-bottom: 16px; font-weight: 650; }
  .add-form { display: flex; gap: 8px; margin-bottom: 24px; max-width: 500px; }
  .add-form input { flex: 1; background: var(--surface); color: var(--text-main); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 12px; }
  .add-form button { background: var(--accent); color: var(--atlas-on-fill); border: none; border-radius: var(--radius-md); padding: 0 16px; font-weight: 500;}
  .add-form button:disabled { opacity: 0.5; }
  .ghost-btn { background: transparent !important; color: var(--text-secondary) !important; border: 1px solid var(--border) !important; }
  
  .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
  .profile-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px; position: relative; min-height: 100px; display: flex; flex-direction: column; gap: 8px;}
  .profile-card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .profile-main { position: absolute; inset: 0; background: transparent; border: 0; cursor: pointer; border-radius: var(--radius-lg);}
  .card-top { display: flex; justify-content: space-between; align-items: flex-start; z-index: 2; pointer-events: none;}
  .name { font-weight: 600; font-size: var(--text-xl); }
  .slug { font-size: var(--text-sm); color: var(--text-secondary); z-index: 2; pointer-events: none;}
  .badge { background: var(--accent); color: var(--atlas-on-fill); padding: 2px 8px; border-radius: var(--radius-full); font-size: var(--text-xs); font-weight: 600; align-self: flex-start; z-index: 2; pointer-events: none;}
  
  .card-actions { display: flex; gap: 6px; pointer-events: auto; }
  .card-actions button { background: var(--bg-main); border: 1px solid var(--border); color: var(--text-secondary); padding: 4px 8px; border-radius: var(--radius-sm); font-size: var(--text-xs); }
  .card-actions button:hover { color: var(--text-main); border-color: var(--text-secondary); }
  .card-actions .del:hover { color: var(--color-danger); border-color: var(--color-danger); }
</style>
