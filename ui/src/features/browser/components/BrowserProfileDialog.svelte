<script>
  // New / edit browser profile dialog (Phase 3B). Shared by the surface
  // switcher (new only) and the manager view (new + edit).
  //
  // Password semantics (the IPC's contract, mirrored here so the user
  // sees it): a typed password is stored (encrypted in main); an empty
  // field on EDIT keeps the existing password; the "Clear password"
  // checkbox clears it. The dialog never sees the existing password
  // (main strips it), so "keep" is the only honest empty-field meaning.
  import { onMount } from "svelte";
  import { createBrowserProfile, updateBrowserProfile, deleteBrowserProfile, testBrowserProxy } from "../../../shared/stores/browser.svelte.js";

  let {
    profileId = null,
    /** null = new profile; an existing profile = edit mode. */
    profile = null,
    onClose = () => {},
    onSaved = () => {},
    /** Rename flow: focus the name field when the dialog opens. */
    focusName = false,
  } = $props();

  const isEdit = $derived(profile !== null);
  let displayName = $state(profile?.displayName ?? "");
  let color = $state(profile?.color ?? "#e0a35c");
  let icon = $state(profile?.icon ?? "");
  let notes = $state(profile?.notes ?? "");
  let startPages = $state(profile?.startPages ?? "");
  let nameInput = $state(null);
  onMount(() => {
    if (focusName) nameInput?.focus?.();
  });
  let proxyMode = $state(profile?.proxyMode ?? "none");
  let proxyHost = $state(profile?.proxyHost ?? "");
  let proxyPort = $state(profile?.proxyPort ?? "");
  let proxyUsername = $state(profile?.proxyUsername ?? "");
  let proxyPassword = $state("");
  let clearPassword = $state(false);
  let proxyBypass = $state(profile?.proxyBypass ?? "<local>");
  let language = $state(profile?.language ?? "");
  let userAgentPreset = $state(profile?.userAgentPreset ?? "");
  let webrtcPolicy = $state(profile?.webrtcPolicy ?? "default_public_interface_only");
  let allowCamera = $state(false);
  let allowMicrophone = $state(false);
  let allowGeolocation = $state(false);
  let allowNotifications = $state(false);
  let allowFullscreen = $state(true);
  let allowClipboard = $state(true);
  let gpc = $state(profile?.gpc === true);
  let dnt = $state(profile?.dnt === true);
  let blockThirdPartyCookies = $state(profile?.blockThirdPartyCookies === true);
  let clearOnClose = $state(profile?.clearOnClose === true);
  let downloadDir = $state(profile?.downloadDir ?? "");
  let busy = $state(false);
  let error = $state("");
  // Proxy test (edit mode only: the test runs against the SAVED
  // profile row, so unsaved edits must be saved first). Nothing is
  // contacted until the user clicks Test proxy, and the test address
  // is typed here, not assumed.
  let testUrl = $state("");
  let testBusy = $state(false);
  let testResult = $state("");

  async function runProxyTest() {
    if (!profile?.localId || !testUrl.trim()) return;
    testBusy = true;
    testResult = "";
    try {
      const res = await testBrowserProxy(Number(profileId), profile.localId, testUrl.trim());
      testResult = res?.ok ? `Proxy test OK (HTTP ${res.status}).` : `Proxy test failed: ${res?.reason ?? "unknown error"}.`;
    } catch (e) {
      testResult = `Proxy test failed: ${String(e?.message ?? e).slice(0, 200)}.`;
    } finally {
      testBusy = false;
    }
  }

  // Parse the stored allow list once (it is main-validated JSON, so a
  // parse failure here just means "nothing checked" — never a crash).
  $effect(() => {
    if (!profile?.permissionsAllow) return;
    try {
      const list = JSON.parse(profile.permissionsAllow);
      if (!Array.isArray(list)) return;
      allowCamera = list.includes("camera");
      allowMicrophone = list.includes("microphone");
      allowGeolocation = list.includes("geolocation");
      allowNotifications = list.includes("notifications");
      allowFullscreen = list.includes("fullscreen");
      allowClipboard = list.includes("clipboard-sanitized-write");
    } catch {}
  });

  function normalizedStartPages() {
    const lines = startPages
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const line of lines) {
      const rest = line.startsWith("http://") ? line.slice(7) : line.startsWith("https://") ? line.slice(8) : null;
      const host = rest === null ? "" : rest.split(/[/?#]/)[0];
      if (rest === null || host === "") return null;
    }
    if (lines.length > 20) return null;
    return lines.join("\n");
  }

  async function save(event) {
    event?.preventDefault?.();
    if (!displayName.trim() || busy) return;
    busy = true;
    error = "";
    const cleanStartPages = normalizedStartPages();
    if (cleanStartPages === null) {
      error = "Start pages must be http(s) URLs, one per line (at most 20).";
      busy = false;
      return;
    }
    try {
      const permissionsAllow = JSON.stringify([
        ...(allowCamera ? ["camera"] : []),
        ...(allowMicrophone ? ["microphone"] : []),
        ...(allowGeolocation ? ["geolocation"] : []),
        ...(allowNotifications ? ["notifications"] : []),
        ...(allowFullscreen ? ["fullscreen"] : []),
        ...(allowClipboard ? ["clipboard-sanitized-write"] : []),
      ]);
      const settings = {
        displayName: displayName.trim(),
        color: color || null,
        icon: icon.trim() || null,
        notes: notes.trim(),
        proxyMode,
        proxyHost: proxyHost.trim() || null,
        proxyPort: proxyPort === "" || proxyPort === null ? null : Number(proxyPort),
        proxyUsername: proxyUsername.trim() || null,
        proxyPassword: isEdit ? (clearPassword ? "" : proxyPassword === "" ? null : proxyPassword) : proxyPassword === "" ? null : proxyPassword,
        proxyBypass: proxyBypass.trim() || "<local>",
        language: language.trim() || null,
        userAgentPreset: userAgentPreset || null,
        webrtcPolicy,
        permissionsAllow,
        gpc,
        dnt,
        blockThirdPartyCookies,
        clearOnClose,
        downloadDir: downloadDir.trim() || null,
        startPages: cleanStartPages,
      };
      let res;
      if (isEdit) {
        res = await updateBrowserProfile(profileId, profile.localId, settings);
      } else {
        res = await createBrowserProfile(profileId, settings.displayName, settings.color, settings.icon, settings.notes);
        // A new profile starts with defaults; apply the dialog's full
        // settings in a second step so one dialog covers both paths.
        // If that second step fails, the half-configured profile is
        // removed rather than left behind with defaults the user did
        // not choose.
        if (res?.ok && res.profile) {
          const created = res.profile;
          res = await updateBrowserProfile(profileId, created.localId, settings);
          if (!res?.ok) {
            try { await deleteBrowserProfile(profileId, created.localId, false); } catch {}
          }
        }
      }
      if (!res?.ok) {
        error = res?.detail ?? res?.reason ?? "save-failed";
        return;
      }
      onSaved(res.profile);
    } finally {
      busy = false;
    }
  }
</script>

<div class="dialog-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <form class="dialog" aria-label={isEdit ? "Edit browser profile" : "New browser profile"} onsubmit={save}>
    <h2>{isEdit ? "Edit browser profile" : "New browser profile"}</h2>

    <label>
      Name
      <input type="text" data-testid="browser-profile-name" bind:this={nameInput} bind:value={displayName} required maxlength="200" placeholder="e.g. Work" />
    </label>
    <label>
      Color
      <input type="color" data-testid="browser-profile-color" bind:value={color} />
    </label>
    <label>
      Icon name (optional)
      <input type="text" data-testid="browser-profile-icon" bind:value={icon} maxlength="40" placeholder="e.g. briefcase" />
    </label>
    <label>
      Notes (optional)
      <textarea data-testid="browser-profile-notes" bind:value={notes} rows="2" maxlength="2000" placeholder="What is this profile for?"></textarea>
    </label>
    <label>
      Start pages (optional, one URL per line)
      <textarea data-testid="browser-profile-start-pages" bind:value={startPages} rows="3" maxlength="20000" placeholder={"https://example.com\nhttps://example.org"}></textarea>
      <span class="dialog-hint">Play opens these pages in this profile. Leave empty for a blank page.</span>
    </label>

    <fieldset>
      <legend>Proxy</legend>
      <label>
        Mode
        <select data-testid="browser-profile-proxy-mode" bind:value={proxyMode}>
          <option value="none">No proxy</option>
          <option value="http">HTTP</option>
          <option value="https">HTTPS</option>
          <option value="socks5">SOCKS5</option>
        </select>
      </label>
      {#if proxyMode !== "none"}
        <label>
          Host
          <input type="text" data-testid="browser-profile-proxy-host" bind:value={proxyHost} placeholder="127.0.0.1" />
        </label>
        <label>
          Port
          <input type="number" data-testid="browser-profile-proxy-port" bind:value={proxyPort} min="1" max="65535" placeholder="8080" />
        </label>
        <label>
          Username (optional)
          <input type="text" data-testid="browser-profile-proxy-username" bind:value={proxyUsername} autocomplete="off" />
        </label>
        <label>
          Password {isEdit ? "(empty keeps the existing password)" : "(optional)"}
          <input type="password" data-testid="browser-profile-proxy-password" bind:value={proxyPassword} autocomplete="off" />
        </label>
        {#if isEdit}
          <label class="checkbox">
            <input type="checkbox" data-testid="browser-profile-clear-password" bind:checked={clearPassword} />
            Clear the stored password
          </label>
        {/if}
        <label>
          Bypass (comma-separated, default keeps local addresses direct)
          <input type="text" data-testid="browser-profile-proxy-bypass" bind:value={proxyBypass} placeholder="<local>" />
        </label>
        {#if isEdit}
          <label>
            Test address (nothing is contacted until you click Test proxy)
            <input type="text" data-testid="browser-profile-test-url" bind:value={testUrl} placeholder="https://example.com" />
          </label>
          <button type="button" class="cf-btn ghost" data-testid="browser-profile-test-proxy" disabled={testBusy || !testUrl.trim()} onclick={runProxyTest}>{testBusy ? "Testing…" : "Test proxy"}</button>
          {#if testResult}
            <p class="proxy-test-result" data-testid="browser-profile-test-result" role="status">{testResult}</p>
          {/if}
          <p class="dialog-hint">Tests the saved proxy settings. Save changes first if you edited them above.</p>
        {/if}
      {/if}
    </fieldset>

    <fieldset>
      <legend>Language and identity</legend>
      <label>
        Language (Accept-Language, optional)
        <input type="text" data-testid="browser-profile-language" bind:value={language} placeholder="e.g. en-US" />
      </label>
      <label>
        Browser identity
        <select data-testid="browser-profile-ua" bind:value={userAgentPreset}>
          <option value="">Default (this browser)</option>
          <option value="windows">Windows Chromium</option>
          <option value="macos">macOS Chromium</option>
          <option value="linux">Linux Chromium</option>
        </select>
      </label>
      <label>
        WebRTC IP handling
        <select data-testid="browser-profile-webrtc" bind:value={webrtcPolicy}>
          <option value="default_public_interface_only">Hide local IPs (recommended)</option>
          <option value="default">Default (may reveal local IPs)</option>
          <option value="disable_non_proxied_udp">Disable non-proxied UDP</option>
        </select>
      </label>
    </fieldset>

    <fieldset>
      <legend>Permissions (deny by default; check to allow)</legend>
      <label class="checkbox"><input type="checkbox" bind:checked={allowCamera} /> Camera</label>
      <label class="checkbox"><input type="checkbox" bind:checked={allowMicrophone} /> Microphone</label>
      <label class="checkbox"><input type="checkbox" bind:checked={allowGeolocation} /> Location</label>
      <label class="checkbox"><input type="checkbox" bind:checked={allowNotifications} /> Notifications</label>
      <label class="checkbox"><input type="checkbox" bind:checked={allowFullscreen} /> Fullscreen (focused page only)</label>
      <label class="checkbox"><input type="checkbox" bind:checked={allowClipboard} /> Copy to clipboard</label>
    </fieldset>

    <fieldset>
      <legend>Privacy</legend>
      <label class="checkbox"><input type="checkbox" bind:checked={gpc} /> Send Global Privacy Control signal</label>
      <label class="checkbox"><input type="checkbox" bind:checked={dnt} /> Send Do Not Track</label>
      <label class="checkbox"><input type="checkbox" bind:checked={blockThirdPartyCookies} /> Block third-party cookies</label>
      <label class="checkbox"><input type="checkbox" bind:checked={clearOnClose} /> Clear this profile's data when its pages close</label>
    </fieldset>

    <label>
      Download folder (empty = workspace downloads folder)
      <input type="text" data-testid="browser-profile-download-dir" bind:value={downloadDir} placeholder="" />
    </label>

    {#if error}
      <p class="dialog-error" data-testid="browser-profile-error" role="alert">{error}</p>
    {/if}

    <div class="dialog-actions">
      <button type="button" class="cf-btn ghost" onclick={onClose}>Cancel</button>
      <button type="submit" class="cf-btn" disabled={busy || !displayName.trim()}>{isEdit ? "Save changes" : "Create profile"}</button>
    </div>
  </form>
</div>

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 40px 16px;
    overflow-y: auto;
    z-index: 100;
  }

  .dialog {
    width: min(520px, 100%);
    background: var(--surface-2, #1a1a1a);
    border: 1px solid var(--hairline, #333);
    border-radius: 12px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .dialog h2 {
    margin: 0;
    font-size: 16px;
  }

  .dialog label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }

  .dialog label.checkbox {
    flex-direction: row;
    align-items: center;
  }

  .dialog input[type="text"],
  .dialog input[type="password"],
  .dialog input[type="number"],
  .dialog textarea,
  .dialog select {
    padding: 6px 8px;
    border: 1px solid var(--hairline, #333);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 13px;
  }

  .dialog fieldset {
    border: 1px solid var(--hairline, #333);
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .dialog legend {
    font-size: 12px;
    padding: 0 6px;
  }

  .dialog-error {
    color: #e0655a;
    font-size: 12px;
    margin: 0;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
