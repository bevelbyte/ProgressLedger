import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initLogger, writeLog } from "../src/services/logger.js";

test("diagnostic logger redacts credential-shaped values and secret keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "careerflow-logger-security-"));
  const file = join(dir, "careerflow.log");
  try {
    initLogger(file);
    await writeLog("info", "provider configured sk-abcdefghijklmnopqrstuvwxyz", {
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
      authorization: "Bearer super-secret-token",
      nested: { password: "hunter2", text: "https://example.test/?token=private-token" },
    });
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(text, /super-secret-token/);
    assert.doesNotMatch(text, /hunter2/);
    assert.doesNotMatch(text, /private-token/);
    assert.match(text, /<redacted>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
