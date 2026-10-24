import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerUnsupportedDonutTools,
  UNSUPPORTED_DONUT_TOOL_NAMES,
  UNSUPPORTED_DONUT_TOOL_MESSAGE,
} from "../src/services/browser-workspace-tools.js";
import {
  getTool,
  listTools,
  listToolsSafe,
  _resetForTests as resetRegistry,
} from "../src/services/project-tools/index.js";

test.beforeEach(() => resetRegistry());
test.afterEach(() => resetRegistry());

test("registers every retired Donut page-control name as a READ-only refusal", () => {
  const uninstall = registerUnsupportedDonutTools();
  try {
    const registered = new Set(listTools().map((tool) => tool.name));
    for (const name of UNSUPPORTED_DONUT_TOOL_NAMES) {
      assert.equal(registered.has(name), true, `${name} is registered`);
      const tool = getTool(name);
      assert.equal(tool.permission, "READ", `${name} cannot trigger mutation approval`);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.timeoutMs, 5000);
      assert.match(tool.description, /unsupported/i);
    }
  } finally {
    uninstall();
  }
});

test("every legacy tool fails explicitly without fabricating page, tab, or screenshot data", async () => {
  const uninstall = registerUnsupportedDonutTools();
  try {
    for (const name of UNSUPPORTED_DONUT_TOOL_NAMES) {
      const result = await getTool(name).execute({
        profileLocalId: "forged-profile",
        tabId: "forged-tab",
        url: "https://example.com/",
        selector: "#secret",
        text: "must-not-be-typed",
      }, { profileId: 7, agentId: 11 });

      assert.deepEqual(result, {
        ok: false,
        error: {
          code: "feature-not-supported",
          message: UNSUPPORTED_DONUT_TOOL_MESSAGE,
        },
      }, name);
      assert.equal(Object.hasOwn(result, "result"), false, `${name} has no fabricated result`);
      assert.equal(Object.hasOwn(result, "workspace"), false, `${name} has no fake workspace`);
      assert.equal(Object.hasOwn(result, "tabs"), false, `${name} has no fake tabs`);
      assert.equal(JSON.stringify(result).includes("forged-tab"), false);
      assert.equal(JSON.stringify(result).includes("must-not-be-typed"), false);
    }
  } finally {
    uninstall();
  }
});

test("safe tool metadata exposes no execute function and labels the retired capability", () => {
  const uninstall = registerUnsupportedDonutTools();
  try {
    const metadata = listToolsSafe().filter((tool) => UNSUPPORTED_DONUT_TOOL_NAMES.includes(tool.name));
    assert.equal(metadata.length, UNSUPPORTED_DONUT_TOOL_NAMES.length);
    for (const tool of metadata) {
      assert.equal(Object.hasOwn(tool, "execute"), false);
      assert.equal(tool.permission, "READ");
      assert.match(tool.description, /unsupported/i);
    }
  } finally {
    uninstall();
  }
});

test("unregister removes every compatibility tool", () => {
  const uninstall = registerUnsupportedDonutTools();
  uninstall();
  for (const name of UNSUPPORTED_DONUT_TOOL_NAMES) assert.equal(getTool(name), null, name);
});
