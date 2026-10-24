import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditIpc = readFileSync(fileURLToPath(new URL("../src/ipc/audit.js", import.meta.url)), "utf8");
const projectMode = readFileSync(fileURLToPath(new URL("../src/ipc/project-mode.js", import.meta.url)), "utf8");
const memoryIpc = readFileSync(fileURLToPath(new URL("../src/ipc/memory.js", import.meta.url)), "utf8");
const auditService = readFileSync(fileURLToPath(new URL("../src/services/audit/index.js", import.meta.url)), "utf8");

test("audit renderer reads require an owned profile and cannot request the global ring", () => {
  for (const channel of ["audit:list", "audit:list-events"]) {
    const start = auditIpc.indexOf(`safeHandle("${channel}"`);
    assert.ok(start >= 0);
    const body = auditIpc.slice(start, start + 900);
    assert.match(body, /const profileId = options\?\.profileId/);
    assert.match(body, /assertProfileOwned\(ctx, profileId\)/);
    assert.match(body, /const filter = \{ profileId \}/);
  }
  assert.match(auditIpc, /return \{ ok: true, filename: "audit-log\.jsonl" \}/);
  assert.doesNotMatch(auditIpc, /return \{ ok: true, path: p \}/);
});

test("project-mode renderer event forwarding rejects stale runs before sanitization", () => {
  assert.match(projectMode, /isCurrentAgentRunEvent\(event, getRun\(childArgs\.agentId\)\)/);
  assert.match(projectMode, /isCurrentAgentRunEvent\(event, getRun\(agentId\)\)/);
});

test("memory renderer payloads have bounded rows and text", () => {
  assert.match(memoryIpc, /MAX_RENDERER_TEXT = 8192/);
  assert.match(memoryIpc, /MAX_RENDERER_ROWS = 600/);
  assert.match(memoryIpc, /Math\.min\(Math\.max\(Math\.floor\(payload\.limit\), 1\), MAX_RENDERER_ROWS\)/);
  assert.match(memoryIpc, /Math\.min\(Math\.max\(Math\.floor\(payload\.maxTokens\), 1\), 8000\)/);
});

test("durable audit fields are bounded before redaction/persistence", () => {
  assert.match(auditService, /MAX_FIELD_CHARS = 4096/);
  assert.match(auditService, /input_summary: typeof event\.input_summary === "string" \? redact\(event\.input_summary\)\.slice\(0, MAX_FIELD_CHARS\)/);
  assert.match(auditService, /detail: typeof event\.detail === "string" \? redact\(event\.detail\)\.slice\(0, MAX_FIELD_CHARS\)/);
  assert.match(auditService, /result: typeof event\.result === "string" \? event\.result\.slice\(0, MAX_FIELD_CHARS\)/);
});