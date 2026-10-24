#!/usr/bin/env node
/**
 * Isolated native-loader failure probe.
 *
 * Copies the current Windows x64 N-API addon to a private temp directory and
 * changes one PE import name in the COPY only. The real addon, install tree,
 * and packaged files are never modified. The child Node process must report a
 * native load failure instead of executing the addon.
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const native = join(root, "core", "progress_ledger_core.win32-x64-msvc.node");
if (process.platform !== "win32" || process.arch !== "x64") {
  console.log(`native-loader-check SKIP: Windows x64 required (${process.platform}/${process.arch})`);
  process.exit(0);
}
if (!existsSync(native)) throw new Error(`native addon missing: ${native}`);

const temp = mkdtempSync(join(tmpdir(), "progressledger-native-loader-"));
const copy = join(temp, "progress_ledger_core.win32-x64-msvc.node");
const oldName = Buffer.from("VCRUNTIME140.dll", "ascii");
const missingName = Buffer.from("VCRUNTIME14X.dll", "ascii");
try {
  const bytes = readFileSync(native);
  let offset = -1;
  outer: for (let i = 0; i <= bytes.length - oldName.length; i += 1) {
    for (let j = 0; j < oldName.length; j += 1) {
      if (bytes[i + j] !== oldName[j]) continue outer;
    }
    offset = i;
    break;
  }
  if (offset < 0) throw new Error("VCRUNTIME140.dll import was not found");
  missingName.copy(bytes, offset);
  writeFileSync(copy, bytes);

  const probe = spawnSync(process.execPath, ["-e", "try { require(process.argv[1]); process.exit(2) } catch (e) { console.log(String(e?.message ?? e)); process.exit(/VCRUNTIME14X\\.dll|specified module could not be found|module/i.test(String(e?.message ?? e)) ? 0 : 3) }", copy], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.trim();
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(`native-loader-check FAILED (exit ${probe.status}): ${output}`);
  console.log("native-loader-check PASS: isolated missing-DLL load failed safely");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
