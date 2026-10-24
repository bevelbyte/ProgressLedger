import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveSafeBackupFile } from "../src/services/backup-path-security.js";

test("backup vault canonical containment rejects a symlink escaping the configured folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-vault-security-"));
  const vault = join(root, "vault");
  const outside = join(root, "outside");
  mkdirSync(vault);
  mkdirSync(outside);
  const realBackup = join(outside, "foreign.cfprofile");
  const link = join(vault, "foreign.cfprofile");
  writeFileSync(realBackup, "not-a-real-bundle");

  try {
    // Windows junctions are reparse points but do not require developer-mode
    // symlink privileges, making this a deterministic escape-path fixture.
    symlinkSync(outside, join(vault, "foreign-dir"), "junction");
    const redirected = join(vault, "foreign-dir", "foreign.cfprofile");
    // Keep the source file outside the configured vault and expose it through
    // the junction rather than relying on unprivileged file symlink creation.
    const result = await resolveSafeBackupFile(vault, redirected);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "outside-backup-folder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup vault canonical containment accepts a regular .cfprofile file", async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-vault-security-"));
  const vault = join(root, "vault");
  mkdirSync(vault);
  const backup = join(vault, "owned.cfprofile");
  writeFileSync(backup, "not-a-real-bundle");

  try {
    const result = await resolveSafeBackupFile(vault, backup);
    assert.equal(result.ok, true);
    assert.equal(result.path, backup);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
