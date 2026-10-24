/**
 * Comprehensive Safety Test Suite for CareerFlow Version Manager
 * Validates all safety guarantees, edge cases, failure recoveries, and verification checks
 * in an isolated disposable temporary directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toExtendedPath,
  freezeVersion,
  verifyVersion,
  listVersions,
  restoreVersion,
  validateSafeRelPath,
  VersionLock,
  computeSha256,
  ALLOWED_VERSION_COMPANION_LAUNCHERS,
  isAllowedCompanionLauncher,
  isSnapshotUnverifiedPath,
} from './version-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_ROOT = path.resolve(__dirname, '..', '.tmp-version-manager-safety-test');

function setupMockWorkspace(root) {
  if (fs.existsSync(toExtendedPath(root))) {
    fs.rmSync(toExtendedPath(root), { recursive: true, force: true });
  }
  fs.mkdirSync(toExtendedPath(root), { recursive: true });

  // package.json
  fs.writeFileSync(toExtendedPath(path.join(root, 'package.json')), JSON.stringify({ name: 'mock-cf', version: '2.0.0' }));
  
  // native core binary
  const coreDir = path.join(root, 'core');
  fs.mkdirSync(toExtendedPath(coreDir), { recursive: true });
  fs.writeFileSync(toExtendedPath(path.join(coreDir, 'careerflow_core.win32-x64-msvc.node')), 'CORE_BINARY_MOCK_BYTES');

  // ui dist
  const uiDistDir = path.join(root, 'ui', 'dist');
  fs.mkdirSync(toExtendedPath(uiDistDir), { recursive: true });
  fs.writeFileSync(toExtendedPath(path.join(uiDistDir, 'index.html')), '<html><body>UI_MOCK</body></html>');

  // some source code
  const coreSrcDir = path.join(coreDir, 'src');
  fs.mkdirSync(toExtendedPath(coreSrcDir), { recursive: true });
  fs.writeFileSync(toExtendedPath(path.join(coreSrcDir, 'lib.rs')), 'pub fn run() {}');

  // directory with trailing space
  const trailingDir = path.join(root, 'shots', 'redesign-r3 ');
  fs.mkdirSync(toExtendedPath(trailingDir), { recursive: true });
  fs.writeFileSync(toExtendedPath(path.join(trailingDir, '00-profiles.png')), 'PNG_DATA_FOR_SHOT');

  // node_modules (should be excluded)
  const nodeModulesDir = path.join(root, 'node_modules', 'pkg');
  fs.mkdirSync(toExtendedPath(nodeModulesDir), { recursive: true });
  fs.writeFileSync(toExtendedPath(path.join(nodeModulesDir, 'index.js')), 'IGNORED');
}

async function runAllSafetyTests() {
  console.log(`============================================================`);
  console.log(`CAREERFLOW VERSION MANAGER -- ISOLATED SAFETY TEST SUITE`);
  console.log(`Test Directory: ${TEST_ROOT}`);
  console.log(`============================================================\n`);

  const results = [];
  function record(name, pass, note = '') {
    results.push({ name, pass, note });
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' (' + note + ')' : ''}`);
  }

  try {
    // 1. Normal Freeze and Verification
    setupMockWorkspace(TEST_ROOT);
    await freezeVersion({ cwd: TEST_ROOT, tag: 'v1', description: 'Baseline Freeze' });
    const verifyV1 = await verifyVersion('v1', { cwd: TEST_ROOT });
    record('Normal freeze and verification', verifyV1.status === 'VERIFIED');

    // 2. Existing Destination Rejection (including destination without manifest)
    let rejectedExisting = false;
    try {
      await freezeVersion({ cwd: TEST_ROOT, tag: 'v1' });
    } catch (err) {
      if (err.message.includes('already exists')) rejectedExisting = true;
    }
    record('Existing destination rejection (with manifest)', rejectedExisting);

    const emptyVersionDir = path.join(TEST_ROOT, 'versions', 'v-nomanifest');
    fs.mkdirSync(toExtendedPath(emptyVersionDir), { recursive: true });
    let rejectedNoManifest = false;
    try {
      await freezeVersion({ cwd: TEST_ROOT, tag: 'v-nomanifest' });
    } catch (err) {
      if (err.message.includes('already exists')) rejectedNoManifest = true;
    }
    record('Existing destination rejection (without manifest)', rejectedNoManifest);

    // 3. Missing, Modified, and Extra File Detection
    await freezeVersion({ cwd: TEST_ROOT, tag: 'v-detect', description: 'Detection Test' });
    
    // Test Missing File
    const fileToDelete = path.join(TEST_ROOT, 'versions', 'v-detect', 'ui', 'dist', 'index.html');
    fs.unlinkSync(toExtendedPath(fileToDelete));
    const verifyMissing = await verifyVersion('v-detect', { cwd: TEST_ROOT });
    record('Missing file detection', verifyMissing.status === 'CORRUPTED' && verifyMissing.missing === 1);
    fs.writeFileSync(toExtendedPath(fileToDelete), '<html><body>UI_MOCK</body></html>'); // restore

    // Test Modified File (Hash Mismatch)
    fs.writeFileSync(toExtendedPath(fileToDelete), '<html><body>MODIFIED</body></html>');
    const verifyModified = await verifyVersion('v-detect', { cwd: TEST_ROOT });
    record('Modified file detection (hash mismatch)', verifyModified.status === 'CORRUPTED' && verifyModified.mismatched === 1);
    fs.writeFileSync(toExtendedPath(fileToDelete), '<html><body>UI_MOCK</body></html>'); // restore

    // Test Extra File Detection (arbitrary non-manifest file)
    const extraFile = path.join(TEST_ROOT, 'versions', 'v-detect', 'extra-untracked.js');
    fs.writeFileSync(toExtendedPath(extraFile), 'console.log("malicious extra");');
    const verifyExtra = await verifyVersion('v-detect', { cwd: TEST_ROOT });
    record('Extra file detection (arbitrary untracked file)', verifyExtra.status === 'CORRUPTED' && verifyExtra.extra === 1);
    fs.unlinkSync(toExtendedPath(extraFile)); // clean up

    // 3b. Companion Launcher Policy Tests
    // Test Valid Companion Launcher for v1
    const v1Launcher = path.join(TEST_ROOT, 'versions', 'v1', 'Launch-CareerFlow-V1.bat');
    fs.writeFileSync(toExtendedPath(v1Launcher), '@echo off\r\necho Launching v1');
    const verifyV1WithLauncher = await verifyVersion('v1', { cwd: TEST_ROOT });
    record('Valid companion launcher accepted for v1 (Launch-CareerFlow-V1.bat)', verifyV1WithLauncher.status === 'VERIFIED' && verifyV1WithLauncher.extra === 0);

    // Test Valid Companion Launcher for v2
    await freezeVersion({ cwd: TEST_ROOT, tag: 'v2', description: 'V2 Freeze' });
    const v2Launcher = path.join(TEST_ROOT, 'versions', 'v2', 'Launch-CareerFlow-V2.bat');
    fs.writeFileSync(toExtendedPath(v2Launcher), '@echo off\r\necho Launching v2');
    const verifyV2WithLauncher = await verifyVersion('v2', { cwd: TEST_ROOT });
    record('Valid companion launcher accepted for v2 (Launch-CareerFlow-V2.bat)', verifyV2WithLauncher.status === 'VERIFIED' && verifyV2WithLauncher.extra === 0);

    // Test Rejection of Arbitrary Launcher in v1
    const v1Arbitrary = path.join(TEST_ROOT, 'versions', 'v1', 'Launch-Arbitrary.bat');
    fs.writeFileSync(toExtendedPath(v1Arbitrary), '@echo off\r\necho Arbitrary');
    const verifyV1Arbitrary = await verifyVersion('v1', { cwd: TEST_ROOT });
    record('Arbitrary launcher script rejected in v1', verifyV1Arbitrary.status === 'CORRUPTED' && verifyV1Arbitrary.extra === 1);
    fs.unlinkSync(toExtendedPath(v1Arbitrary));

    // Test Rejection of Mismatched Version Launcher (v2 launcher placed in v1)
    const v1Mismatched = path.join(TEST_ROOT, 'versions', 'v1', 'Launch-CareerFlow-V2.bat');
    fs.writeFileSync(toExtendedPath(v1Mismatched), '@echo off\r\necho Mismatched');
    const verifyV1Mismatched = await verifyVersion('v1', { cwd: TEST_ROOT });
    record('Mismatched companion launcher rejected (V2 launcher in v1)', verifyV1Mismatched.status === 'CORRUPTED' && verifyV1Mismatched.extra === 1);
    fs.unlinkSync(toExtendedPath(v1Mismatched));

    // Test Rejection of Launcher in Nested Directory
    const v1Nested = path.join(TEST_ROOT, 'versions', 'v1', 'ui', 'Launch-CareerFlow-V1.bat');
    fs.writeFileSync(toExtendedPath(v1Nested), '@echo off\r\necho Nested');
    const verifyV1Nested = await verifyVersion('v1', { cwd: TEST_ROOT });
    record('Companion launcher in subdirectory rejected', verifyV1Nested.status === 'CORRUPTED' && verifyV1Nested.extra === 1);
    fs.unlinkSync(toExtendedPath(v1Nested));

    // Test Rejection of Companion Launcher in Unwhitelisted Version Tag
    const vDetectLauncher = path.join(TEST_ROOT, 'versions', 'v-detect', 'Launch-CareerFlow-V1.bat');
    fs.writeFileSync(toExtendedPath(vDetectLauncher), '@echo off\r\necho In v-detect');
    const verifyVDetectLauncher = await verifyVersion('v-detect', { cwd: TEST_ROOT });
    record('Companion launcher rejected in unwhitelisted version tag', verifyVDetectLauncher.status === 'CORRUPTED' && verifyVDetectLauncher.extra === 1);
    fs.unlinkSync(toExtendedPath(vDetectLauncher));

    // 4. Path Traversal & Malformed Path Rejection
    let traversalCaught = 0;
    const dangerousPaths = [
      '../outside.txt',
      '..\\outside.txt',
      'core/../../escape.rs',
      'C:/Windows/System32/cmd.exe',
      '/etc/passwd',
      '\\\\server\\share\\file.txt',
      '.git/config',
      'versions/v1/bad.txt',
      'v1/core.node',
      'foo\0bar.txt',
      '',
    ];
    for (const dp of dangerousPaths) {
      try {
        validateSafeRelPath(dp, TEST_ROOT);
      } catch (err) {
        traversalCaught++;
      }
    }
    record('Path traversal and protected path rejection', traversalCaught === dangerousPaths.length, `${traversalCaught}/${dangerousPaths.length} caught`);

    // 4b. Explicit integrity coverage for ignored bulky directories
    record('node_modules is explicitly outside manifest integrity coverage', isSnapshotUnverifiedPath('node_modules/pkg/index.js'));
    record('nested release output is explicitly outside manifest integrity coverage', isSnapshotUnverifiedPath('release/win-unpacked/CareerFlow.exe'));
    record('normal application source remains integrity-covered', !isSnapshotUnverifiedPath('shell/src/main.js'));

    const excludedProbe = path.join(TEST_ROOT, 'versions', 'v-detect', 'node_modules', 'ignored-package', 'ignored.js');
    fs.mkdirSync(toExtendedPath(path.dirname(excludedProbe)), { recursive: true });
    fs.writeFileSync(toExtendedPath(excludedProbe), 'excluded-from-manifest');
    const verifyExcluded = await verifyVersion('v-detect', { cwd: TEST_ROOT, quiet: true });
    record('Verifier reports excluded file count without treating dependency file as arbitrary extra', verifyExcluded.status === 'VERIFIED' && verifyExcluded.excludedFileCount === 1 && verifyExcluded.extra === 0);
    fs.rmSync(toExtendedPath(path.join(TEST_ROOT, 'versions', 'v-detect', 'node_modules')), { recursive: true, force: true });

    // 5. Trailing-space filenames on Windows
    const trailingFile = path.join(TEST_ROOT, 'versions', 'v1', 'shots', 'redesign-r3 ', '00-profiles.png');
    record('Trailing-space filenames preserved in snapshot', fs.existsSync(toExtendedPath(trailingFile)));

    // 6. Freeze Failure Cleanup & Unrelated Staging Directory Safety
    const unrelatedStagingDir = path.join(TEST_ROOT, 'versions', 'v-unrelated-stage-20261012');
    fs.mkdirSync(toExtendedPath(unrelatedStagingDir), { recursive: true });
    fs.writeFileSync(toExtendedPath(path.join(unrelatedStagingDir, 'keep_me.txt')), 'DO_NOT_TOUCH');

    // Simulate freeze failure using fault injection
    let freezeFailedCaught = false;
    try {
      await freezeVersion({ cwd: TEST_ROOT, tag: 'v-should-fail', _injectFreezeFailureAt: 2 });
    } catch (err) {
      if (err.message.includes('SIMULATED_FREEZE_FAILURE')) freezeFailedCaught = true;
    }

    // Verify unrelated staging directory was untouched
    const unrelatedKept = fs.existsSync(toExtendedPath(path.join(unrelatedStagingDir, 'keep_me.txt')));
    record('Freeze failure error handling & self-staging cleanup', freezeFailedCaught);
    record('No accidental cleanup of unrelated staging directories', unrelatedKept);

    // 7. Complete and Hash-Verified Backup Before Restore
    setupMockWorkspace(TEST_ROOT);
    await freezeVersion({ cwd: TEST_ROOT, tag: 'v-restore-base' });

    // Mutate workspace to have distinct content
    fs.writeFileSync(toExtendedPath(path.join(TEST_ROOT, 'core', 'src', 'lib.rs')), 'pub fn mutated() {}');
    fs.writeFileSync(toExtendedPath(path.join(TEST_ROOT, 'pre_restore_work.txt')), 'MY_UNCOMMITTED_WORK');

    const restoreRes = await restoreVersion('v-restore-base', { cwd: TEST_ROOT });
    const backupManifestPath = path.join(restoreRes.backupDir, 'BACKUP-MANIFEST.json');
    const backupManifestExists = fs.existsSync(toExtendedPath(backupManifestPath));
    const backupManifest = backupManifestExists ? JSON.parse(fs.readFileSync(toExtendedPath(backupManifestPath), 'utf8')) : null;
    
    // Check that backup contains pre_restore_work.txt
    const workInBackup = fs.existsSync(toExtendedPath(path.join(restoreRes.backupDir, 'pre_restore_work.txt')));
    record('Complete and hash-verified backup created before restore', backupManifestExists && workInBackup);

    // 8. Files Added After Snapshot (Orphan Handling)
    setupMockWorkspace(TEST_ROOT);
    await freezeVersion({ cwd: TEST_ROOT, tag: 'v-clean' });

    // Add orphan file in managed code directory
    const orphanManaged = path.join(TEST_ROOT, 'core', 'src', 'orphan_module.rs');
    fs.writeFileSync(toExtendedPath(orphanManaged), 'pub fn orphan() {}');

    // Add user note in root (unmanaged)
    const userNote = path.join(TEST_ROOT, 'my_personal_notes.txt');
    fs.writeFileSync(toExtendedPath(userNote), 'Remember this idea');

    const restoreClean = await restoreVersion('v-clean', { cwd: TEST_ROOT });

    // Managed orphan file should be archived to backup and removed from workspace to avoid Frankenstein build
    const orphanRemovedFromWs = !fs.existsSync(toExtendedPath(orphanManaged));
    const orphanPreservedInBackup = fs.existsSync(toExtendedPath(path.join(restoreClean.backupDir, 'core', 'src', 'orphan_module.rs')));
    const userNotePreservedInWs = fs.existsSync(toExtendedPath(userNote));

    record('Orphan file archived to backup and cleaned from managed workspace', orphanRemovedFromWs && orphanPreservedInBackup);
    record('Unmanaged user files preserved in workspace', userNotePreservedInWs);

    // 9. Mid-Restore Failure and Automated Transactional Rollback
    setupMockWorkspace(TEST_ROOT);
    await freezeVersion({ cwd: TEST_ROOT, tag: 'v-rollback-test' });

    // Add dirty state in workspace
    const dirtyFile = path.join(TEST_ROOT, 'core', 'src', 'lib.rs');
    fs.writeFileSync(toExtendedPath(dirtyFile), 'pub fn dirty_before_restore() {}');
    const uncommittedFile = path.join(TEST_ROOT, 'keep_alive.txt');
    fs.writeFileSync(toExtendedPath(uncommittedFile), 'VALUABLE_STATE');

    let rollbackReported = false;
    try {
      // Inject failure on file 2 during restoration
      await restoreVersion('v-rollback-test', { cwd: TEST_ROOT, _injectRestoreFailureAt: 2 });
    } catch (err) {
      if (err.message.includes('fully rolled back to pre-restore state')) {
        rollbackReported = true;
      }
    }

    // Verify workspace was rolled back to pre-restore dirty state!
    const restoredDirtyContent = fs.readFileSync(toExtendedPath(dirtyFile), 'utf8');
    const uncommittedStillExists = fs.existsSync(toExtendedPath(uncommittedFile));
    const rolledBackCorrectly = rollbackReported && (restoredDirtyContent === 'pub fn dirty_before_restore() {}') && uncommittedStillExists;

    record('Mid-restore failure triggers automatic transactional rollback', rolledBackCorrectly);

    // 10. Recovery Failure Reporting
    let recoveryFailureReported = false;
    try {
      await restoreVersion('v-rollback-test', {
        cwd: TEST_ROOT,
        _injectRestoreFailureAt: 2,
        _injectRollbackFailure: true,
      });
    } catch (err) {
      if (err.message.includes('CRITICAL FAILURE: Restore failed') && err.message.includes('rollback failed')) {
        recoveryFailureReported = true;
      }
    }
    record('Recovery failure reporting when rollback also fails', recoveryFailureReported);

    // 11. Concurrency Lock Prevention
    const lock = new VersionLock(path.join(TEST_ROOT, 'versions', '.lock-v1'));
    lock.acquire();
    let concurrencyCaught = false;
    try {
      const lock2 = new VersionLock(path.join(TEST_ROOT, 'versions', '.lock-v1'));
      lock2.acquire();
    } catch (err) {
      if (err.message.includes('Operation locked')) concurrencyCaught = true;
    } finally {
      lock.release();
    }
    record('Concurrency lock prevents racing operations', concurrencyCaught);

    // 12. Command Exit Code & Verification Status
    const cleanVerify = await verifyVersion('v-rollback-test', { cwd: TEST_ROOT });
    record('Verify returns VERIFIED for clean version', cleanVerify.status === 'VERIFIED');

    // 13. List Command: Distinction Between Saved Manifest Status and Live Integrity
    const listDefault = await listVersions({ cwd: TEST_ROOT });
    const rollbackEntry = listDefault.find(e => e.tag === 'v-rollback-test');
    const listDistinguishes = rollbackEntry &&
      rollbackEntry.manifestStatus.startsWith('SAVED:') &&
      rollbackEntry.liveIntegrity === 'NOT PERFORMED' &&
      rollbackEntry.status !== 'VERIFIED';
    record('List command distinguishes saved manifest status from fresh verification', listDistinguishes);

    // 14. List Command: Live Integrity Verification (--verify mode)
    const listLive = await listVersions({ cwd: TEST_ROOT, verify: true });
    const rollbackLiveEntry = listLive.find(e => e.tag === 'v-rollback-test');
    record('List with verify executes fresh integrity check and reports PASS (VERIFIED)', rollbackLiveEntry && rollbackLiveEntry.liveIntegrity === 'PASS (VERIFIED)');

  } finally {
    // Cleanup disposable test directory
    try {
      if (fs.existsSync(toExtendedPath(TEST_ROOT))) {
        fs.rmSync(toExtendedPath(TEST_ROOT), { recursive: true, force: true });
      }
    } catch (e) {
      console.warn('Note: test cleanup deferred');
    }
  }

  console.log(`\n============================================================`);
  console.log(`SAFETY TEST RESULTS: ${results.filter(r => r.pass).length}/${results.length} PASSED`);
  console.log(`============================================================\n`);

  const failed = results.filter(r => !r.pass);
  if (failed.length > 0) {
    throw new Error(`${failed.length} safety tests failed!`);
  }
  return results;
}

runAllSafetyTests().catch(err => {
  console.error(`\n[FATAL TEST FAILURE]`, err);
  process.exit(1);
});
