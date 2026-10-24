<script>
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { profileStore } from "../../profiles/stores/profile.svelte.js";
  import { Menu } from "../../../shared/components/index.js";
  import { ArrowDown, ArrowUp, X } from "lucide-svelte";

  // Saved Places and shortcut actions use the supported Donut Local API.
  // General tab/page control is intentionally not presented: that capability
  // was implemented with unsupported CDP and native-window operations.

  let profiles = $state([]);
  let shortcuts = $state({}); // localId -> shortcut[]
  let expanded = $state(null); // localId with open shortcut list
  let newName = $state("");
  let adding = $state(false);
  let busy = $state(false);

  let editingId = $state(null);
  let editName = $state("");
  let scLabel = $state("");
  let scUrl = $state("");
  let scAddingFor = $state(null);
  let editingScId = $state(null);
  let editScLabel = $state("");
  let editScUrl = $state("");

  const cfId = $derived(
    profileStore.activeProfile ? Number(profileStore.activeProfile.id) : null
  );

  const REASONS = {
    busy: "Donut is busy finishing another action — try again in a moment.",
    "unknown-cf-profile": "The owning profile no longer exists.",
    "not-owned": "This browser profile belongs to a different CareerFlow profile.",
    disabled: "This browser profile is disabled.",
    "backend-unavailable": "Donut browser backend is unavailable.",
    "anti-burst-budget-exceeded":
      "Donut could not create the isolated profile right now (creation guard). Try again later.",
    "binding-unavailable": "Donut did not accept the profile request.",
    "run-failed": "Donut refused to launch this profile.",
    "shortcut-not-found": "Shortcut no longer exists.",
    "invalid-url": "Shortcut URL is invalid.",
    "open-failed": "Couldn't open the link.",
  };
  const explain = (res) =>
    res && res.ok === false && REASONS[res.reason]
      ? REASONS[res.reason]
      : "Operation failed.";

  async function load() {
    if (cfId == null) return;
    try {
      profiles = await window.careerflow.browserManager.list(cfId);
      const next = {};
      for (const p of profiles) {
        if (expanded === p.localId || shortcuts[p.localId]) {
          // listShortcuts signature is (cfId, browserProfileLocalId) — the
          // pre-fix code passed only p.localId, which made assertCfProfile
          // throw `unknown-profile` and the entire load() rejected.
          next[p.localId] = await window.careerflow.browserManager.listShortcuts(cfId, p.localId);
        }
      }
      shortcuts = next;
    } catch (e) {
      reportError(e, "Couldn't load browser profiles");
    }
  }

  $effect(() => {
    void cfId;
    profiles = [];
    shortcuts = {};
    expanded = null;
    load();
  });

  // Quick Actions toolbar: when the user clicks "+ Profile" in the right
  // sidebar we want the new-name form visible immediately. The toolbar
  // dispatches cf:bm-add-request after navigating to the browser view;
  // this listener flips `adding` on and focuses the input on the next tick.
  $effect(() => {
    const onAddRequest = () => {
      adding = true;
      newName = "";
      // Focus the input on the next tick so Svelte has rendered the form.
      setTimeout(() => {
        const el = document.getElementById("bm-new-name-input");
        if (el && typeof el.focus === "function") el.focus();
      }, 0);
    };
    window.addEventListener("cf:bm-add-request", onAddRequest);
    return () => window.removeEventListener("cf:bm-add-request", onAddRequest);
  });

  async function addProfile() {
    const name = newName.trim();
    if (!name || busy) return;
    busy = true;
    try {
      await window.careerflow.browserManager.add(
        cfId,
        crypto.randomUUID(),
        name
      );
      newName = "";
      adding = false;
      await load();
    } catch (e) {
      toast.error(e?.message === "unknown-profile" ? "Profile not found." : "Couldn't add the browser profile.");
    } finally {
      busy = false;
    }
  }

  async function toggleEnabled(p) {
    try {
      await window.careerflow.browserManager.setEnabled(cfId, p.localId, !p.enabled);
      await load();
    } catch (e) {
      reportError(e, "Couldn't update the browser profile");
    }
  }

  async function renameSave() {
    const name = editName.trim();
    if (!name || !editingId) return;
    try {
      await window.careerflow.browserManager.rename(cfId, editingId, name);
      editingId = null;
      await load();
    } catch (e) {
      reportError(e, "Couldn't rename the browser profile");
    }
  }

  async function removeProfile(p) {
    if (
      !(await confirmDialog({
        title: "Remove browser profile?",
        message: `"${p.displayName}" and its shortcuts are removed from CareerFlow. The Donut profile itself is left untouched.`,
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await window.careerflow.browserManager.remove(cfId, p.localId);
      if (expanded === p.localId) expanded = null;
      await load();
    } catch (e) {
      reportError(e, "Couldn't remove the browser profile");
    }
  }

  async function move(p, dir) {
    const idx = profiles.findIndex((x) => x.localId === p.localId);
    const target = idx + dir;
    if (target < 0 || target >= profiles.length) return;
    const ordered = profiles.map((x) => x.localId);
    [ordered[idx], ordered[target]] = [ordered[target], ordered[idx]];
    try {
      await window.careerflow.browserManager.reorderProfiles(cfId, ordered);
      await load();
    } catch (e) {
      reportError(e, "Couldn't reorder browser profiles");
    }
  }

  async function launch(p) {
    if (busy) return;
    busy = true;
    try {
      const res = await window.careerflow.browserManager.openBrowserProfile(p.localId, cfId);
      if (res && res.ok) toast.info(`Launching "${p.displayName}"…`);
      else toast.error(explain(res));
    } catch (e) {
      reportError(e, "Launch failed");
    } finally {
      busy = false;
    }
  }

  function toggleShortcuts(p) {
    expanded = expanded === p.localId ? null : p.localId;
    if (expanded && !shortcuts[p.localId]) {
      window.careerflow.browserManager
        .listShortcuts(cfId, p.localId)
        .then((list) => {
          shortcuts = { ...shortcuts, [p.localId]: list };
        })
        .catch((e) => reportError(e, "Couldn't load shortcuts"));
    }
  }

  async function addShortcut(p) {
    const label = scLabel.trim();
    const url = scUrl.trim();
    if (!label || !url) return;
    try {
      await window.careerflow.browserManager.addShortcut(cfId, p.localId, label, url);
      scLabel = "";
      scUrl = "";
      scAddingFor = null;
      const list = await window.careerflow.browserManager.listShortcuts(cfId, p.localId);
      shortcuts = { ...shortcuts, [p.localId]: list };
    } catch (e) {
      reportError(e, "Couldn't add the shortcut");
    }
  }

  async function saveShortcut(bpLocalId) {
    const label = editScLabel.trim();
    const url = editScUrl.trim();
    if (!label || !url || editingScId == null) return;
    try {
      await window.careerflow.browserManager.updateShortcut(cfId, editingScId, label, url);
      editingScId = null;
      const list = await window.careerflow.browserManager.listShortcuts(cfId, bpLocalId);
      shortcuts = { ...shortcuts, [bpLocalId]: list };
    } catch (e) {
      reportError(e, "Couldn't update the shortcut");
    }
  }

  async function deleteShortcut(bpLocalId, sc) {
    try {
      await window.careerflow.browserManager.deleteShortcut(cfId, sc.id);
      const list = await window.careerflow.browserManager.listShortcuts(cfId, bpLocalId);
      shortcuts = { ...shortcuts, [bpLocalId]: list };
    } catch (e) {
      reportError(e, "Couldn't delete the shortcut");
    }
  }

  async function moveShortcut(bpLocalId, sc, dir) {
    const list = shortcuts[bpLocalId] ?? [];
    const idx = list.findIndex((x) => x.id === sc.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= list.length) return;
    const ordered = list.map((x) => x.id);
    [ordered[idx], ordered[target]] = [ordered[target], ordered[idx]];
    try {
      await window.careerflow.browserManager.reorderShortcuts(cfId, bpLocalId, ordered);
      const fresh = await window.careerflow.browserManager.listShortcuts(cfId, bpLocalId);
      shortcuts = { ...shortcuts, [bpLocalId]: fresh };
    } catch (e) {
      reportError(e, "Couldn't reorder shortcuts");
    }
  }

  async function openShortcut(p, sc) {
    if (busy) return;
    busy = true;
    try {
      const res = await window.careerflow.browserManager.openShortcutUrl(sc.id, cfId);
      if (!(res && res.opened)) toast.error(explain(res));
    } catch (e) {
      reportError(e, "Couldn't open the shortcut");
    } finally {
      busy = false;
    }
  }

  // ---- Research console: supported capability readout ----------------------

  /** Overflow actions for one saved place, so the row keeps one visible verb. */
  function rowMenu(p, i) {
    return [
      { id: "rename", label: "Rename", onselect: () => { editingId = p.localId; editName = p.displayName; } },
      { id: "toggle", label: p.enabled ? "Disable" : "Enable", onselect: () => toggleEnabled(p) },
      { id: "up", label: "Move up", disabled: i === 0, onselect: () => move(p, -1) },
      {
        id: "down",
        label: "Move down",
        disabled: i === profiles.length - 1,
        onselect: () => move(p, 1),
      },
      { separator: true },
      { id: "remove", label: "Remove", danger: true, onselect: () => removeProfile(p) },
    ];
  }

  async function togglePin(p, sc) {
    try {
      await window.careerflow.browserManager.togglePin(cfId, sc.id, !sc.pinned);
      const list = await window.careerflow.browserManager.listShortcuts(cfId, p.localId);
      shortcuts = { ...shortcuts, [p.localId]: list };
      // Notify the rest of the renderer (notably QuickActionsPanel) that
      // pinned state changed. Renderer-local window event — no IPC needed
      // because the data already lives in the same renderer process.
      window.dispatchEvent(new Event("cf:data-changed"));
    } catch (e) {
      reportError(e, sc.pinned ? "Couldn't unpin" : "Couldn't pin to Quick Actions");
    }
  }
</script>

<section class="browser-manager atl-view">
  <div class="rs-console">
    <!-- ============ 1. SAVED PLACES ==================================== -->
    <div class="rs-places atl-band">
      <div class="atl-band-head">
        <h2>Saved places</h2>
        <span class="atl-band-note atl-mono">{profiles.length}</span>
        <div class="atl-band-actions">
          <button class="cf-btn secondary sm" disabled={busy} onclick={() => (adding = !adding)}>
            {adding ? "Cancel" : "New browser profile"}
          </button>
        </div>
      </div>

      {#if cfId == null}
        <p class="cf-empty boxed">Select a profile to manage its browser profiles.</p>
      {/if}

      {#if adding}
        <form class="row" onsubmit={(e) => { e.preventDefault(); addProfile(); }}>
          <input
            id="bm-new-name-input"
            class="cf-input"
            placeholder="Name (e.g. Study Browser)"
            bind:value={newName}
            maxlength={80}
          />
          <button class="cf-btn primary sm" type="submit" disabled={!newName.trim() || busy}>Add</button>
        </form>
      {/if}

      {#if cfId != null && profiles.length === 0 && !adding}
        <p class="cf-empty boxed">No managed browser profiles yet.</p>
      {/if}

      {#if cfId != null}
        <ul class="bp-list">
          {#each profiles as p, i (p.localId)}
            <li class="bp-card">
              <div class="bp-head">
                {#if editingId === p.localId}
                  <form class="row grow" onsubmit={(e) => { e.preventDefault(); renameSave(); }}>
                    <input class="cf-input" bind:value={editName} maxlength={80} aria-label="Profile name" />
                    <button class="cf-btn primary sm" type="submit">Save</button>
                    <button class="cf-btn ghost sm" type="button" onclick={() => (editingId = null)}>Cancel</button>
                  </form>
                {:else}
                  <span class="bp-name" class:disabled={!p.enabled}>{p.displayName}</span>
                  {#if !p.enabled}<span class="cf-badge neutral">disabled</span>{/if}
                  <span class="bp-meta atl-mono">{(shortcuts[p.localId] ?? []).length} links</span>
                {/if}

                <span class="spacer"></span>

                <button
                  class="cf-btn primary sm"
                  disabled={busy || !p.enabled}
                  onclick={() => launch(p)}
                >Launch</button>
                <button class="cf-btn secondary sm" onclick={() => toggleShortcuts(p)}>
                  Shortcuts ({(shortcuts[p.localId] ?? []).length})
                </button>
                <Menu label={`Actions for ${p.displayName}`} items={rowMenu(p, i)} />
              </div>

              {#if expanded === p.localId}
                <div class="sc-section">
                  <div class="sc-head">
                    <span class="atl-label">Shortcuts</span>
                    {#if scAddingFor !== p.localId}
                      <button class="cf-btn ghost sm" onclick={() => { scAddingFor = p.localId; scLabel = ""; scUrl = ""; }}>Add shortcut</button>
                    {/if}
                  </div>

                  {#if scAddingFor === p.localId}
                    <form class="row" onsubmit={(e) => { e.preventDefault(); addShortcut(p); }}>
                      <input class="cf-input" placeholder="Label" bind:value={scLabel} maxlength={60} />
                      <input class="cf-input" placeholder="https://…" bind:value={scUrl} maxlength={2048} />
                      <button class="cf-btn primary sm" type="submit" disabled={!scLabel.trim() || !scUrl.trim()}>Add</button>
                      <button class="cf-btn ghost sm" type="button" onclick={() => (scAddingFor = null)}>Cancel</button>
                    </form>
                  {/if}

                  {#if (shortcuts[p.localId] ?? []).length === 0}
                    <p class="cf-empty">No shortcuts yet.</p>
                  {:else}
                    <ul class="sc-list">
                      {#each shortcuts[p.localId] as sc, j (sc.id)}
                        <li class="sc-row atl-row">
                          {#if editingScId === sc.id}
                            <form class="row grow" onsubmit={(e) => { e.preventDefault(); saveShortcut(p.localId); }}>
                              <input class="cf-input" bind:value={editScLabel} maxlength={60} aria-label="Shortcut label" />
                              <input class="cf-input" bind:value={editScUrl} maxlength={2048} aria-label="Shortcut URL" />
                              <button class="cf-btn primary sm" type="submit">Save</button>
                              <button class="cf-btn ghost sm" type="button" onclick={() => (editingScId = null)}>Cancel</button>
                            </form>
                          {:else}
                            <button class="link-btn" title={sc.url} onclick={() => openShortcut(p, sc)}>
                              {sc.label}
                            </button>
                            {#if sc.pinned}<span class="cf-badge accent">pinned</span>{/if}
                            <span class="sc-url atl-mono">{sc.url}</span>
                            <span class="spacer"></span>
                            <button
                              class="cf-btn ghost sm"
                              onclick={() => togglePin(p, sc)}
                              title={sc.pinned ? "Unpin from Quick Actions" : "Pin to Quick Actions"}
                            >{sc.pinned ? "Pinned" : "Pin"}</button>
                            <button class="cf-btn ghost sm" onclick={() => { editingScId = sc.id; editScLabel = sc.label; editScUrl = sc.url; }}>Edit</button>
                            <button
                              class="cf-btn ghost sm"
                              disabled={j === 0}
                              onclick={() => moveShortcut(p.localId, sc, -1)}
                              aria-label="Move shortcut up"
                              title="Move up"
                            ><ArrowUp size={13} strokeWidth={2} aria-hidden="true" /></button>
                            <button
                              class="cf-btn ghost sm"
                              disabled={j === shortcuts[p.localId].length - 1}
                              onclick={() => moveShortcut(p.localId, sc, 1)}
                              aria-label="Move shortcut down"
                              title="Move down"
                            ><ArrowDown size={13} strokeWidth={2} aria-hidden="true" /></button>
                            <button
                              class="cf-btn ghost sm danger-text"
                              onclick={() => deleteShortcut(p.localId, sc)}
                              aria-label="Delete shortcut"
                              title="Delete shortcut"
                            ><X size={13} strokeWidth={2} aria-hidden="true" /></button>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- ============ EXTERNAL CONTROL BOUNDARY ========================== -->
    <aside class="rs-side">
      <section class="rs-panel">
        <header class="rs-panel-head">
          <span class="atl-label">External browser</span>
          <span class="cf-badge neutral">Limited API</span>
        </header>
        <p class="cf-empty">
          Donut's supported Local API can manage profiles and open URLs, but does not expose tab lists, page inspection, screenshots or page interaction here. Those controls are disabled rather than simulated.
        </p>
        <p class="cf-empty">For full browsing, use CareerFlow's embedded browser. It does not require Donut.</p>
      </section>

      <section class="rs-panel">
        <header class="rs-panel-head">
          <span class="atl-label">Runtime</span>
        </header>
        <p class="cf-empty">Donut is optional. Saved Places actions use its official Local API only.</p>
      </section>
    </aside>
  </div>
</section>

<style>
  /* Two panes: saved places and a factual external-control capability note.
     One column below 900px so the console stays usable in a narrow window. */
  .rs-console {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: var(--space-5);
    align-items: start;
  }

  @media (max-width: 900px) {
    .rs-console {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .rs-places {
    min-width: 0;
  }

  .row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }

  .row.grow {
    flex: 1;
  }

  .row > input,
  .row > .cf-input {
    flex: 1;
    min-width: 140px;
  }

  /* ---- Saved places --------------------------------------------------- */

  .bp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* A saved place is a data row, not a card: hairline separated, one primary
     verb visible, everything else in the overflow menu. */
  .bp-card {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--atlas-line);
    padding: var(--space-2) 0;
  }

  .bp-card:first-child {
    border-top: 1px solid var(--atlas-line);
  }

  .bp-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--row-h);
  }

  .bp-name {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--atlas-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bp-name.disabled {
    color: var(--atlas-ink-3);
  }

  .bp-meta {
    font-size: var(--text-micro);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--atlas-ink-3);
  }

  .spacer {
    flex: 1;
    min-width: 0;
  }

  /* ---- Shortcuts (disclosed in place) --------------------------------- */

  .sc-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) 0 var(--space-2) var(--space-3);
    border-left: 1px solid var(--atlas-line);
    margin-left: var(--space-1);
  }

  .sc-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .sc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .sc-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .link-btn {
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    font-size: var(--text-md);
    color: var(--atlas-signal-2);
    font-weight: 500;
    white-space: nowrap;
  }

  .link-btn:hover {
    text-decoration: underline;
  }

  .sc-url {
    font-size: var(--text-xs);
    color: var(--atlas-ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 34ch;
  }

  .danger-text {
    color: var(--atlas-bad);
  }

  /* ---- Right pane: external-control boundary -------------------------- */

  .rs-side {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .rs-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-lg);
  }

  .rs-panel-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--atlas-ink-3);
  }

  .rs-panel-head .atl-label {
    color: var(--atlas-ink-2);
  }

  .rs-panel-head .cf-badge {
    margin-left: auto;
  }

</style>
