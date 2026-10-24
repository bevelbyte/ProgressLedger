// Goals — thin wrapper around the IPC namespace.

const ns = () => window.careerflow && window.careerflow.goals;

function call(method, ...args) {
  const n = ns();
  if (!n || typeof n[method] !== "function") {
    return Promise.reject(new Error(`goals.${method} is not available`));
  }
  return n[method](...args);
}

export const goalsService = {
  create: (input) => call("create", input),
  get: (profileId, goalId) => call("get", profileId, goalId),
  list: (profileId, options) => call("list", profileId, options || {}),
  remove: (profileId, goalId) => call("remove", profileId, goalId),
  start: (profileId, goalId) => call("start", profileId, goalId),
  cancel: (profileId, goalId) => call("cancel", profileId, goalId),
  linkAgent: (profileId, goalId, agentId) => call("linkAgent", profileId, goalId, agentId),
  listEvents: (profileId, goalId, limit) => call("listEvents", profileId, goalId, limit),
  getAgentId: (profileId, goalId) => call("getAgentId", profileId, goalId),
  reconcile: (profileId) => call("reconcile", profileId),
  recoverySweep: (profileId) => call("recoverySweep", profileId),
  resume: (profileId, goalId, agentId) => call("resume", profileId, goalId, agentId),
  onEvent: (cb) => call("onEvent", cb),
};