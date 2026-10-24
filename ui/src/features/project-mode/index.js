/**
 * Project Mode — public API.
 *
 * The agent workspace UI lives here. The renderer never sees the API
 * key; `getProviderConfig` returns `{ endpoint, model, hasKey }` only.
 */

export { default as ProjectModePanel } from "./components/ProjectModePanel.svelte";
export { default as ProjectList } from "./components/ProjectList.svelte";
export { default as ProjectWorkspace } from "./components/ProjectWorkspace.svelte";
export { default as AgentConversation } from "./components/AgentConversation.svelte";
export { default as PlanView } from "./components/PlanView.svelte";
export { default as ToolActivityList } from "./components/ToolActivityList.svelte";
export { default as ApprovalRequest } from "./components/ApprovalRequest.svelte";
export { default as ApprovalQueue } from "./components/ApprovalQueue.svelte";
export { default as ProviderConfigPanel } from "./components/ProviderConfigPanel.svelte";
export { default as SkillInventory } from "./components/SkillInventory.svelte";

export { projectModeStore } from "./stores/projectMode.svelte.js";
export { projectModeService } from "./services/projectMode.service.js";