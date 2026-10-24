// Academic profile scope must be propagated across the shell/UI bridge.
// The Rust integration suite proves the SQL behavior; this contract test
// ensures IPC/preload/UI callers cannot silently drop that profile context.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("academic read IPC forwards profileId to scoped core reads", () => {
  const expectations = [
    ["../src/ipc/mistakes.js", /core\.getMistakes\(profileId, subjectId, mistakeType, limit\)/],
    ["../src/ipc/formulas.js", /core\.getFormulas\(profileId, subjectId \?\? null, category \?\? null\)/],
    ["../src/ipc/labs.js", /core\.getExperiments\(profileId, subjectId\)/],
    ["../src/ipc/links.js", /core\.getSubjectLinks\(profileId, subjectId\)/],
  ];
  for (const [file, pattern] of expectations) assert.match(read(file), pattern, file);
});

test("academic preload and UI services require profile context for reads", () => {
  const preload = read("../src/preload.cjs");
  assert.match(preload, /mistakes:list[\s\S]*profileId[\s\S]*subjectId/);
  assert.match(preload, /formulas:list[\s\S]*profileId[\s\S]*subjectId/);
  assert.match(preload, /labs:list[\s\S]*profileId[\s\S]*subjectId/);
  assert.match(preload, /links:list[\s\S]*profileId[\s\S]*subjectId/);

  assert.match(read("../../ui/src/features/mistakes/services/mistakes.service.js"), /list\(profileId, filters\)/);
  assert.match(read("../../ui/src/features/formula-board/services/formula.service.js"), /list\(profileId, subjectId, category\)/);
  assert.match(read("../../ui/src/features/labs/services/labs.service.js"), /list\(profileId, subjectId\)/);
  assert.match(read("../../ui/src/features/subject-links/services/subject-links.service.js"), /list\(profileId, subjectId\)/);
});
