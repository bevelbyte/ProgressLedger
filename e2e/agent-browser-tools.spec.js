// Agent browser-control compatibility contract after R6.
//
// Donut page automation through custom CDP/DevTools is retired. This spec uses
// the real Electron app and the real agent loop/registry, but no Donut stub,
// Chromium debug port, CDP client, or external browser process. Every legacy
// browser_* tool must return feature-not-supported without fabricating page,
// tab, screenshot, click, typing, or navigation state.

import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_KEY = "R7-LOCAL-AGENT-FIXTURE-KEY-NOT-A-SECRET";
const TOOL_NAMES = [
  "browser_get_state",
  "browser_launch",
  "browser_stop",
  "browser_navigate",
  "browser_new_tab",
  "browser_close_tab",
  "browser_activate_tab",
  "browser_screenshot",
  "browser_get_page",
  "browser_extract_text",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_wait",
];

function startScriptedProvider() {
  const state = { rounds: [], callSeq: 0 };
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const round = state.rounds.length > 1 ? state.rounds.shift() : state.rounds[0];
      if (!round) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "script-queue-empty" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunks = [];
      const calls = round.toolCalls || [];
      for (const [index, call] of calls.entries()) {
        chunks.push({ delta: { tool_calls: [{ index, id: `r7-call-${++state.callSeq}`, type: "function", function: { name: call.name, arguments: "" } }] } });
        chunks.push({ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(call.args || {}) } }] } });
      }
      if (calls.length) chunks.push({ delta: {}, finish_reason: "tool_calls" });
      else {
        chunks.push({ delta: { content: round.text || "done" } });
        chunks.push({ delta: {}, finish_reason: "stop" });
      }
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-r7", model: "r7-scripted", choices: [chunk] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    state.endpoint = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, state });
  }));
}

async function launchWithoutDonut(userDataDir, absentSettingsDir) {
  const env = {
    ...process.env,
    PROGRESSLEDGER_V2_E2E: "1",
    PROGRESSLEDGER_V2_E2E_USER_DATA: userDataDir,
    PROGRESSLEDGER_V2_E2E_DISABLE_SYSTEM_FALLBACK: "1",
    PROGRESSLEDGER_V2_DONUT_SETTINGS_DIR: absentSettingsDir,
  };
  delete env.PROGRESSLEDGER_V2_E2E_DONUT_STUB;
  delete env.PROGRESSLEDGER_V2_E2E_DONUT_MODE;
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env,
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect(win.getByText(/Progress Ledger core online/i)).toBeVisible();
  return { app, win };
}

async function createAgent(win, userDataDir, providerEndpoint, projectRootPath) {
  const profile = await win.evaluate(() =>
    window.progressLedger.profiles.add("R7 Unsupported Browser Tools", `r7-browser-tools-${Date.now()}`));
  const project = await win.evaluate(([profileId, rootPath]) =>
    window.progressLedger.projectMode.createProject({
      profileId,
      name: "R7 Browser Boundary",
      description: "Verify retired Donut page-control tools fail closed",
      rootPath,
      configJson: "{}",
    }), [profile.id, projectRootPath]);
  const projectId = typeof project === "number" ? project : project?.id;
  expect(Number(projectId)).toBeGreaterThan(0);
  const createdAgent = await win.evaluate(([profileId, projectId]) =>
    window.progressLedger.projectMode.createAgent(profileId, projectId, "Call each legacy browser tool and report its actual result."),
  [profile.id, Number(projectId)]);
  const agentId = typeof createdAgent === "number" ? createdAgent : createdAgent?.id;
  expect(Number(agentId)).toBeGreaterThan(0);
  writeFileSync(join(userDataDir, "pm-secrets.json"), JSON.stringify({
    [`${profile.id}:${projectId}`]: {
      endpoint: providerEndpoint,
      apiKey: FIXTURE_KEY,
      model: "r7-scripted",
      updatedAt: Date.now(),
    },
  }, null, 2), "utf8");
  return { profileId: Number(profile.id), projectId: Number(projectId), agentId: Number(agentId) };
}

async function waitForTerminalAgent(win, profileId, agentId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const raw = await win.evaluate(([pid, aid]) => window.progressLedger.projectMode.getAgent(pid, aid), [profileId, agentId]);
    const agent = raw?.agent || raw;
    if (agent && ["completed", "failed", "cancelled"].includes(agent.state)) return agent;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("timed out waiting for scripted R7 agent run");
}

async function listMessages(win, profileId, agentId) {
  const raw = await win.evaluate(([pid, aid]) => window.progressLedger.projectMode.listMessages(pid, aid), [profileId, agentId]);
  return raw?.messages || raw?.result || raw;
}

test("real agent loop rejects all retired Donut page-control tools without fake state or Donut startup", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "cf-r7-browser-agent-"));
  const projectRootPath = mkdtempSync(join(tmpdir(), "cf-r7-browser-project-"));
  const absentSettingsDir = join(tmpdir(), `cf-r7-donut-absent-${Date.now()}`);
  const provider = await startScriptedProvider();
  let app;

  try {
    const launched = await launchWithoutDonut(userDataDir, absentSettingsDir);
    app = launched.app;
    const { win } = launched;

    const metadata = await win.evaluate(() => window.progressLedger.projectTools.list());
    expect(metadata.ok).toBe(true);
    const tools = new Map(metadata.tools.map((tool) => [tool.name, tool]));
    for (const name of TOOL_NAMES) {
      expect(tools.has(name), `${name} is registered`).toBe(true);
      expect(tools.get(name).permission).toBe("READ");
      expect(tools.get(name).description).toMatch(/unsupported/i);
    }

    const workspaceRefusals = await win.evaluate(async () => {
      const ws = window.progressLedger.browserWorkspace;
      return Promise.all([
        ws.state(),
        ws.launch("unused-profile", 1),
        ws.stop(),
        ws.navigate("unused-profile", 1, "https://example.com/"),
        ws.newTab("unused-profile", 1),
        ws.closeTab("unused-profile", 1, "fake-tab"),
        ws.activateTab("unused-profile", 1, "fake-tab"),
        ws.reload("unused-profile", 1, "fake-tab"),
        ws.back("unused-profile", 1, "fake-tab"),
        ws.forward("unused-profile", 1, "fake-tab"),
        ws.screenshot("unused-profile", 1, "fake-tab"),
        ws.subscribe(),
      ]);
    });
    expect(workspaceRefusals).toHaveLength(12);
    for (const result of workspaceRefusals) {
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("feature-not-supported");
      expect(result.message).toMatch(/supported Local API/i);
      expect(result).not.toHaveProperty("workspace");
      expect(result).not.toHaveProperty("tabs");
      expect(result).not.toHaveProperty("image");
    }

    const agent = await createAgent(win, userDataDir, provider.state.endpoint, projectRootPath);
    provider.state.rounds = [
      { toolCalls: TOOL_NAMES.map((name) => ({ name, args: {
        profileLocalId: "forged-profile",
        tabId: "forged-tab",
        url: "https://example.com/",
        selector: "#not-real",
        text: "must-not-be-typed",
        key: "Enter",
      } })) },
      { text: "All legacy browser tool results have been checked." },
    ];
    const started = await win.evaluate(([profileId, agentId]) =>
      window.progressLedger.projectMode.startAgent(profileId, agentId), [agent.profileId, agent.agentId]);
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const terminal = await waitForTerminalAgent(win, agent.profileId, agent.agentId);
    expect(terminal.state).toBe("completed");

    const messages = await listMessages(win, agent.profileId, agent.agentId);
    const toolResults = messages.filter((message) => message.role === "tool_result");
    expect(toolResults).toHaveLength(TOOL_NAMES.length);
    expect(toolResults.map((message) => message.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const row of toolResults) {
      const result = JSON.parse(row.content);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("feature-not-supported");
      expect(result).not.toHaveProperty("result");
      expect(result).not.toHaveProperty("workspace");
      expect(result).not.toHaveProperty("tabs");
      expect(result).not.toHaveProperty("image");
      expect(row.content).not.toContain("forged-tab");
      expect(row.content).not.toContain("must-not-be-typed");
      expect(row.content).not.toContain("data:image/");
    }

    // Donut is genuinely absent for this run: the app booted without a stub,
    // and unsupported tools did not use the Local API profile-open path.
    expect(await win.evaluate(() => window.progressLedger.donut.getStatus())).toMatchObject({ available: false });
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise((resolve) => provider.server.close(resolve));
  }
});
