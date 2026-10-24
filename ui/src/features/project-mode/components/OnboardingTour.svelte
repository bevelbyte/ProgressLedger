<script>
  // OnboardingTour — guided tour overlay for new Project Mode users.
  //
  // Still six steps, because six is what the tour needs to say; what changed is
  // that every step now points at the console that exists. The blurbs used to
  // describe "panels" that sat in a three-column wall; they now name the region
  // or tab where the thing actually lives (approvals above the transcript, the
  // tool trace under it, inventories under Extensions, memory under Context).
  //
  // Icons come from the icon set rather than from emoji, so the tour's header
  // matches the chrome it is describing. Tracks completion in localStorage;
  // auto-shows when the key is missing.

  import { Hand, ListChecks, Wrench, Target, Plug, Brain } from "lucide-svelte";

  const STORAGE_KEY = "careerflow_project_mode_tour_complete";

  let { visible = false, onClose } = $props();

  // The tour steps. Each entry has: id, title, icon (a lucide component), blurb.
  const steps = [
    {
      id: "welcome",
      title: "Welcome to Project Mode",
      icon: Hand,
      blurb:
        "Project Mode is where agent work happens: pick a project on the left, describe an objective, and the run console opens on the right. This tour takes under a minute.",
    },
    {
      id: "plan",
      title: "The plan view",
      icon: ListChecks,
      blurb:
        "The Plan tab breaks work into discrete steps, and the run's state sits in the console header, so you can always tell whether it is planning, executing or waiting on you.",
    },
    {
      id: "tools",
      title: "Tool inventory",
      icon: Wrench,
      blurb:
        "A live tool trace sits under the transcript: every call the agent makes, as it makes it. Anything that needs your permission appears above it in the approval queue.",
    },
    {
      id: "skills",
      title: "Skill inventory",
      icon: Target,
      blurb:
        "Skills are reusable instruction packs — review checklists, refactor patterns, security checks. The agent picks them up automatically; browse them under the Extensions tab.",
    },
    {
      id: "plugins",
      title: "Plugin inventory",
      icon: Plug,
      blurb:
        "Plugins add tools, skills and providers. The installed set and the marketplace both live under the Extensions tab, next to the skill and tool inventories.",
    },
    {
      id: "memory",
      title: "Memory viewer",
      icon: Brain,
      blurb:
        "The Context tab shows what the agent remembers, which sub-agents are running, and the session timeline — useful when you want to know why a decision was made.",
    },
  ];

  let stepIndex = $state(0);
  const totalSteps = steps.length;
  const progress = $derived(((stepIndex + 1) / totalSteps) * 100);
  const currentStep = $derived(steps[stepIndex]);
  const isFirst = $derived(stepIndex === 0);
  const isLast = $derived(stepIndex === totalSteps - 1);

  function next() {
    if (stepIndex < totalSteps - 1) stepIndex++;
  }

  function back() {
    if (stepIndex > 0) stepIndex--;
  }

  function finish() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch (_) {
      // localStorage may be disabled in some sandboxed contexts — ignore.
    }
    onClose?.();
  }

  function skip() {
    finish();
  }

  function restart() {
    stepIndex = 0;
  }

  // Keyboard navigation — only active while the tour is open.
  $effect(() => {
    if (!visible) return;

    function onKey(e) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (!isLast) next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (!isFirst) back();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

{#if visible}
  {@const Icon = currentStep.icon}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={finish} role="presentation" data-testid="onboarding-tour-backdrop">
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Project Mode tour"
      data-testid="onboarding-tour-modal"
    >
      <div class="progress" data-testid="onboarding-tour-progress">
        <div
          class="progress-fill"
          style="width: {progress}%"
          data-testid="onboarding-tour-progress-fill"
        ></div>
      </div>

      <header class="modal-header">
        <div class="step-meta">
          <span class="step-icon" aria-hidden="true">
            <Icon size={15} strokeWidth={2} />
          </span>
          <h3 data-testid="onboarding-tour-title">{currentStep.title}</h3>
        </div>
        <span class="step-counter" data-testid="onboarding-tour-counter">
          {stepIndex + 1} / {totalSteps}
        </span>
      </header>

      <div class="modal-body" data-testid="onboarding-tour-body">
        <p data-testid="onboarding-tour-blurb">{currentStep.blurb}</p>
      </div>

      <footer class="modal-footer">
        <button
          type="button"
          class="btn-skip"
          onclick={skip}
          data-testid="onboarding-tour-skip"
        >
          Skip tour
        </button>

        <div class="right-cluster">
          <button
            type="button"
            class="btn-back"
            onclick={back}
            disabled={isFirst}
            data-testid="onboarding-tour-back"
          >
            Back
          </button>

          {#if isLast}
            <button
              type="button"
              class="btn-finish"
              onclick={finish}
              data-testid="onboarding-tour-finish"
            >
              Done
            </button>
          {:else}
            <button
              type="button"
              class="btn-next"
              onclick={next}
              data-testid="onboarding-tour-next"
            >
              Next
            </button>
          {/if}
        </div>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 600;
    background: var(--atlas-scrim);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .modal {
    width: min(560px, 100%);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl);
    box-shadow: 0 24px 64px var(--atlas-scrim);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 90vh;
  }

  .progress {
    height: 3px;
    background: var(--border);
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.25s ease;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
  }

  .step-meta {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .step-icon {
    font-size: var(--text-2xl);
  }

  .modal-header h3 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text-main);
  }

  .step-counter {
    font-size: var(--text-md);
    color: var(--text-muted);
  }

  .modal-body {
    padding: 24px 20px;
    overflow-y: auto;
  }

  .modal-body p {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.55;
    font-size: var(--text-xl);
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    background: var(--surface-raised);
  }

  .right-cluster {
    display: flex;
    gap: 8px;
  }

  .btn-skip,
  .btn-back,
  .btn-next,
  .btn-finish {
    font-family: inherit;
    font-size: var(--text-md);
    border-radius: var(--radius-md);
    padding: 6px 14px;
    cursor: pointer;
    transition: background var(--trans-fast), color var(--trans-fast),
      border-color var(--trans-fast);
  }

  .btn-skip {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
  }

  .btn-skip:hover {
    color: var(--text-main);
    border-color: var(--border);
  }

  .btn-back {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }

  .btn-back:hover:not(:disabled) {
    background: var(--surface);
    color: var(--text-main);
  }

  .btn-back:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-next,
  .btn-finish {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: var(--atlas-on-fill);
    font-weight: 500;
  }

  .btn-next:hover,
  .btn-finish:hover {
    filter: brightness(1.1);
  }
</style>