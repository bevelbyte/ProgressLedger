/**
 * CareerFlow Safe Version Management Tool
 * 
 * Provides deterministic, non-destructive freeze, verify, list, and restore
 * operations for CareerFlow versions.
 * 
 * Usage:
 *   node scripts/version-manager.mjs freeze [tag] [--desc "description"]
 *   node scripts/version-manager.mjs verify <tag>
 *   node scripts/version-manager.mjs list
 *   node scripts/version-manager.mjs restore <tag> [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Helper to convert to Windows Extended-Length Path (\\?\) to safely handle
// long paths and paths with trailing whitespace.
export function toExtendedPath(p) {
  const abs = path.resolve(p);
  if (process.platform === 'win32' && !abs.startsWith('\\\\?\\')) {
    return '\\\\?\\' + abs;
  }
  return abs;
}

export function fromExtendedPath(p) {
  if (typeof p !== 'string') return p;
  return p.replace(/^\\\\\?\\/, '');
}

// Deterministic exclusion rules
export const EXCLUSION_PATTERNS = [
  // Root / global repository structures
  /^\.git(\/|\\|$)/,
  /^versions(\/|\\|$)/,
  /^v1(\/|\\|$)/,               // Legacy protected release root
  /^target(\/|\\|$)/,           // Top-level build target
  /^core[\\\/]target(\/|\\|$)/, // Rust Cargo target cache (26k+ files)
  /^release(\/|\\|$)/,          // Electron-builder distribution outputs
  /^test-results(\/|\\|$)/,     // Playwright transient results
  /^core[\\\/]test-results(\/|\\|$)/,
  /^shell[\\\/]test-results(\/|\\|$)/,
  
  // Any node_modules anywhere in the tree
  /(^|[\\\/])node_modules([\\\/]|$)/,
  
  // Transient caches
  /(^|[\\\/])\.vite([\\\/]|$)/,
  /(^|[\\\/])\.cache([\\\/]|$)/,
  
  // OS-specific artifacts
  /\.DS_Store$/i,
  /Thumbs\.db$/i,
];

// These runtime/build/dependency trees are intentionally not hash-covered by
// snapshot manifests. Keep them visible in verification output so a passing
// manifest is never mistaken for full physical-tree integrity.
export const SNAPSHOT_UNVERIFIED_DIRECTORY_NAMES = Object.freeze([
  'node_modules', 'release', 'target', 'test-results', '.cache', '.vite',
]);

export function isSnapshotUnverifiedPath(relPath) {
  const segments = relPath.replace(/\\/g, '/').split('/');
  return segments.some(segment => SNAPSHOT_UNVERIFIED_DIRECTORY_NAMES.includes(segment));
}

// Managed project paths where orphan files should be archived to prevent Frankenstein workspaces
export const MANAGED_PROJECT_PREFIXES = [
  'core/src/', 'core/migrations/', 'shell/src/', 'shell/tests/',
  'ui/src/', 'ui/tests/', 'e2e/', 'scripts/', 'docs/', 'project-intel/',
  'shots/', 'logs/', '.agents/', '.github/', '.unlazy/', '.ua/'
];

/**
 * Narrowly scoped policy for known version companion launchers.
 *
 * POLICY:
 * Versions v1 and v2 contain post-freeze companion batch launchers
 * ('Launch-CareerFlow-V1.bat' and 'Launch-CareerFlow-V2.bat') created to allow
 * standalone execution of historical releases without mutating the active workspace.
 *
 * Because frozen releases are immutable and their cryptographic manifests were generated
 * prior to the addition of these companion scripts, these two specific files are whitelisted
 * strictly for their corresponding version tags.
 *
 * SECURITY & INTEGRITY CONSTRAINTS:
 * 1. Arbitrary launcher scripts, wildcards (*.bat), or unknown batch files are STRICTLY PROHIBITED.
 * 2. Launchers are strictly bound to their respective version tags (e.g., V1 launcher in v2 is rejected).
 * 3. The launcher must reside directly at the root of the version snapshot, not in subdirectories.
 */
export const ALLOWED_VERSION_COMPANION_LAUNCHERS = Object.freeze({
  v1: Object.freeze(['Launch-CareerFlow-V1.bat']),
  v2: Object.freeze(['Launch-CareerFlow-V2.bat']),
});

/**
 * Checks whether a file path qualifies as an authorized companion launcher for the given version.
 *
 * @param {string} versionTag - Version identifier (e.g. 'v1', 'v2')
 * @param {string} relPath - Relative file path within the version directory
 * @param {object} [options] - Optional overrides (for testing)
 * @returns {boolean}
 */
export function isAllowedCompanionLauncher(versionTag, relPath, options = {}) {
  const norm = relPath.replace(/\\/g, '/');
  if (options.allowedCompanionLaunchers && Array.isArray(options.allowedCompanionLaunchers)) {
    return options.allowedCompanionLaunchers.includes(norm);
  }
  const allowed = ALLOWED_VERSION_COMPANION_LAUNCHERS[versionTag];
  if (!allowed) {
    return false;
  }
  return allowed.includes(norm);
}

export function isPathExcluded(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  for (const pattern of EXCLUSION_PATTERNS) {
    if (pattern.test(norm)) return true;
  }
  return false;
}

export function computeSha256(filePath) {
  const extPath = toExtendedPath(filePath);
  const data = fs.readFileSync(extPath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Validates a manifest relative path against directory traversal, absolute paths,
 * null bytes, and access to protected root structures.
 */
export function validateSafeRelPath(relPath, baseDir) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error(`Invalid manifest entry: path is empty or not a string`);
  }
  if (relPath.includes('\0')) {
    throw new Error(`Invalid manifest entry: path contains null byte: ${relPath}`);
  }
  // Disallow absolute paths, Windows drive letters, and UNC paths
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new Error(`Invalid manifest entry: absolute or UNC path rejected: ${relPath}`);
  }
  
  const normalized = path.normalize(relPath);
  const resolved = path.resolve(baseDir, normalized);
  const relFromBase = path.relative(path.resolve(baseDir), resolved);
  
  // Must not escape baseDir
  if (relFromBase.startsWith('..') || path.isAbsolute(relFromBase) || relFromBase === '') {
    throw new Error(`Path traversal rejected: ${relPath} escapes destination root`);
  }
  
  // Disallow targeting protected directories
  const normRel = relFromBase.replace(/\\/g, '/');
  if (normRel === '.git' || normRel.startsWith('.git/')) {
    throw new Error(`Access to protected directory rejected: ${relPath}`);
  }
  if (normRel === 'versions' || normRel.startsWith('versions/')) {
    throw new Error(`Access to nested versions store rejected: ${relPath}`);
  }
  if (normRel === 'v1' || normRel.startsWith('v1/')) {
    throw new Error(`Access to protected root v1 rejected: ${relPath}`);
  }

  return relFromBase;
}

/**
 * File-based lock mechanism to prevent concurrent freeze or restore operations.
 */
export class VersionLock {
  constructor(lockPath) {
    this.lockPath = toExtendedPath(lockPath);
    this.acquired = false;
  }

  acquire() {
    const lockDir = path.dirname(this.lockPath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
    try {
      const fd = fs.openSync(this.lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
      fs.closeSync(fd);
      this.acquired = true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Check if existing lock is stale
        try {
          const lockContent = fs.readFileSync(this.lockPath, 'utf8');
          const lockData = JSON.parse(lockContent);
          let isRunning = false;
          if (lockData.pid) {
            try {
              process.kill(lockData.pid, 0);
              isRunning = true;
            } catch {
              isRunning = false;
            }
          }
          if (!isRunning) {
            // Stale lock: clean up and re-acquire
            fs.unlinkSync(this.lockPath);
            const fd = fs.openSync(this.lockPath, 'wx');
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
            fs.closeSync(fd);
            this.acquired = true;
            return;
          }
        } catch {}
        throw new Error(`Operation locked: another version-manager operation is active (lock file: ${fromExtendedPath(this.lockPath)})`);
      }
      throw err;
    }
  }

  release() {
    if (this.acquired && fs.existsSync(this.lockPath)) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {}
      this.acquired = false;
    }
  }
}

export function walkDirectory(dir, baseDir = dir, filterExcluded = true) {
  const results = [];
  const extDir = toExtendedPath(dir);
  
  let entries;
  try {
    entries = fs.readdirSync(extDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Failed to read directory ${dir}: ${err.message}`);
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (filterExcluded && isPathExcluded(relPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...walkDirectory(fullPath, baseDir, filterExcluded));
    } else if (entry.isFile()) {
      results.push({
        fullPath,
        relPath,
        name: entry.name,
      });
    }
  }

  return results;
}

export function safeCopyFile(src, dest) {
  const extDest = toExtendedPath(dest);
  const extSrc = toExtendedPath(src);
  const destDir = path.dirname(extDest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(extSrc, extDest);
}

export function getGitInfo(cwd = ROOT_DIR) {
  try {
    const head = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let branch = 'unknown';
    try {
      branch = execSync('git branch --show-current', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {}
    return { head, branch };
  } catch {
    return { head: 'unknown', branch: 'unknown' };
  }
}

export function getNextVersionTag(versionsDir) {
  const extVersionsDir = toExtendedPath(versionsDir);
  if (!fs.existsSync(extVersionsDir)) {
    return 'v2';
  }
  const entries = fs.readdirSync(extVersionsDir, { withFileTypes: true });
  let maxNum = 1;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const match = entry.name.match(/^v(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }
  return `v${maxNum + 1}`;
}

/**
 * Freeze command: snapshot the active working copy into a verified version folder.
 */
export async function freezeVersion(options = {}) {
  const cwd = options.cwd || ROOT_DIR;
  const versionsDir = path.join(cwd, 'versions');
  let tag = options.tag;
  const description = options.description || 'CareerFlow Daily-Use Frozen Baseline';

  if (!tag) {
    tag = getNextVersionTag(versionsDir);
  }

  console.log(`\n============================================================`);
  console.log(`CAREERFLOW FREEZE: Version ${tag}`);
  console.log(`============================================================`);
  console.log(`Source workspace: ${cwd}`);
  console.log(`Target version:   ${tag}`);
  console.log(`Description:      ${description}`);

  const targetVersionDir = path.join(versionsDir, tag);
  if (fs.existsSync(toExtendedPath(targetVersionDir))) {
    throw new Error(`Target version '${tag}' already exists at ${targetVersionDir}. Frozen releases are immutable!`);
  }

  const lock = new VersionLock(path.join(versionsDir, `.lock-${tag}`));
  lock.acquire();

  let stagingDir = null;
  let promoted = false;

  try {
    // Pre-flight checks
    console.log(`\n[1/6] Running pre-freeze validations...`);
    const coreNodePath = path.join(cwd, 'core', 'careerflow_core.win32-x64-msvc.node');
    const uiDistPath = path.join(cwd, 'ui', 'dist', 'index.html');
    const packageJsonPath = path.join(cwd, 'package.json');

    if (!fs.existsSync(toExtendedPath(packageJsonPath))) {
      throw new Error(`Missing root package.json in ${cwd}`);
    }

    const hasCoreNode = fs.existsSync(toExtendedPath(coreNodePath));
    const hasUiDist = fs.existsSync(toExtendedPath(uiDistPath));

    if (!hasCoreNode) {
      console.warn(`  [WARN] Native core binary missing: ${coreNodePath}`);
    } else {
      console.log(`  [OK] Native core binary present (${(fs.statSync(toExtendedPath(coreNodePath)).size / (1024 * 1024)).toFixed(2)} MB)`);
    }

    if (!hasUiDist) {
      console.warn(`  [WARN] Pre-built UI bundle missing: ${uiDistPath}`);
    } else {
      console.log(`  [OK] Pre-built UI bundle present`);
    }

    // Staging folder for atomic creation
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    stagingDir = path.join(versionsDir, `${tag}-stage-${timestamp}`);
    console.log(`\n[2/6] Initializing atomic staging directory:\n      ${stagingDir}`);
    fs.mkdirSync(toExtendedPath(stagingDir), { recursive: true });

    const gitInfo = getGitInfo(cwd);
    console.log(`  Git Commit: ${gitInfo.head}`);
    console.log(`  Git Branch: ${gitInfo.branch}`);

    // Walk files
    console.log(`\n[3/6] Scanning workspace and gathering included files...`);
    const filesToCopy = walkDirectory(cwd, cwd, true);
    console.log(`  Found ${filesToCopy.length} files to snapshot (excluding node_modules, target, etc.)`);

    // Copy and hash
    console.log(`\n[4/6] Copying files to staging and computing SHA-256 hashes...`);
    const manifestFiles = [];
    let totalBytes = 0;
    let copiedCount = 0;

    for (const item of filesToCopy) {
      if (options._injectFreezeFailureAt && copiedCount >= options._injectFreezeFailureAt) {
        throw new Error('SIMULATED_FREEZE_FAILURE');
      }
      const destPath = path.join(stagingDir, item.relPath);
      safeCopyFile(item.fullPath, destPath);
      const hash = computeSha256(destPath);
      const stat = fs.statSync(toExtendedPath(destPath));

      manifestFiles.push({
        path: item.relPath,
        bytes: stat.size,
        sha256: hash,
      });
      totalBytes += stat.size;
      copiedCount++;

      if (copiedCount % 200 === 0 || copiedCount === filesToCopy.length) {
        process.stdout.write(`  Copied & hashed ${copiedCount}/${filesToCopy.length} files...\r`);
      }
    }
    console.log(`\n  Completed copy of ${copiedCount} files (${(totalBytes / (1024 * 1024)).toFixed(2)} MB).`);

    // Sort manifest files by path for deterministic output
    manifestFiles.sort((a, b) => a.path.localeCompare(b.path));

    // Write manifest
    console.log(`\n[5/6] Generating VERSION-MANIFEST.json & VERSION-SUMMARY.md...`);
    const manifestData = {
      version: tag,
      status: 'VERIFIED',
      createdAt: new Date().toISOString(),
      gitCommit: gitInfo.head,
      gitBranch: gitInfo.branch,
      description,
      fileCount: manifestFiles.length,
      totalBytes,
      exclusionRules: [
        'node_modules (all depths)',
        '.git',
        'versions',
        'v1 (root historical release)',
        'core/target and root target (Rust compiler build caches)',
        'release (electron-builder outputs)',
        'test-results (Playwright transient artifacts)',
        'OS temporary files (.DS_Store, Thumbs.db)',
      ],
      files: manifestFiles,
    };

    const manifestPath = path.join(stagingDir, 'VERSION-MANIFEST.json');
    fs.writeFileSync(toExtendedPath(manifestPath), JSON.stringify(manifestData, null, 2), 'utf8');

    // Generate VERSION-SUMMARY.md
    const summaryContent = `# CareerFlow Release ${tag}

- **Version:** ${tag}
- **Status:** VERIFIED / FROZEN
- **Created At:** ${manifestData.createdAt}
- **Git Commit:** \`${gitInfo.head}\`
- **Git Branch:** \`${gitInfo.branch}\`
- **File Count:** ${manifestFiles.length.toLocaleString()} files
- **Total Size:** ${(totalBytes / (1024 * 1024)).toFixed(2)} MB
- **Description:** ${description}

---

## Snapshot Verification

This snapshot has been cryptographically verified with SHA-256 hashes for all ${manifestFiles.length.toLocaleString()} files recorded in \`VERSION-MANIFEST.json\`.

To independently verify the integrity of this version at any time:

\`\`\`cmd
node scripts/version-manager.mjs verify ${tag}
\`\`\`

or double-click \`verify-version.bat\` and enter \`${tag}\`.

---

## How to Run This Version

1. To restore this version into the working copy safely:
   \`\`\`cmd
   node scripts/version-manager.mjs restore ${tag}
   \`\`\`
   *(A safety backup of your active workspace is automatically created and verified before any files are modified.)*

2. Install dependencies if necessary:
   \`\`\`cmd
   npm install
   \`\`\`

3. Launch the desktop application:
   \`\`\`cmd
   npm start
   \`\`\`

4. Run verification tests:
   \`\`\`cmd
   npm test
   npx playwright test e2e/daily-use-acceptance.spec.js
   \`\`\`

---

## Contents Summary

- **Core Native Addon:** \`core/careerflow_core.win32-x64-msvc.node\` (Included & Verified)
- **UI Distribution:** \`ui/dist/**\` (Included & Verified)
- **Rust Core Sources:** \`core/src/**\`, \`core/migrations/**\`, \`core/Cargo.toml\`
- **Electron Shell:** \`shell/src/**\`, \`shell/tests/**\`
- **Svelte 5 UI:** \`ui/src/**\`, \`ui/tests/**\`
- **End-to-End Suite:** \`e2e/**\`
- **Verification Gates & Reports:** Tasks 0 through 10.1 documentation & evidence
`;

    const summaryPath = path.join(stagingDir, 'VERSION-SUMMARY.md');
    fs.writeFileSync(toExtendedPath(summaryPath), summaryContent, 'utf8');

    // Verify staging integrity
    console.log(`\n[6/6] Verifying staging integrity (100% hash check)...`);
    for (const entry of manifestFiles) {
      const checkFile = path.join(stagingDir, entry.path);
      const hash = computeSha256(checkFile);
      if (hash.toLowerCase() !== entry.sha256.toLowerCase()) {
        throw new Error(`Staging hash mismatch for ${entry.path}: expected ${entry.sha256}, got ${hash}`);
      }
    }
    console.log(`  All ${manifestFiles.length} files passed cryptographic hash verification!`);

    // Atomic promote staging to target version directory
    console.log(`\nPromoting staging to permanent frozen release: ${targetVersionDir}`);
    fs.renameSync(toExtendedPath(stagingDir), toExtendedPath(targetVersionDir));
    promoted = true;

    console.log(`\n============================================================`);
    console.log(`SUCCESS: Version ${tag} is FROZEN and VERIFIED!`);
    console.log(`Location:   ${targetVersionDir}`);
    console.log(`Files:      ${manifestFiles.length.toLocaleString()}`);
    console.log(`Size:       ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Manifest:   VERSION-MANIFEST.json`);
    console.log(`Summary:    VERSION-SUMMARY.md`);
    console.log(`============================================================\n`);

    return {
      version: tag,
      path: targetVersionDir,
      fileCount: manifestFiles.length,
      totalBytes,
    };
  } catch (err) {
    // If freeze failed before promotion, clean up ONLY this staging directory
    if (stagingDir && !promoted && fs.existsSync(toExtendedPath(stagingDir))) {
      try {
        console.warn(`\n[CLEANUP] Cleaning up interrupted staging directory:\n          ${stagingDir}`);
        fs.rmSync(toExtendedPath(stagingDir), { recursive: true, force: true });
      } catch (cleanErr) {
        console.error(`[WARN] Failed to clean up staging directory: ${cleanErr.message}`);
      }
    }
    throw err;
  } finally {
    lock.release();
  }
}

/**
 * Verify manifest hashes and detect extra files outside explicitly excluded
 * runtime/build/dependency trees. Excluded files are reported separately and
 * are not implied to be cryptographically verified.
 */
export async function verifyVersion(tag, options = {}) {
  const cwd = options.cwd || ROOT_DIR;
  const versionsDir = path.join(cwd, 'versions');
  const targetDir = path.join(versionsDir, tag);
  const quiet = !!options.quiet;

  if (!quiet) {
    console.log(`\n============================================================`);
    console.log(`CAREERFLOW VERIFY: Version ${tag}`);
    console.log(`============================================================`);
    console.log(`Checking path: ${targetDir}`);
  }

  if (!fs.existsSync(toExtendedPath(targetDir))) {
    throw new Error(`Version '${tag}' does not exist at ${targetDir}`);
  }

  const manifestPath = path.join(targetDir, 'VERSION-MANIFEST.json');
  if (!fs.existsSync(toExtendedPath(manifestPath))) {
    if (!quiet) console.error(`\n[FAILED] VERSION-MANIFEST.json is missing in ${targetDir}`);
    return { status: 'UNVERIFIED', error: 'Missing manifest' };
  }

  let manifest;
  try {
    const raw = fs.readFileSync(toExtendedPath(manifestPath), 'utf8').replace(/^\uFEFF/, '').trim();
    manifest = JSON.parse(raw);
  } catch (err) {
    if (!quiet) console.error(`\n[FAILED] Malformed VERSION-MANIFEST.json: ${err.message}`);
    return { status: 'CORRUPTED', error: err.message };
  }

  if (!quiet) {
    console.log(`Manifest metadata:`);
    console.log(`  Created:     ${manifest.createdAt}`);
    console.log(`  Git Commit:  ${manifest.gitCommit || 'N/A'}`);
    console.log(`  Description: ${manifest.description || 'N/A'}`);
    console.log(`  Files:       ${manifest.fileCount}`);
    console.log(`  Total Bytes: ${(manifest.totalBytes / (1024 * 1024)).toFixed(2)} MB`);
  }

  let matched = 0;
  let missing = 0;
  let mismatched = 0;
  let extra = 0;
  let excludedFileCount = 0;
  const excludedDirectoryCounts = new Map();
  const errors = [];

  const manifestFilesMap = new Map();
  for (const entry of manifest.files) {
    let safeRel;
    try {
      safeRel = validateSafeRelPath(entry.path, targetDir);
    } catch (err) {
      errors.push(`MALFORMED_ENTRY: ${entry.path} (${err.message})`);
      continue;
    }
    const norm = safeRel.replace(/\\/g, '/');
    manifestFilesMap.set(norm, entry);
  }

  // 1. Check all manifest files exist on disk and hashes match
  for (const [normPath, entry] of manifestFilesMap.entries()) {
    const filePath = path.join(targetDir, entry.path);
    const extFilePath = toExtendedPath(filePath);

    if (!fs.existsSync(extFilePath)) {
      missing++;
      errors.push(`MISSING: ${entry.path}`);
      continue;
    }

    const currentHash = computeSha256(filePath);
    if (currentHash.toLowerCase() !== entry.sha256.toLowerCase()) {
      mismatched++;
      errors.push(`MISMATCH: ${entry.path} (expected ${entry.sha256.slice(0, 8)}..., got ${currentHash.slice(0, 8)}...)`);
    } else {
      matched++;
    }
  }

  // 2. Scan targetDir on disk for EXTRA files not represented in manifest!
  const diskFiles = walkDirectory(targetDir, targetDir, false);
  for (const df of diskFiles) {
    const norm = df.relPath.replace(/\\/g, '/');
    if (isSnapshotUnverifiedPath(norm)) {
      excludedFileCount++;
      const excludedName = norm.split('/').find(segment => SNAPSHOT_UNVERIFIED_DIRECTORY_NAMES.includes(segment));
      excludedDirectoryCounts.set(excludedName, (excludedDirectoryCounts.get(excludedName) || 0) + 1);
      continue;
    }
    // Explicitly allow metadata files
    if (norm === 'VERSION-MANIFEST.json' || norm === 'VERSION-SUMMARY.md') {
      continue;
    }
    // Narrowly scoped companion launcher policy for known snapshots
    if (isAllowedCompanionLauncher(tag, norm, options)) {
      continue;
    }
    if (!manifestFilesMap.has(norm)) {
      extra++;
      errors.push(`EXTRA: ${df.relPath} (present on disk but not represented in manifest)`);
    }
  }

  if (!quiet) {
    console.log(`\nVerification Results:`);
    console.log(`  Matched:    ${matched}/${manifest.files.length}`);
    console.log(`  Missing:    ${missing}`);
    console.log(`  Mismatched: ${mismatched}`);
    console.log(`  Extra:      ${extra}`);
    if (excludedFileCount > 0) {
      console.log(`  Excluded:   ${excludedFileCount} files not covered by manifest hashes`);
      for (const [name, count] of excludedDirectoryCounts) console.log(`              ${name}: ${count} files`);
    }
  }

  if (errors.length > 0) {
    if (!quiet) {
      console.log(`\nDefects identified:`);
      errors.slice(0, 20).forEach(e => console.log(`  - ${e}`));
      if (errors.length > 20) console.log(`  ... and ${errors.length - 20} more`);
      console.log(`\nSTATUS: CORRUPTED / INCOMPLETE`);
    }
    return { status: 'CORRUPTED', matched, missing, mismatched, extra, errors };
  }

  if (!quiet) {
    console.log(`\nSTATUS: VERIFIED (all manifest hashes match; excluded files are not hash-verified)`);
  }
  return { status: 'VERIFIED', matched, missing: 0, mismatched: 0, extra: 0, excludedFileCount, excludedDirectoryCounts: Object.fromEntries(excludedDirectoryCounts) };
}

/**
 * List command: list all versions in the versions directory with their status.
 * Clearly distinguishes saved manifest status from fresh integrity verification.
 * If options.verify is true, executes live cryptographic hash verification on each snapshot.
 */
export async function listVersions(options = {}) {
  const cwd = options.cwd || ROOT_DIR;
  const versionsDir = path.join(cwd, 'versions');
  const doVerify = !!options.verify;

  console.log(`\n============================================================`);
  console.log(`CAREERFLOW VERSION INVENTORY`);
  console.log(`============================================================`);
  console.log(`Versions Directory: ${versionsDir}`);
  console.log(`Integrity Mode:     ${doVerify ? 'Live Cryptographic Verification' : 'Manifest Record Only (live check pending)'}\n`);

  if (!fs.existsSync(toExtendedPath(versionsDir))) {
    console.log(`No versions directory found.`);
    return [];
  }

  const entries = fs.readdirSync(toExtendedPath(versionsDir), { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tag = entry.name;
    const dirPath = path.join(versionsDir, tag);
    const manifestPath = path.join(dirPath, 'VERSION-MANIFEST.json');

    let manifestStatus = 'NO MANIFEST';
    let liveIntegrity = 'NOT CHECKED';
    let fileCount = 0;
    let totalBytes = 0;
    let createdAt = 'Unknown';
    let description = '';

    if (fs.existsSync(toExtendedPath(manifestPath))) {
      try {
        const raw = fs.readFileSync(toExtendedPath(manifestPath), 'utf8').replace(/^\uFEFF/, '').trim();
        const manifest = JSON.parse(raw);
        fileCount = manifest.fileCount || (manifest.files ? manifest.files.length : 0);
        totalBytes = manifest.totalBytes || 0;
        createdAt = manifest.createdAt ? manifest.createdAt.replace('T', ' ').slice(0, 19) : 'Unknown';
        description = manifest.description || '';
        manifestStatus = manifest.status ? `SAVED: ${manifest.status}` : 'SAVED: RECORDED';
      } catch {
        manifestStatus = 'MALFORMED MANIFEST';
      }

      if (doVerify) {
        try {
          const verifyRes = await verifyVersion(tag, { cwd, quiet: true, ...options });
          if (verifyRes.status === 'VERIFIED') {
            liveIntegrity = 'PASS (VERIFIED)';
          } else {
            liveIntegrity = `FAIL (${verifyRes.status})`;
          }
        } catch (err) {
          liveIntegrity = `ERROR (${err.message.slice(0, 15)})`;
        }
      } else {
        liveIntegrity = 'NOT PERFORMED';
      }
    } else {
      // No manifest: count files
      try {
        const files = walkDirectory(dirPath, dirPath, false);
        fileCount = files.length;
        for (const f of files) {
          try { totalBytes += fs.statSync(toExtendedPath(f.fullPath)).size; } catch {}
        }
        const stat = fs.statSync(toExtendedPath(dirPath));
        createdAt = stat.mtime.toISOString().replace('T', ' ').slice(0, 19);
        if (tag.includes('stage')) {
          manifestStatus = 'INCOMPLETE (stage)';
        } else {
          manifestStatus = 'NO MANIFEST';
        }
      } catch (err) {
        manifestStatus = 'READ ERROR';
      }
      liveIntegrity = 'UNVERIFIED';
    }

    results.push({
      tag,
      manifestStatus,
      liveIntegrity,
      status: doVerify ? liveIntegrity : `${manifestStatus} (live check pending)`,
      fileCount,
      totalBytes,
      createdAt,
      description,
    });
  }

  // Print formatted table
  const tagColWidth = Math.max(20, ...results.map(r => (r.tag ? r.tag.length + 2 : 20)));
  const totalWidth = tagColWidth + 25 + 22 + 10 + 12 + 22 + 20;

  console.log(
    'Tag'.padEnd(tagColWidth) +
    'Manifest Record'.padEnd(25) +
    'Live Integrity'.padEnd(22) +
    'Files'.padEnd(10) +
    'Size (MB)'.padEnd(12) +
    'Created'.padEnd(22) +
    'Notes'
  );
  console.log('-'.repeat(totalWidth));

  for (const r of results) {
    const sizeMb = (r.totalBytes / (1024 * 1024)).toFixed(2);
    console.log(
      r.tag.padEnd(tagColWidth) +
      r.manifestStatus.padEnd(25) +
      r.liveIntegrity.padEnd(22) +
      String(r.fileCount).padEnd(10) +
      sizeMb.padEnd(12) +
      r.createdAt.padEnd(22) +
      (r.description || '').slice(0, 30)
    );
  }
  console.log('-'.repeat(totalWidth));
  console.log(`Total versions cataloged: ${results.length}`);
  if (!doVerify) {
    console.log(`* Note: 'Manifest Record' reflects status saved at freeze time.`);
    console.log(`  To verify live cryptographic integrity, run: node scripts/version-manager.mjs list --verify`);
    console.log(`  Or verify an individual version: node scripts/version-manager.mjs verify <tag>\n`);
  } else {
    console.log(`* All snapshots subjected to live SHA-256 integrity verification.\n`);
  }

  return results;
}

/**
 * Restore command: safely restore a version to the working copy.
 * CRITICAL SAFETY:
 * - Locks operation against concurrent modification.
 * - Pre-verifies target version (no missing, extra, or modified files).
 * - Validates all manifest paths against path traversal or protected directories.
 * - Computes workspace difference (orphan files) and preserves them in backup.
 * - Creates a verified cryptographic safety backup before modifying active workspace.
 * - Provides automatic transactional rollback if restore or verification fails mid-way.
 */
export async function restoreVersion(tag, options = {}) {
  const cwd = options.cwd || ROOT_DIR;
  const versionsDir = path.join(cwd, 'versions');
  const targetDir = path.join(versionsDir, tag);
  const dryRun = !!options.dryRun;

  console.log(`\n============================================================`);
  console.log(`CAREERFLOW RESTORE: Version ${tag}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`============================================================`);

  if (!fs.existsSync(toExtendedPath(targetDir))) {
    throw new Error(`Target version '${tag}' does not exist at ${targetDir}`);
  }

  const manifestPath = path.join(targetDir, 'VERSION-MANIFEST.json');
  if (!fs.existsSync(toExtendedPath(manifestPath))) {
    throw new Error(`Target version '${tag}' has no manifest. Refusing to restore unverified version!`);
  }

  const raw = fs.readFileSync(toExtendedPath(manifestPath), 'utf8').replace(/^\uFEFF/, '').trim();
  const manifest = JSON.parse(raw);

  // Acquire concurrency lock
  const lock = new VersionLock(path.join(versionsDir, `.lock-${tag}`));
  lock.acquire();

  try {
    // Step 1: Pre-verify target version
    console.log(`[1/5] Pre-verifying target version ${tag} integrity...`);
    const check = await verifyVersion(tag, { cwd });
    if (check.status !== 'VERIFIED') {
      throw new Error(`Target version ${tag} is corrupted or incomplete. Aborting restore for safety!`);
    }

    // Validate all manifest paths
    const validatedManifestFiles = [];
    const targetPathSet = new Set();
    for (const entry of manifest.files) {
      const safeRel = validateSafeRelPath(entry.path, cwd);
      validatedManifestFiles.push({ ...entry, safeRel });
      targetPathSet.add(safeRel.replace(/\\/g, '/'));
    }

    // Step 2: Compute difference between active workspace and target snapshot
    console.log(`\n[2/5] Analyzing active workspace differences...`);
    const activeFiles = walkDirectory(cwd, cwd, true);
    const orphanFiles = [];
    for (const af of activeFiles) {
      const norm = af.relPath.replace(/\\/g, '/');
      if (!targetPathSet.has(norm)) {
        orphanFiles.push(af);
      }
    }

    console.log(`  Active files in workspace: ${activeFiles.length}`);
    console.log(`  Files in target snapshot:  ${validatedManifestFiles.length}`);
    console.log(`  Files unique to workspace (absent from target): ${orphanFiles.length}`);

    if (dryRun) {
      console.log(`\n[DRY RUN] Target version contains ${manifest.files.length} files.`);
      console.log(`[DRY RUN] Active workspace contains ${activeFiles.length} files.`);
      console.log(`[DRY RUN] Files to overwrite/add: ${manifest.files.length}`);
      console.log(`[DRY RUN] Files in workspace absent from target (orphans): ${orphanFiles.length}`);
      if (orphanFiles.length > 0) {
        console.log(`[DRY RUN] Sample orphan files that would be archived to backup:`);
        orphanFiles.slice(0, 10).forEach(o => console.log(`  - ${o.relPath}`));
      }
      return { status: 'DRY_RUN_COMPLETE', targetFilesCount: manifest.files.length, orphanFilesCount: orphanFiles.length };
    }

    // Step 3: Create and verify complete cryptographic safety backup of ALL active files
    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(versionsDir, `backup-before-restore-${backupTimestamp}`);
    console.log(`\n[3/5] CREATING AND VERIFYING SAFETY BACKUP OF ACTIVE WORKSPACE...`);
    console.log(`      Backup location: ${backupDir}`);
    fs.mkdirSync(toExtendedPath(backupDir), { recursive: true });

    const backupEntries = [];
    let backupBytes = 0;
    for (const item of activeFiles) {
      const dest = path.join(backupDir, item.relPath);
      safeCopyFile(item.fullPath, dest);
      const hash = computeSha256(dest);
      const stat = fs.statSync(toExtendedPath(dest));
      backupEntries.push({
        path: item.relPath,
        bytes: stat.size,
        sha256: hash,
      });
      backupBytes += stat.size;
    }

    // Write backup manifest
    const backupManifest = {
      backupTimestamp,
      sourceWorkspace: cwd,
      targetVersion: tag,
      fileCount: backupEntries.length,
      orphanCount: orphanFiles.length,
      files: backupEntries,
      orphans: orphanFiles.map(o => o.relPath),
    };
    fs.writeFileSync(toExtendedPath(path.join(backupDir, 'BACKUP-MANIFEST.json')), JSON.stringify(backupManifest, null, 2), 'utf8');

    // Cryptographic verification of backup before ANY workspace modification
    console.log(`  Verifying safety backup cryptographic hashes...`);
    for (const be of backupEntries) {
      const origFile = path.join(cwd, be.path);
      const backedFile = path.join(backupDir, be.path);
      const origHash = computeSha256(origFile);
      const backedHash = computeSha256(backedFile);
      if (origHash.toLowerCase() !== backedHash.toLowerCase()) {
        throw new Error(`Safety backup integrity check failed for ${be.path}! Aborting restore before modifying active workspace.`);
      }
    }
    console.log(`  Safety backup verified 100% (${backupEntries.length} files, ${(backupBytes / (1024 * 1024)).toFixed(2)} MB).`);

    // Step 4: Transactional Restoration & Managed Orphan Removal
    console.log(`\n[4/5] Restoring target snapshot and reconciling workspace...`);
    let filesModified = false;

    try {
      // Archive/remove orphan files from managed code trees (already 100% backed up in backupDir)
      if (orphanFiles.length > 0) {
        console.log(`  Reconciling ${orphanFiles.length} orphan files from managed directories...`);
        for (const orphan of orphanFiles) {
          const normRel = orphan.relPath.replace(/\\/g, '/');
          const isManaged = MANAGED_PROJECT_PREFIXES.some(prefix => normRel.startsWith(prefix));
          if (isManaged) {
            filesModified = true;
            fs.unlinkSync(toExtendedPath(orphan.fullPath));
          }
        }
      }

      // Restore target files
      let restoredCount = 0;
      for (const entry of validatedManifestFiles) {
        if (options._injectRestoreFailureAt && restoredCount >= options._injectRestoreFailureAt) {
          throw new Error('SIMULATED_RESTORE_FAILURE');
        }
        const srcFile = path.join(targetDir, entry.path);
        const destFile = path.join(cwd, entry.safeRel);
        filesModified = true;
        safeCopyFile(srcFile, destFile);
        restoredCount++;
        if (restoredCount % 200 === 0 || restoredCount === validatedManifestFiles.length) {
          process.stdout.write(`  Restored ${restoredCount}/${validatedManifestFiles.length} files...\r`);
        }
      }
      console.log(`\n  Restored ${restoredCount} files successfully.`);

      // Step 5: Verify restored files in workspace
      console.log(`\n[5/5] Verifying restored active workspace against version manifest...`);
      let verifiedCount = 0;
      for (const entry of validatedManifestFiles) {
        const checkFile = path.join(cwd, entry.safeRel);
        const hash = computeSha256(checkFile);
        if (hash.toLowerCase() !== entry.sha256.toLowerCase()) {
          throw new Error(`Restoration verification failed for ${entry.safeRel}! Hashes do not match.`);
        }
        verifiedCount++;
      }
      console.log(`  All ${verifiedCount} restored files match manifest hashes 100%!`);
    } catch (restoreErr) {
      // AUTOMATIC ROLLBACK FROM VERIFIED BACKUP
      console.error(`\n[ERROR] Restoration interrupted: ${restoreErr.message}`);
      if (filesModified) {
        console.log(`[ROLLBACK] Initiating automated rollback to pre-restore state from: ${backupDir}...`);
        let rollbackOk = false;
        try {
          if (options._injectRollbackFailure) {
            throw new Error('SIMULATED_ROLLBACK_FAILURE');
          }
          for (const be of backupEntries) {
            const src = path.join(backupDir, be.path);
            const dest = path.join(cwd, be.path);
            safeCopyFile(src, dest);
          }
          // Verify rollback
          for (const be of backupEntries) {
            const checkFile = path.join(cwd, be.path);
            const h = computeSha256(checkFile);
            if (h.toLowerCase() !== be.sha256.toLowerCase()) {
              throw new Error(`Rollback hash mismatch for ${be.path}`);
            }
          }
          rollbackOk = true;
        } catch (rbErr) {
          throw new Error(`CRITICAL FAILURE: Restore failed (${restoreErr.message}) AND rollback failed (${rbErr.message}). Verified pre-restore backup preserved at: ${backupDir}`);
        }

        if (rollbackOk) {
          throw new Error(`Restore aborted: ${restoreErr.message}. Workspace has been fully rolled back to pre-restore state from backup: ${backupDir}`);
        }
      } else {
        throw restoreErr;
      }
    }

    console.log(`\n============================================================`);
    console.log(`SUCCESS: Workspace restored to ${tag}!`);
    console.log(`Safety backup preserved at: ${backupDir}`);
    console.log(`Run 'npm install' if dependencies were altered.`);
    console.log(`============================================================\n`);

    return { status: 'RESTORED', backupDir, restoredCount: validatedManifestFiles.length };
  } finally {
    lock.release();
  }
}

// CLI handler
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';

  try {
    if (command === 'freeze') {
      const tag = args[1] && !args[1].startsWith('--') ? args[1] : null;
      let desc = null;
      const descIdx = args.indexOf('--desc');
      if (descIdx !== -1 && args[descIdx + 1]) {
        desc = args[descIdx + 1];
      }
      await freezeVersion({ tag, description: desc });
    } else if (command === 'verify') {
      const tag = args[1];
      if (!tag) {
        console.error('Usage: node scripts/version-manager.mjs verify <version-tag>');
        process.exit(1);
      }
      const res = await verifyVersion(tag);
      if (res.status !== 'VERIFIED') process.exit(1);
    } else if (command === 'list') {
      const verify = args.includes('--verify') || args.includes('-v');
      await listVersions({ verify });
    } else if (command === 'restore' || command === 'switch') {
      const tag = args[1];
      if (!tag) {
        console.error('Usage: node scripts/version-manager.mjs restore <version-tag> [--dry-run]');
        process.exit(1);
      }
      const dryRun = args.includes('--dry-run');
      await restoreVersion(tag, { dryRun });
    } else {
      console.log(`CareerFlow Version Manager`);
      console.log(`Available commands:`);
      console.log(`  freeze [tag] [--desc "description"] - Freeze current working copy into versions/<tag>`);
      console.log(`  verify <tag>                        - Verify integrity of frozen version <tag>`);
      console.log(`  list [--verify]                     - List all versions (with optional live integrity verification)`);
      console.log(`  restore <tag> [--dry-run]           - Safely restore version <tag> with pre-restore backup`);
    }
  } catch (err) {
    console.error(`\n[FATAL ERROR] ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
