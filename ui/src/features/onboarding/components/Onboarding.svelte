<script>
  // First run (docs/DESIGN-ATLAS.md §5.7).
  //
  // The previous flow was a six-slide tutorial carousel: Welcome → Create
  // Profile → Academic Tree → Research Links → Knowledge Engine → Ready. Only
  // one of those six slides asked for anything, and it was the second one, so a
  // brand-new user's first interaction with Progress Ledger was to click "Next"
  // through four marketing panels — *before* the product had done anything for
  // them — and then be told it was "Ready!" while sitting in an empty workspace.
  //
  // First run now does the three things a first run can honestly do:
  //   1. SAY WHAT THIS IS  — one screen, one sentence, no carousel.
  //   2. ASK FOR ONE THING — the profile name, which is a real input writing a
  //                          real row (profile:add). Nothing advances until it
  //                          exists.
  //   3. POINT AT THE START — where to go first, stated as destinations rather
  //                          than as a tour of panels the user has not seen.
  //
  // The deleted slides were not deleted content: the same explanations live in
  // the contextual guide (Project Mode guide, `?` keyboard reference, Settings →
  // Show tutorial), which is where a user actually needs them — while looking
  // at the thing being explained, not before.
  //
  // Contract that must survive: `.onboarding-overlay` root, a
  // `button.skip-btn` reading "Skip Tutorial" on every step before the last,
  // and `button.complete-btn` on the last step. Fifteen Electron specs dismiss
  // first run through exactly those three hooks.

  import { ArrowRight, CircleCheck } from "lucide-svelte";
  import {
    onboarding,
    nextStep,
    prevStep,
    skipOnboarding,
    completeOnboarding,
    markProfileCreated,
  } from "../../../shared/stores/onboarding.svelte.js";

  let { onComplete } = $props();

  // Step 2 state — the only input in the flow.
  let profileName = $state("");
  let creatingProfile = $state(false);
  let profileError = $state("");

  const STEP = {
    INTRO: 0,
    PROFILE: 1,
    START: 2,
  };

  const isFirst = $derived(onboarding.currentStep === STEP.INTRO);
  const isProfile = $derived(onboarding.currentStep === STEP.PROFILE);
  const isLast = $derived(onboarding.currentStep === STEP.START);

  $effect(() => {
    function handleKeydown(e) {
      if (!onboarding.active) return;

      if (e.key === "Escape") {
        skipOnboarding();
        onComplete?.();
      } else if (e.key === "ArrowRight" && !isLast) {
        // Step 2 is gated on a real profile: the whole point of asking is that
        // the rest of the product cannot work without one.
        if (!isProfile || onboarding.profileCreated) nextStep();
      } else if (e.key === "ArrowLeft" && !isFirst) {
        prevStep();
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  async function createProfile() {
    const name = profileName.trim();
    if (!name) {
      profileError = "Enter a name to continue.";
      return;
    }

    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) {
      profileError = "That name has no letters or digits in it.";
      return;
    }

    creatingProfile = true;
    profileError = "";

    try {
      const profile = await window.progressLedger.profiles.add(name, slug);
      markProfileCreated(profile.id);

      // The rest of the app re-reads profiles on this event.
      window.dispatchEvent(new Event("cf:data-changed"));

      // Advance as soon as the row exists; no artificial delay.
      nextStep();
    } catch (e) {
      profileError = e?.message || "Couldn't create the profile.";
    } finally {
      creatingProfile = false;
    }
  }

  function handleSkip() {
    skipOnboarding();
    onComplete?.();
  }

  function handleComplete() {
    completeOnboarding();
    onComplete?.();
  }

  function handleNext() {
    if (isProfile && !onboarding.profileCreated) {
      profileError = "Create a profile to continue.";
      return;
    }
    nextStep();
  }
</script>

{#if onboarding.active}
  <div
    class="onboarding-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="Welcome to Progress Ledger"
  >
    <div class="welcome">
      <ol class="rail" aria-label="Setup progress">
        {#each ["What this is", "Your profile", "Get started"] as label, i (label)}
          <li
            class="rail-step"
            class:done={i < onboarding.currentStep}
            class:on={i === onboarding.currentStep}
          >
            <span class="rail-dot" aria-hidden="true"></span>
            <span class="rail-label">{label}</span>
          </li>
        {/each}
      </ol>

      <div class="panel">
        {#if isFirst}
          <section class="step" aria-labelledby="ob-title">
            <h2 id="ob-title" class="step-title">A career intelligence hub, on your machine.</h2>
            <p class="step-lede">
              Progress Ledger keeps your academic work, your career planning, your research and
              your agent runs in one local workspace. Nothing leaves this computer unless
              you connect something that sends it.
            </p>
            <dl class="facts">
              <div class="fact">
                <dt class="atl-label">Academic</dt>
                <dd>Semesters, subjects, deadlines, CGPA, study sessions.</dd>
              </div>
              <div class="fact">
                <dt class="atl-label">Knowledge</dt>
                <dd>Notes, PDFs, flashcards, formulas, mistakes you have logged.</dd>
              </div>
              <div class="fact">
                <dt class="atl-label">Operator</dt>
                <dd>Agent runs you approve, and a browser it works inside.</dd>
              </div>
            </dl>
            <p class="hint">Everything is scoped to a profile. Let's make yours.</p>
          </section>
        {:else if isProfile}
          <section class="step" aria-labelledby="ob-title">
            <h2 id="ob-title" class="step-title">What should we call it?</h2>
            <p class="step-lede">
              A profile is one workspace: its own subjects, goals, projects and agent
              history. Most people need exactly one; you can add more later.
            </p>

            {#if onboarding.profileCreated}
              <p class="done-line">
                <CircleCheck size={14} strokeWidth={2} aria-hidden="true" />
                Profile created. You're set.
              </p>
            {:else}
              <form
                class="name-form"
                onsubmit={(e) => {
                  e.preventDefault();
                  createProfile();
                }}
              >
                <label class="field">
                  <span class="atl-label">Profile name</span>
                  <input
                    class="cf-input"
                    placeholder="e.g. Personal"
                    maxlength={60}
                    bind:value={profileName}
                    aria-invalid={profileError ? "true" : undefined}
                    aria-describedby={profileError ? "ob-error" : undefined}
                    disabled={creatingProfile}
                  />
                </label>
                <button
                  type="submit"
                  class="cf-btn primary"
                  disabled={creatingProfile || !profileName.trim()}
                >
                  {creatingProfile ? "Creating…" : "Create profile"}
                </button>
              </form>
            {/if}

            {#if profileError}
              <p class="error" id="ob-error" role="alert">{profileError}</p>
            {/if}
          </section>
        {:else}
          <section class="step" aria-labelledby="ob-title">
            <h2 id="ob-title" class="step-title">Where to go first.</h2>
            <p class="step-lede">
              The rail on the left is the whole product, grouped into four planes. Three
              places are worth opening before anything else:
            </p>
            <ul class="destinations">
              <li>
                <span class="atl-label">Desk</span>
                <span>Today's agenda: what is due, what is overdue, what to review.</span>
              </li>
              <li>
                <span class="atl-label">Academic</span>
                <span>Add the semester you are in, then its subjects.</span>
              </li>
              <li>
                <span class="atl-label">Runs</span>
                <span>Give an agent an objective and approve what it wants to do.</span>
              </li>
            </ul>
            <p class="hint">
              <kbd class="cf-kbd">Ctrl</kbd> <kbd class="cf-kbd">K</kbd> reaches anything
              from anywhere, and <kbd class="cf-kbd">?</kbd> lists every shortcut.
            </p>
          </section>
        {/if}

        <footer class="actions">
          <!-- "Skip Tutorial" is the documented escape hatch on every step but
               the last; on the last step the single action is to finish. Both
               spellings are load-bearing for the Electron specs. -->
          {#if !isLast}
            <button type="button" class="cf-btn ghost skip-btn" onclick={handleSkip}>
              Skip Tutorial
            </button>
          {/if}

          <div class="spacer"></div>

          {#if !isFirst}
            <button type="button" class="cf-btn secondary back-btn" onclick={prevStep}>
              Back
            </button>
          {/if}

          {#if isLast}
            <button type="button" class="cf-btn primary complete-btn" onclick={handleComplete}>
              Complete
            </button>
          {:else if isProfile && onboarding.profileCreated}
            <button type="button" class="cf-btn primary next-btn" onclick={handleNext}>
              Next
              <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          {:else if isProfile}
            <!-- A disabled "Next" here would look like a broken button; the
                 action IS the form submit above. -->
          {:else}
            <button type="button" class="cf-btn primary next-btn" onclick={handleNext}>
              Continue
              <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          {/if}
        </footer>
      </div>
    </div>
  </div>
{/if}

<style>
  .onboarding-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-dialog);
    background: var(--atlas-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
    animation: ob-in var(--dur-slow) var(--ease);
  }

  @keyframes ob-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  /* A setup flow is a form, not a slideshow: a fixed-width instrument panel
     with a progress rail, so the whole thing reads as one shape from step to
     step instead of four differently-sized cards. */
  .welcome {
    display: grid;
    grid-template-columns: 208px minmax(0, 1fr);
    width: min(100%, 880px);
    max-height: 80vh;
    background: var(--atlas-panel);
    border: 1px solid var(--atlas-line-2);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-3), var(--lift);
    overflow: hidden;
  }

  @media (max-width: 720px) {
    .welcome {
      grid-template-columns: minmax(0, 1fr);
    }
    .rail {
      flex-direction: row;
      border-right: 0;
      border-bottom: 1px solid var(--atlas-line);
      gap: var(--space-3);
      padding: var(--space-3);
    }
    .rail-label {
      display: none;
    }
  }

  .rail {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-5) var(--space-4);
    background: var(--atlas-chrome);
    border-right: 1px solid var(--atlas-line);
    list-style: none;
  }

  .rail-step {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    padding: var(--space-1) 0;
  }

  .rail-step.on {
    color: var(--atlas-ink);
  }

  .rail-step.done {
    color: var(--atlas-ink-2);
  }

  .rail-dot {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-full);
    background: var(--atlas-line-2);
    flex-shrink: 0;
  }

  .rail-step.on .rail-dot {
    background: var(--atlas-signal);
    box-shadow: 0 0 0 3px var(--atlas-signal-soft);
  }

  .rail-step.done .rail-dot {
    background: var(--atlas-ok);
  }

  .panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: var(--space-6);
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .step-title {
    font-size: var(--text-2xl);
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--atlas-ink);
    line-height: 1.2;
  }

  .step-lede {
    font-size: var(--text-lg);
    line-height: 1.55;
    color: var(--atlas-ink-2);
    max-width: 58ch;
  }

  .facts,
  .destinations {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .fact,
  .destinations li {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: var(--space-3);
    align-items: baseline;
    padding: var(--space-2) 0;
    border-top: 1px solid var(--atlas-line);
    font-size: var(--text-md);
    color: var(--atlas-ink-2);
  }

  .fact dt,
  .destinations .atl-label {
    color: var(--atlas-ink-3);
  }

  .hint {
    margin-top: var(--space-2);
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
  }

  .name-form {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }

  .done-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
    font-size: var(--text-md);
    color: var(--atlas-ok);
  }

  .error {
    font-size: var(--text-sm);
    color: var(--atlas-bad);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-top: var(--space-4);
    margin-top: var(--space-4);
    border-top: 1px solid var(--atlas-line);
  }

  .spacer {
    flex: 1;
  }
</style>
