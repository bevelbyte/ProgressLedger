<script>
  // DefaultProviderPicker — lets users pick which LLM provider the agent
  // uses by default for the active project.
  //
  // The chosen provider is stored in pm_projects.config_json["defaultProvider"]
  // and is read/written through the IPC + NAPI layers. No secrets cross
  // this boundary — it only carries the provider identifier string.

  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { projectModeService } from "../services/projectMode.service.js";
  import { projectModeStore } from "../stores/projectMode.svelte.js";

  let { profileId = null } = $props();

  let current = $state("openai-compatible"); // always one of two valid values
  let loading = $state(false);
  let saving = $state(false);
  let loadError = $state(false);

  const PROVIDERS = [
    {
      id: "openai-compatible",
      label: "OpenAI-compatible",
      desc: "Use an OpenAI-compatible API endpoint + model",
    },
    {
      id: "mock",
      label: "Mock",
      desc: "Fake responses for development / testing",
    },
  ];

  // Reload whenever the active project changes.
  $effect(() => {
    const apid = projectModeStore.activeProjectId;
    if (profileId == null || apid == null) {
      loadError = false;
      return;
    }
    loading = true;
    loadError = false;
    projectModeService
      .getDefaultProvider(profileId, apid)
      .then((res) => {
        // pm_get_default_provider returns the raw string or null.
        // Treat null / empty as the safe default "openai-compatible".
        if (res == null) {
          current = "openai-compatible";
        } else if (typeof res === "string" && res.length > 0) {
          current = res;
        } else {
          current = "openai-compatible";
        }
      })
      .catch((e) => {
        reportError(e, "Could not load default provider");
        loadError = true;
      })
      .finally(() => {
        loading = false;
      });
  });

  async function select(id) {
    const apid = projectModeStore.activeProjectId;
    if (apid == null) return;
    if (id === current) return; // nothing to do
    saving = true;
    try {
      const res = await projectModeService.setDefaultProvider(profileId, apid, id);
      if (res && res.ok !== false) {
        current = id;
        toast.success(`Default provider set to ${id}`);
      } else {
        toast.error(res && res.error ? `Could not save: ${res.error}` : "Could not save default provider");
      }
    } catch (e) {
      reportError(e, "Could not save default provider");
      toast.error("Could not save default provider");
    } finally {
      saving = false;
    }
  }
</script>

<div class="picker" data-testid="default-provider-picker">
  <h3 class="title">Default provider</h3>

  {#if loading}
    <p class="hint" data-testid="provider-loading">Loading...</p>
  {:else if loadError}
    <p class="hint error" data-testid="provider-load-error">
      Default provider is not available in this build.
    </p>
  {:else}
    <div class="options" role="radiogroup" aria-label="Default provider">
      {#each PROVIDERS as p (p.id)}
        <button
          type="button"
          class="option"
          class:selected={current === p.id}
          onclick={() => select(p.id)}
          disabled={saving}
          role="radio"
          aria-checked={current === p.id}
          data-testid="provider-option-{p.id}"
        >
          <span class="radio-dot" aria-hidden="true"></span>
          <span class="option-text">
            <strong>{p.label}</strong>
            <span class="option-desc">{p.desc}</span>
          </span>
          {#if current === p.id}
            <span class="badge" data-testid="provider-badge-active">active</span>
          {/if}
        </button>
      {/each}
    </div>
    {#if saving}
      <p class="hint" data-testid="provider-saving">Saving...</p>
    {/if}
  {/if}
</div>

<style>
  .picker {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px;
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .title {
    margin: 0;
    font-size: var(--text-md);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-main);
    cursor: pointer;
    text-align: left;
    color: var(--text-main);
    transition: border-color 0.15s, background 0.15s;
    width: 100%;
  }
  .option:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .option.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-main));
  }
  .option:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .radio-dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--border);
    flex-shrink: 0;
    margin-top: 2px;
    transition: border-color 0.15s, background 0.15s;
  }
  .option.selected .radio-dot {
    border-color: var(--accent);
    background: var(--accent);
    box-shadow: inset 0 0 0 2px var(--bg-main);
  }
  .option-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  .option-text strong {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-main);
  }
  .option-desc {
    font-size: var(--text-md);
    color: var(--text-muted);
  }
  .badge {
    font-size: var(--text-xs);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    padding: 2px 7px;
    border-radius: var(--radius-full);
    white-space: nowrap;
    align-self: center;
  }
  .hint {
    margin: 0;
    font-size: var(--text-md);
    color: var(--text-muted);
  }
  .hint.error {
    color: var(--color-error, var(--atlas-bad));
  }
</style>
