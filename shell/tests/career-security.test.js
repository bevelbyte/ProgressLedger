import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ipcSource = readFileSync(new URL("../src/ipc/career.js", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../../core/src/db/career.rs", import.meta.url), "utf8");
const uiServiceSource = readFileSync(new URL("../../ui/src/features/career/services/career.service.js", import.meta.url), "utf8");

test("career primary-goal mutation is profile-scoped at IPC and native boundaries", () => {
  assert.match(ipcSource, /safeHandle\("career:set-primary-goal",\s*\(_e, \{ profileId, id \}\) => core\.setPrimaryCareerGoal\(profileId, id\)\)/);
  assert.match(preloadSource, /setPrimaryGoal: \(profileId, id\) => ipcRenderer\.invoke\("career:set-primary-goal", \{ profileId, id \}\)/);
  assert.match(coreSource, /pub fn set_primary_career_goal\(profile_id: i32, id: i32\)/);
  assert.match(coreSource, /if owner != profile_id/);
  assert.match(coreSource, /codes::NOT_OWNED, "Career goal not found in this profile"/);
  assert.match(uiServiceSource, /setPrimaryGoal\(profileId, id\)/);
});

test("career goal update keeps the profile id in the renderer-to-native tuple", () => {
  assert.match(ipcSource, /safeHandle\("career:update-goal",\s*\(_e, \{ profileId, id,/);
  assert.match(ipcSource, /core\.updateCareerGoal\(profileId, id,/);
});