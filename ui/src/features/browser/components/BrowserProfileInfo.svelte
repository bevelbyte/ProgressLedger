<script>
  // Read-only browser profile information (Play UX task). This view
  // NEVER edits anything and NEVER shows a secret: main strips the
  // proxy password blob before the renderer ever sees a profile, and
  // this component does not render any password field at all — not
  // even a "password set" hint. A field the model does not carry is
  // omitted, never invented.
  import Modal from "../../../shared/components/Modal.svelte";

  let { profile = null, onClose = () => {} } = $props();

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
</script>

<Modal
  open={profile !== null}
  title={profile ? `Profile: ${profile.displayName}` : "Profile"}
  subtitle="Read-only. Nothing here changes the profile."
  onClose={onClose}
  footer={null}
>
  {#if profile}
    <div class="profile-info" data-testid="browser-profile-info">
      <dl>
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
      <div class="info-actions">
        <button type="button" class="cf-btn ghost" data-testid="browser-profile-info-close" onclick={onClose}>Close</button>
      </div>
    </div>
  {/if}
</Modal>

<style>
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

  .info-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 16px;
  }
</style>
