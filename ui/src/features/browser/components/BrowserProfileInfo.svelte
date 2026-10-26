<script>
  // Read-only browser profile details, shown as a side panel with three
  // tabs: Overview, Network, Start pages. This view NEVER edits anything
  // and NEVER shows a secret: main strips the proxy password blob before
  // the renderer ever sees a profile, and this component does not render
  // any password field at all — not even a "password set" hint. A field
  // the model does not carry is omitted, never invented. The panel holds
  // no <input> elements, so it stays read-only in every sense.
  import { onMount } from "svelte";
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import {
    partitionSizeForBrowserProfile,
    testBrowserProxy,
  } from "../../../shared/stores/browser.svelte.js";

  let { profile = null, profileId = null, onClose = () => {} } = $props();

  let tab = $state("overview"); // "overview" | "network" | "start-pages"
  let sizeText = $state("Measuring…");
  let sizeTitle = $state("");
  let testBusy = $state(false);
  let testResult = $state("");
  let tabEls = $state({});

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "network", label: "Network" },
    { id: "start-pages", label: "Start pages" },
  ];

  function yesno(v) {
    return v === true ? "Yes" : "No";
  }

  function fmtDate(v) {
    if (!v) return "—";
    try {
      return new Date(v).toLocaleString();
    } catch {
      return v;
    }
  }

  function permissionList(profile) {
    if (!profile?.permissionsAllow) return "—";
    try {
      const list = JSON.parse(profile.permissionsAllow);
      if (!Array.isArray(list) || list.length === 0) return "—";
      return list.join(", ");
    } catch {
      return "—";
    }
  }

  function proxyLine(profile) {
    if (!profile || !profile.proxyMode || profile.proxyMode === "none") return "No proxy";
    const label = profile.proxyMode === "socks5" ? "SOCKS5" : String(profile.proxyMode).toUpperCase();
    const host = profile.proxyHost ?? "";
    const port = profile.proxyPort ?? "";
    const user = profile.proxyUsername ? ` (user ${profile.proxyUsername})` : "";
    return `${label} ${host}:${port}${user}`;
  }

  function hasProxy(profile) {
    return !!profile && !!profile.proxyMode && profile.proxyMode !== "none";
  }

  function startPageList(profile) {
    return String(profile?.startPages ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  async function loadSize(p) {
    sizeText = "Measuring…";
    sizeTitle = "";
    if (!p || p.temporary) {
      sizeText = "—";
      return;
    }
    try {
      const res = await partitionSizeForBrowserProfile(profileId, p.localId);
      if (!res?.ok) {
        sizeText = "—";
        return;
      }
      sizeText = formatBytes(res.bytes) + (res.complete ? "" : " (at least)");
      sizeTitle = `${res.files} files`;
    } catch {
      sizeText = "—";
    }
  }

  $effect(() => {
    // Reload the size whenever a different profile is shown.
    if (profile) loadSize(profile);
  });

  async function copyProfileId() {
    if (!profile?.localId) return;
    try {
      await navigator.clipboard.writeText(profile.localId);
      toast.success("Profile ID copied.");
    } catch {
      toast.error("Could not copy the profile ID.");
    }
  }

  async function runProxyTest() {
    if (!profile?.localId || testBusy) return;
    testBusy = true;
    testResult = "";
    try {
      const res = await testBrowserProxy(Number(profileId), profile.localId, "https://example.com");
      testResult = res?.ok ? `Proxy test OK (HTTP ${res.status}).` : `Proxy test failed: ${res?.reason ?? "unknown error"}.`;
    } catch (e) {
      testResult = `Proxy test failed: ${String(e?.message ?? e).slice(0, 200)}.`;
    } finally {
      testBusy = false;
    }
  }

  function tabKey(e, current) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === current);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    tab = next.id;
    tabEls[next.id]?.focus?.();
  }

  onMount(() => {
    tabEls["overview"]?.focus?.();
  });
</script>

{#if profile}
  <aside class="profile-panel" data-testid="browser-profile-info" role="dialog" aria-label="Profile details for {profile.displayName}">
    <div class="panel-head">
      <h2>Profile: {profile.displayName}</h2>
      <button type="button" class="cf-btn ghost" data-testid="browser-profile-info-close" onclick={onClose}>Close</button>
    </div>
    <p class="panel-sub">Read-only. Nothing here changes the profile.</p>
    <div class="panel-tabs" role="tablist" aria-label="Profile detail sections">
      {#each tabs as t (t.id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          data-testid="browser-profile-tab-{t.id}"
          bind:this={tabEls[t.id]}
          onclick={() => (tab = t.id)}
          onkeydown={(e) => tabKey(e, t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>

    {#if tab === "overview"}
      <div class="profile-info" role="tabpanel">
        <dl>
          <div>
            <dt>ID</dt>
            <dd>
              <code>{profile.localId}</code>
              <button type="button" class="cf-btn ghost sm" data-testid="browser-profile-info-copy-id" aria-label="Copy profile ID" onclick={copyProfileId}>
                Copy ID
              </button>
            </dd>
          </div>
          <div>
            <dt>Name</dt>
            <dd data-testid="browser-profile-info-name">
              <span class="profile-dot" style="--profile-color: {profile.color ?? "#888888"}" aria-hidden="true"></span>
              {profile.displayName}
            </dd>
          </div>
          <div>
            <dt>Color</dt>
            <dd>
              <span class="profile-swatch" style="--profile-color: {profile.color ?? "#888888"}" aria-hidden="true"></span>
              {profile.color ?? "—"}
            </dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{profile.temporary ? "Temporary" : "Persistent"}</dd>
          </div>
          <div>
            <dt>Default profile</dt>
            <dd>{yesno(profile.isDefault)}</dd>
          </div>
          {#if profile.notes}
            <div>
              <dt>Notes</dt>
              <dd>{profile.notes}</dd>
            </div>
          {/if}
          <div>
            <dt>Proxy</dt>
            <dd>{proxyLine(profile)}</dd>
          </div>
          {#if profile.proxyMode && profile.proxyMode !== "none"}
            <div>
              <dt>Proxy bypass</dt>
              <dd>{profile.proxyBypass ?? "—"}</dd>
            </div>
          {/if}
          <div>
            <dt>Data size</dt>
            <dd data-testid="browser-profile-info-size" title={sizeTitle}>{sizeText}</dd>
          </div>
          <div>
            <dt>Clear data on close</dt>
            <dd>{yesno(profile.clearOnClose)}</dd>
          </div>
          <div>
            <dt>Privacy</dt>
            <dd>
              Global Privacy Control: {yesno(profile.gpc)}; Do Not Track: {yesno(profile.dnt)}; block third-party cookies: {yesno(
                profile.blockThirdPartyCookies,
              )}; clear data on close: {yesno(profile.clearOnClose)}
            </dd>
          </div>
          <div>
            <dt>Permissions allowed</dt>
            <dd>{permissionList(profile)}</dd>
          </div>
          <div>
            <dt>Language</dt>
            <dd>{profile.language ?? "—"}</dd>
          </div>
          <div>
            <dt>User-agent preset</dt>
            <dd>{profile.userAgentPreset ?? "—"}</dd>
          </div>
          <div>
            <dt>WebRTC policy</dt>
            <dd>{profile.webrtcPolicy ?? "—"}</dd>
          </div>
          <div>
            <dt>Download directory</dt>
            <dd>{profile.downloadDir ?? "—"}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{fmtDate(profile.createdAt)}</dd>
          </div>
          <div>
            <dt>Last used</dt>
            <dd>{profile.lastUsedAt ? fmtDate(profile.lastUsedAt) : "Never"}</dd>
          </div>
        </dl>
      </div>
    {:else if tab === "network"}
      <div class="profile-info" role="tabpanel">
        <dl>
          <div>
            <dt>Proxy</dt>
            <dd>{proxyLine(profile)}</dd>
          </div>
          {#if hasProxy(profile)}
            <div>
              <dt>Proxy bypass</dt>
              <dd>{profile.proxyBypass ?? "—"}</dd>
            </div>
          {/if}
        </dl>
        {#if hasProxy(profile) && !profile.temporary}
          <button
            type="button"
            class="cf-btn ghost"
            data-testid="browser-profile-info-test-proxy"
            disabled={testBusy}
            onclick={runProxyTest}
          >
            {testBusy ? "Testing…" : "Test proxy"}
          </button>
          {#if testResult}
            <p class="proxy-test-result" data-testid="browser-profile-info-test-result" role="status">{testResult}</p>
          {/if}
          <p class="panel-hint">Tests the saved proxy settings against https://example.com. No VPN or DNS settings are shown here.</p>
        {:else}
          <p class="panel-hint">No proxy is configured for this profile, so there is nothing to test.</p>
        {/if}
      </div>
    {:else}
      <div class="profile-info" role="tabpanel">
        {#if startPageList(profile).length === 0}
          <p class="panel-hint">No start pages set. Play opens a blank page. Set them in Edit settings.</p>
        {:else}
          <ul class="start-pages">
            {#each startPageList(profile) as url (url)}
              <li><code>{url}</code></li>
            {/each}
          </ul>
          <p class="panel-hint">Play opens these pages in this profile, first page focused.</p>
        {/if}
      </div>
    {/if}
  </aside>
{/if}

<style>
  .profile-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(440px, 100%);
    z-index: 100;
    overflow-y: auto;
    background: var(--surface-2, #1a1a1a);
    border-left: 1px solid var(--hairline, #333);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .panel-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }

  .panel-head h2 {
    margin: 0;
    font-size: 16px;
  }

  .panel-sub {
    margin: 0;
    opacity: 0.7;
    font-size: 12px;
  }

  .panel-tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--hairline, #333);
    padding-bottom: 8px;
  }

  .panel-tabs button[role="tab"] {
    padding: 7px 12px;
    border-radius: 6px;
    font-size: 13px;
    color: inherit;
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
  }

  .panel-tabs button[role="tab"][aria-selected="true"] {
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--hairline, #333);
  }

  .panel-tabs button[role="tab"]:focus-visible {
    outline: 2px solid #e0a35c;
    outline-offset: 1px;
  }

  .profile-info dl {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .profile-info dl > div {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: 12px;
    align-items: start;
  }

  .profile-info dt {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }

  .profile-info dd {
    margin: 0;
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .profile-info dd code {
    font-size: 12px;
  }

  .profile-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--profile-color, #888888);
    display: inline-block;
    margin-right: 6px;
  }

  .profile-swatch {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    background: var(--profile-color, #888888);
    display: inline-block;
    vertical-align: middle;
    margin-right: 6px;
  }

  .proxy-test-result {
    font-size: 13px;
    margin: 12px 0 0;
  }

  .panel-hint {
    opacity: 0.7;
    font-size: 12px;
    margin: 12px 0 0;
  }

  .start-pages {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }

  .start-pages code {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
</style>
