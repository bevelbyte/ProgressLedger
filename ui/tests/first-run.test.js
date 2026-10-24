/**
 * First run — Atlas §5.7.
 *
 * Roughly fifteen Electron specs (phase5/phase6/phase7/phase8/phase10,
 * packaged-smoke, credential-*) cannot do anything until they
 * have dismissed first run, and they all dismiss it the same way:
 *
 *     const overlay   = win.locator('.onboarding-overlay');
 *     const skipBtn   = win.locator('button.skip-btn:has-text("Skip Tutorial")');
 *     if (await skipBtn.isVisible(...))  await skipBtn.click();
 *     else if (completeBtn visible)      await completeBtn.click();
 *     await overlay.waitFor({ state: 'hidden' });
 *
 * The flow was reduced from six slides to three, which is exactly the change
 * that can break that sequence: if the skip button is renamed, re-worded, or
 * rendered only on some steps, every one of those specs starts timing out at
 * its first step instead of failing where the real error is. So the contract is
 * pinned here, in seconds, along with the behaviour that actually matters: the
 * profile input creates a real profile, and nothing advances without one.
 */

import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";

import Onboarding from "../src/features/onboarding/components/Onboarding.svelte";
import {
  onboarding,
  startOnboarding,
  skipOnboarding,
  completeOnboarding,
} from "../src/shared/stores/onboarding.svelte.js";

let addCalls = [];
let dataChanged = 0;

// Held at module scope so each install can remove the previous listener.
// Without this the counter keeps whatever the earlier tests fired, which looks
// exactly like the component dispatching the event seven times.
let onChange = null;

function installIpc({ fail = null } = {}) {
  addCalls = [];
  dataChanged = 0;
  if (onChange) window.removeEventListener("cf:data-changed", onChange);
  onChange = () => {
    dataChanged += 1;
  };
  window.addEventListener("cf:data-changed", onChange);
  window.progressLedger = {
    profiles: {
      add: vi.fn(async (name, slug) => {
        await Promise.resolve();
        if (fail) throw new Error(fail);
        addCalls.push({ name, slug });
        return { id: 42, name, slug };
      }),
    },
  };
}

const q = (sel) => document.querySelector(sel);
const byText = (sel, t) => [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(t));

async function flush() {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await tick();
}

async function mount() {
  const onComplete = vi.fn();
  render(Onboarding, { props: { onComplete } });
  await flush();
  return onComplete;
}

beforeEach(() => {
  localStorage.clear();
  installIpc();
  startOnboarding();
  onboarding.currentStep = 0;
  onboarding.profileCreated = false;
  onboarding.createdProfileId = null;
});

afterEach(() => {
  cleanup();
  if (onChange) window.removeEventListener("cf:data-changed", onChange);
  onChange = null;
  completeOnboarding();
  localStorage.clear();
  delete window.progressLedger;
});

describe("first run — the dismissal contract", () => {
  it("renders .onboarding-overlay as a labelled modal", async () => {
    await mount();
    const overlay = q(".onboarding-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
  });

  it("offers 'Skip Tutorial' on step 1, which is what the specs click", async () => {
    await mount();
    const skip = q("button.skip-btn");
    expect(skip).toBeTruthy();
    expect(skip.textContent.trim()).toBe("Skip Tutorial");
  });

  it("closes the overlay and reports completion when skipped", async () => {
    const onComplete = await mount();
    await fireEvent.click(q("button.skip-btn"));
    await flush();

    expect(onboarding.active).toBe(false);
    expect(q(".onboarding-overlay")).toBeFalsy();
    expect(onComplete).toHaveBeenCalledTimes(1);
    // Skipping is a real decision: it must not show the flow again.
    expect(localStorage.getItem("progressledger_v2_onboarding_complete")).toBe("true");
  });

  it("replaces Skip with Complete on the final step", async () => {
    onboarding.currentStep = 2;
    await mount();

    expect(q("button.skip-btn")).toBeFalsy();
    const complete = q("button.complete-btn");
    expect(complete).toBeTruthy();
    expect(complete.textContent.trim()).toBe("Complete");

    await fireEvent.click(complete);
    await flush();
    expect(onboarding.active).toBe(false);
    expect(localStorage.getItem("progressledger_v2_onboarding_complete")).toBe("true");
  });

  it("runs three steps, not six", async () => {
    await mount();
    const labels = [...document.querySelectorAll(".rail-step .rail-label")].map((el) =>
      el.textContent.trim(),
    );
    expect(labels).toEqual(["What this is", "Your profile", "Get started"]);
    expect(onboarding.totalSteps).toBe(3);
  });
});

describe("first run — the one real input", () => {
  it("does not advance past the profile step without creating a profile", async () => {
    onboarding.currentStep = 1;
    await mount();

    // No profile yet → no Continue affordance, and the keyboard cannot skip it.
    expect(q("button.next-btn")).toBeFalsy();
    await fireEvent.keyDown(window, { key: "ArrowRight" });
    await flush();
    expect(onboarding.currentStep).toBe(1);
  });

  it("creates the profile, then advances", async () => {
    onboarding.currentStep = 1;
    await mount();

    const input = q(".name-form input.cf-input");
    await fireEvent.input(input, { target: { value: "Personal" } });
    await flush();

    await fireEvent.click(byText("button", "Create profile"));
    await flush();

    expect(addCalls).toEqual([{ name: "Personal", slug: "personal" }]);
    expect(onboarding.profileCreated).toBe(true);
    expect(onboarding.createdProfileId).toBe(42);
    // The rest of the app re-reads profiles on this event.
    expect(dataChanged).toBe(1);
    expect(onboarding.currentStep).toBe(2);
  });

  it("states a failure inline and stays put instead of advancing", async () => {
    installIpc({ fail: "slug already exists" });
    onboarding.currentStep = 1;
    await mount();

    await fireEvent.input(q(".name-form input.cf-input"), { target: { value: "Personal" } });
    await fireEvent.click(byText("button", "Create profile"));
    await flush();

    const error = q("#ob-error");
    expect(error).toBeTruthy();
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("slug already exists");
    expect(onboarding.currentStep).toBe(1);
    expect(onboarding.profileCreated).toBe(false);
  });

  it("refuses a name that slugifies to nothing", async () => {
    onboarding.currentStep = 1;
    await mount();

    await fireEvent.input(q(".name-form input.cf-input"), { target: { value: "!!!" } });
    await fireEvent.click(byText("button", "Create profile"));
    await flush();

    expect(addCalls).toEqual([]);
    expect(q("#ob-error")).toBeTruthy();
  });

  it("keys Escape to skip, so first run is never a trap", async () => {
    const onComplete = await mount();
    await fireEvent.keyDown(window, { key: "Escape" });
    await flush();

    expect(onboarding.active).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("walks back with ArrowLeft", async () => {
    onboarding.currentStep = 2;
    await mount();
    await fireEvent.keyDown(window, { key: "ArrowLeft" });
    await flush();
    expect(onboarding.currentStep).toBe(1);
  });
});

describe("first run — honest claims", () => {
  it("carries no emoji as UI iconography", async () => {
    // The old flow put 👋👤📚🔬🧠🚀 in the step header. Emoji render as a
    // different font on every platform and read as decoration next to real
    // product chrome, so the flow uses the icon set instead.
    await mount();
    const text = q(".onboarding-overlay").textContent;
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("points at destinations the product actually has", async () => {
    onboarding.currentStep = 2;
    await mount();
    const text = q(".onboarding-overlay").textContent;
    for (const destination of ["Desk", "Academic", "Runs"]) {
      expect(text).toContain(destination);
    }
  });
});
