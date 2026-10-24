/**
 * Goal Mode — public UI API.
 */

export { default as GoalsPanel } from "./components/GoalsPanel.svelte";
export { default as GoalDetailView } from "./components/GoalDetailView.svelte";
export { default as GoalsView } from "./components/GoalsView.svelte";

export { goalsStore } from "./stores/goals.svelte.js";
export { goalsService } from "./services/goals.service.js";