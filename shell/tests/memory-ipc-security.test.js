import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const memorySource = readFileSync(
  fileURLToPath(new URL("../src/ipc/memory.js", import.meta.url)),
  "utf8",
);
const preloadSource = readFileSync(
  fileURLToPath(new URL("../src/preload.cjs", import.meta.url)),
  "utf8",
);
const viewerSource = readFileSync(
  fileURLToPath(new URL("../../ui/src/features/project-mode/components/MemoryViewer.svelte", import.meta.url)),
  "utf8",
);

function bodyOf(channel, size = 1800) {
  const start = memorySource.indexOf(`safeHandle("${channel}"`);
  assert.ok(start >= 0, `${channel} must be registered through safeHandle`);
  return memorySource.slice(start, start + size);
}

test("memory IPC requires an owned profile/project tuple before persistence access", () => {
  for (const channel of [
    "memory:project-set",
    "memory:project-list",
    "memory:context-packet",
    "memory:list",
  ]) {
    const body = bodyOf(channel);
    assert.match(body, /profileId.*projectId/,
      `${channel} must require both profileId and projectId`);
    assert.match(body, /assertProjectOwned\(ctx, profileId, projectId\)/,
      `${channel} must verify project ownership before accessing memory`);
  }
});

test("memory:list binds session-memory reads to an owned agent", () => {
  const body = bodyOf("memory:list", 3000);
  assert.match(body, /pmGetAgent\(profileId, numericAgentId\)/);
  assert.match(body, /authorizeAgentRecord\(profileId, numericAgentId, agent\)/);
  assert.match(body, /sessionList\(projectId, agentId\)/);
});

test("renderer memory API carries projectId so one profile cannot mix projects", () => {
  const start = preloadSource.indexOf("  memory: {");
  const body = preloadSource.slice(start, start + 1800);
  assert.match(body, /projectSet: \(profileId, projectId,/);
  assert.match(body, /projectList: \(profileId, projectId,/);
  assert.match(body, /contextPacket: \(profileId, projectId,/);
  assert.match(body, /list: \(profileId, projectId,/);
});

test("MemoryViewer uses the active project id when loading memory", () => {
  assert.match(viewerSource, /let \{ profileId = null, projectId = null \} = \$props\(\)/);
  assert.match(viewerSource, /memory\.list\(profileId, projectId, \{\}\)/);
});
