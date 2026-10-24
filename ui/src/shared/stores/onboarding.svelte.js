/**
 * Onboarding state management (Svelte 5 runes)
 */

const STORAGE_KEY = 'careerflow_onboarding_complete';

// First run is three steps (docs/DESIGN-ATLAS.md §5.7). It used to be six:
// four of those six asked for nothing and explained panels the user had not
// seen yet, and the fifth was a "Ready!" slide shown over an empty workspace.
// Say what this is → ask for the one thing we need → point at where to start.
export const ONBOARDING_STEPS = 3;

// Global onboarding state
export const onboarding = $state({
  active: false,
  currentStep: 0,
  totalSteps: ONBOARDING_STEPS,
  profileCreated: false,
  createdProfileId: null
});

/**
 * Check if onboarding should be shown
 */
export function shouldShowOnboarding() {
  if (typeof window === 'undefined') return false;
  if (window.careerflow?.runtime?.isE2E === true) return false;
  return !localStorage.getItem(STORAGE_KEY);
}

/**
 * Start the onboarding flow
 */
export function startOnboarding() {
  onboarding.active = true;
  onboarding.currentStep = 0;
  onboarding.profileCreated = false;
  onboarding.createdProfileId = null;
}

/**
 * Advance to next step
 */
export function nextStep() {
  if (onboarding.currentStep < onboarding.totalSteps - 1) {
    onboarding.currentStep++;
  }
}

/**
 * Go back to previous step
 */
export function prevStep() {
  if (onboarding.currentStep > 0) {
    onboarding.currentStep--;
  }
}

/**
 * Skip onboarding entirely
 */
export function skipOnboarding() {
  completeOnboarding();
}

/**
 * Complete onboarding and save state
 */
export function completeOnboarding() {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, 'true');
  }
  onboarding.active = false;
  onboarding.currentStep = 0;
}

/**
 * Reset onboarding (for "Show Tutorial" feature)
 */
export function resetOnboarding() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Mark profile as created during onboarding
 */
export function markProfileCreated(profileId) {
  onboarding.profileCreated = true;
  onboarding.createdProfileId = profileId;
}

/**
 * Get current step info.
 *
 * Titles only — the flow renders iconography from the icon set (lucide) rather
 * than from emoji, which render as a different font on every platform and read
 * as decoration next to real product chrome.
 */
export function getCurrentStep() {
  const steps = [
    { id: 'intro', title: 'What this is' },
    { id: 'profile', title: 'Your profile' },
    { id: 'start', title: 'Get started' }
  ];
  return steps[onboarding.currentStep] || steps[0];
}
