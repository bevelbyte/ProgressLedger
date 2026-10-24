<script>
  // ProviderConfigPanel — endpoint + model + API key inputs for the
  // active project.
  //
  // SECURITY: the renderer NEVER sees the saved API key. The IPC
  // response from `project:get-provider-config` strips the key and
  // reports only `hasKey: boolean`. The key input here is write-only.

  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { projectModeService } from "../services/projectMode.service.js";
  import { projectModeStore } from "../stores/projectMode.svelte.js";

  let { profileId = null } = $props();

  let endpoint = $state("https://api.openai.com");
  let model = $state("gpt-4o-mini");
  let apiKey = $state(""); // never echoed back
  let hasKey = $state(false);
  let saving = $state(false);
  // Sanitized store diagnostic from the main process: null when the
  // store is fine (or absent/empty), `{ code, reason }` when the store
  // file exists but could not be read. Never carries content or field
  // values — only the classification the store itself produced.
  let storeDiagnostic = $state(null);

  $effect(() => {
    const apid = projectModeStore.activeProjectId;
    if (profileId == null || apid == null) return;
    projectModeService
      .getProviderConfig(profileId, apid)
      .then((res) => {
        if (res && res.ok && res.config) {
          endpoint = res.config.endpoint || endpoint;
          model = res.config.model || model;
          hasKey = !!res.config.hasKey;
          // Surface WHY no credential resolved. Without this the
          // panel looked simply empty and the (main-process) cause
          // was invisible to the operator.
          storeDiagnostic = res.config.diagnostic || null;
        } else {
          storeDiagnostic = null;
        }
      })
      .catch((e) => reportError(e, "Could not load provider config"));
  });

  async function save() {
    const apid = projectModeStore.activeProjectId;
    if (apid == null) {
      toast.warning("Pick a project first.", "No project");
      return;
    }
    if (!model.trim()) {
      toast.warning("Model is required.", "Missing model");
      return;
    }
    // If the user typed a key, write it; otherwise write the existing
    // config unchanged by sending the current hasKey=1 sentinel. To
    // keep the API simple, the IPC layer requires a non-empty key on
    // every set; "Clear" is a separate action.
    if (!apiKey.trim() && !hasKey) {
      toast.warning("Enter an API key.", "Missing key");
      return;
    }
    saving = true;
    try {
      // If the user didn't type a new key and a key already exists,
      // signal "keep existing" to the main process. The IPC + credentials
      // store understands the sentinel; the renderer never sees the key.
      const trimmed = apiKey.trim();
      const payload = {
        endpoint: endpoint.trim(),
        model: model.trim(),
        apiKey: trimmed ? trimmed : (hasKey ? "UNCHANGED" : ""),
      };
      const res = await projectModeService.setProviderConfig(profileId, apid, payload);
      // The service forwards (profileId, projectId, payload) positionally to the
      // preload binding; the payload is { endpoint, model, apiKey }.
      if (res && res.ok) {
        hasKey = true;
        apiKey = "";
        // A successful save rewrites the store as valid JSON, so any
        // earlier malformed-store diagnostic no longer applies.
        storeDiagnostic = null;
        toast.success("Provider config saved");
      } else {
        toast.error(res && res.error ? `Invalid: ${res.error}` : "Could not save config");
      }
    } catch (e) {
      reportError(e, "Could not save provider config");
    } finally {
      saving = false;
    }
  }

  async function clearKey() {
    const apid = projectModeStore.activeProjectId;
    if (apid == null) return;
    try {
      await projectModeService.clearProviderConfig(profileId, apid);
      hasKey = false;
      apiKey = "";
      storeDiagnostic = null;
      toast.success("Provider key cleared");
    } catch (e) {
      reportError(e, "Could not clear provider config");
    }
  }
</script>

<div class="panel" data-testid="provider-config-panel">
  <h3 class="title">Provider config</h3>

  {#if storeDiagnostic}
    <p class="store-warning" role="alert" data-testid="provider-store-diagnostic">
      Stored provider config could not be read
      (<code data-testid="provider-store-diagnostic-code">{storeDiagnostic.code}</code>).
      Re-enter the endpoint, model and API key below, then <strong>Save</strong> to repair it.
    </p>
  {/if}

  <label class="field">
    <span>Endpoint</span>
    <input
      type="url"
      bind:value={endpoint}
      placeholder="https://api.openai.com"
      data-testid="provider-endpoint"
    />
  </label>

  <label class="field">
    <span>Model</span>
    <input
      type="text"
      bind:value={model}
      placeholder="gpt-4o-mini"
      required
      data-testid="provider-model"
    />
  </label>

  <label class="field">
    <span>API key {#if hasKey}<span class="key-set" data-testid="provider-key-set">key set</span>{/if}</span>
    <input
      type="password"
      bind:value={apiKey}
      placeholder={hasKey ? "Leave empty to keep existing key" : "sk-…"}
      autocomplete="off"
      data-testid="provider-key"
    />
  </label>

  <div class="actions">
    <button type="button" class="btn btn-ghost" onclick={clearKey} disabled={!hasKey || saving} data-testid="provider-clear">
      Clear key
    </button>
    <button type="button" class="btn btn-primary" onclick={save} disabled={saving} data-testid="provider-save">
      {saving ? "Saving…" : "Save"}
    </button>
  </div>
</div>

<style>
  .panel { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; background: var(--surface); display: flex; flex-direction: column; gap: 8px; }
  .title { margin: 0; font-size: var(--text-md); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-md); }
  .field span { color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
  .field input {
    background: var(--bg-main); color: var(--text-main); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 6px 8px; font-size: var(--text-md);
  }
  .key-set { font-size: var(--text-xs); color: var(--color-success, var(--atlas-ok)); background: var(--bg-main); padding: 1px 6px; border-radius: var(--radius-full); }
  .store-warning { margin: 0; font-size: var(--text-md); line-height: 1.35; color: var(--color-warning, var(--atlas-warn)); background: var(--bg-main); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; }
  .store-warning code { font-size: var(--text-sm); }
  .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
  .btn { padding: 6px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); cursor: pointer; font-size: var(--text-md); }
  .btn-ghost { background: transparent; color: var(--text-secondary); }
  .btn-primary { background: var(--accent); color: var(--bg-main); border-color: var(--accent); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>