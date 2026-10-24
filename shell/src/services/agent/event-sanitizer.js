// Renderer-safe projection of agent-loop events.
//
// Tool arguments are intentionally excluded because they can contain file
// contents, commands, credentials, or other model-generated sensitive data.
// The durable transcript remains the authoritative detailed record.

const MAX_EVENT_STRING = 4096;

function boundedString(value, max = MAX_EVENT_STRING) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

export function isCurrentAgentRunEvent(event, run) {
  return Boolean(event && typeof event.runId === "string" && event.runId.length > 0 && run && typeof run.runId === "string" && event.runId === run.runId);
}

export function sanitizeAgentEvent({ profileId, projectId, agentId, event }) {
  if (!event || typeof event.type !== "string") return null;
  if (!Number.isInteger(profileId) || profileId <= 0) return null;
  if (!Number.isInteger(projectId) || projectId <= 0) return null;
  if (!Number.isInteger(agentId) || agentId <= 0) return null;
  if (typeof event.runId !== "string" || event.runId.length === 0) return null;
  const p = event.payload && typeof event.payload === "object" ? event.payload : {};
  const safe = {
    profileId,
    projectId,
    agentId,
    runId: boundedString(event.runId, 128),
    type: event.type,
    ts: Number(event.ts) || Date.now(),
  };
  switch (event.type) {
    case "agent.started":
    case "agent.planning":
    case "agent.replanning":
    case "agent.verifying":
    case "agent.completed":
    case "agent.failed":
    case "agent.cancelled":
    case "agent.resumed":
    case "memory.recalled":
    case "agent.project_intel.recalled":
      for (const key of ["objective", "tokensIn", "tokensOut", "reason", "verified", "fixAttempts", "fixStepId", "planStepCount", "tokenCount", "historyCount", "fileCount"]) {
        if (p[key] !== undefined) { if (typeof p[key] === "string") safe[key] = boundedString(p[key]); else if (Number.isFinite(p[key]) || typeof p[key] === "boolean") safe[key] = p[key]; }
      }
      break;
    case "agent.text.delta":
      if (typeof p.delta === "string") safe.delta = boundedString(p.delta);
      break;
    case "agent.tool.started":
      if (typeof p.tool === "string") safe.tool = boundedString(p.tool, 256);
      if (typeof p.callId === "string") safe.callId = boundedString(p.callId, 256);
      break;
    case "agent.tool.completed":
      if (typeof p.tool === "string") safe.tool = boundedString(p.tool, 256);
      if (typeof p.callId === "string") safe.callId = boundedString(p.callId, 256);
      if (Number.isFinite(p.elapsedMs)) safe.elapsedMs = p.elapsedMs;
      break;
    case "agent.tool.failed":
      if (typeof p.tool === "string") safe.tool = boundedString(p.tool, 256);
      if (typeof p.callId === "string") safe.callId = boundedString(p.callId, 256);
      if (p.error && typeof p.error === "object" && typeof p.error.code === "string") safe.errorCode = p.error.code;
      break;
    case "agent.approval.required":
      if (typeof p.approvalId === "string") safe.approvalId = boundedString(p.approvalId, 256);
      if (typeof p.callId === "string") safe.callId = boundedString(p.callId, 256);
      if (typeof p.tool === "string") safe.tool = boundedString(p.tool, 256);
      if (typeof p.permission === "string") safe.permission = boundedString(p.permission, 128);
      break;
    default:
      break;
  }
  return safe;
}
