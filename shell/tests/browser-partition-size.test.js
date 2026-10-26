import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureDirectory } from "../src/services/browser/partition-size.js";

test("measureDirectory sums nested files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pl-size-"));
  await writeFile(join(root, "a.txt"), "12345");
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "b.bin"), Buffer.alloc(100));
  const res = await measureDirectory(root);
  assert.equal(res.bytes, 105);
  assert.equal(res.files, 2);
  assert.equal(res.complete, true);
});

test("measureDirectory caps at maxFiles and reports incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "pl-size-"));
  await writeFile(join(root, "a.txt"), "1");
  await writeFile(join(root, "b.txt"), "22");
  await writeFile(join(root, "c.txt"), "333");
  const res = await measureDirectory(root, { maxFiles: 2 });
  assert.equal(res.files, 2);
  assert.equal(res.complete, false);
});

test("measureDirectory on a missing dir reports zero without throwing", async () => {
  const res = await measureDirectory(join(tmpdir(), "pl-size-does-not-exist-xyz"));
  assert.equal(res.bytes, 0);
  assert.equal(res.files, 0);
  assert.equal(res.complete, true);
});
