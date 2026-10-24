# CareerFlow Version Management System

## 1. Overview & Core Philosophy

CareerFlow utilizes a **local-first, deterministic version snapshot workflow** designed specifically for iterative desktop application engineering.

### Key Principles:
1. **Immutable Frozen Releases:** Whenever an iteration is accepted and frozen, it is preserved permanently in `versions/<tag>/`. Once frozen and marked `VERIFIED`, a version folder is never mutated in place.
2. **Working-Copy Recovery Without Data Loss:** Development continues in the active workspace. If any subsequent iteration is rejected or problematic, you can restore any earlier frozen version.
3. **Automatic Safety Backup:** Any restore operation automatically creates a timestamped safety backup of the current active working copy (`versions/backup-before-restore-<timestamp>/`) *before* touching or replacing any file.
4. **100% Cryptographic Integrity:** Every frozen snapshot contains a machine-readable `VERSION-MANIFEST.json` recording the SHA-256 hash, byte size, and relative path of every file. Integrity can be verified on demand at any time.
5. **Windows Path Resilience:** Fully supports Windows Extended-Length Paths (`\\?\`) and natively handles directory names with trailing spaces (e.g., `shots/redesign-r3 `) without path truncation or API errors.

---

## 2. Directory Structure

```
CareerFlow/
├── core/                                # Rust core native module & migrations
├── shell/                               # Electron main process & services
├── ui/                                  # Svelte 5 desktop frontend
├── e2e/                                 # Playwright test journeys
├── scripts/
│   └── version-manager.mjs              # Core Version Management CLI
├── versions/                            # Immutable version snapshots & backups
│   ├── v1/                              # Legacy 10/5/2026 distribution (VERIFIED)
│   │   ├── VERSION-MANIFEST.json
│   │   ├── VERSION-SUMMARY.md
│   │   └── ... (11 files + node_modules)
│   ├── v2/                              # Daily-Use Baseline Freeze (VERIFIED)
│   │   ├── VERSION-MANIFEST.json
│   │   ├── VERSION-SUMMARY.md
│   │   └── ... (1,274 files)
│   └── backup-before-restore-<time>/    # Automatic safety backups
├── freeze.bat                           # Double-clickable freeze launcher
├── list-versions.bat                    # Double-clickable version inventory
├── verify-version.bat                   # Double-clickable integrity verification
└── restore-version.bat                  # Double-clickable safe restore launcher
```

---

## 3. Inclusion & Exclusion Rules

To ensure snapshots are compact, self-contained, and deterministic:

### Included in Version Snapshots:
- **All Source Code:** `core/src`, `core/migrations`, `shell/src`, `ui/src`.
- **All Tests & Specifications:** `shell/tests`, `ui/tests`, `e2e`.
- **Pre-Built Standalone Binaries:**
  - Native Node addon: `core/careerflow_core.win32-x64-msvc.node`
  - Compiled UI bundle: `ui/dist/**`
- **Documentation & Evidence:** `docs/` (including `docs/gates/`, `docs/reports/`, and `docs/audits/`), `project-intel/`, `shots/` (including visual redesign folders), `logs/` (test and execution logs).
- **Configuration & Dependency Manifests:** `package.json`, `package-lock.json`, `index.js`, `playwright.config.js`, `electron-builder*.yml`.

### Excluded from Version Snapshots:
- `node_modules` (at all directory depths)
- `.git` (Git repository database)
- `versions` (recursive version store)
- `v1` (retired root legacy directory; absent, with the path permanently excluded from snapshots and protected against restore pollution)
- `core/target` and `target` (Rust Cargo intermediate build cache; 26k+ files, ~8.7 GB)
- `release` (electron-builder packaging cache)
- `test-results` (Playwright temporary run outputs)
- OS temporary files (`.DS_Store`, `Thumbs.db`)

---

## 4. Quick-Start Guide (Windows Batch Launchers)

For rapid daily use, 4 double-clickable launchers are provided in the CareerFlow root:

| Launcher | Action | Description |
|---|---|---|
| `freeze.bat` | Freeze current state | Prompts for a tag (e.g. `v3`) or auto-increments. Validates workspace, creates atomic snapshot, computes SHA-256 hashes, and marks version as `VERIFIED`. |
| `list-versions.bat` | View version inventory | Shows all versions, status (`VERIFIED` vs `INCOMPLETE`), file count, size, and creation timestamp. |
| `verify-version.bat` | Verify version integrity | Re-computes SHA-256 hashes for all files in a version and confirms 100% cryptographic match. |
| `restore-version.bat` | Safely restore a version | Prompts for target version, verifies target integrity, creates an automatic safety backup of current workspace, and restores target files cleanly. |

---

## 5. Command-Line Interface (Node.js)

You can also run the version manager directly from PowerShell or Command Prompt:

### 1. Freeze Current Workspace
```cmd
node scripts/version-manager.mjs freeze [tag] [--desc "Description text"]
```
*Example:*
```cmd
node scripts/version-manager.mjs freeze v3 --desc "Task 11 Feature Complete"
```
*(If tag is omitted, it auto-detects the next version: `v1` -> `v2` -> `v3`)*

### 2. Verify Version Integrity
```cmd
node scripts/version-manager.mjs verify <tag>
```
*Example:*
```cmd
node scripts/version-manager.mjs verify v2
```

### 3. List All Versions
```cmd
node scripts/version-manager.mjs list
```

### 4. Restore Earlier Version
```cmd
node scripts/version-manager.mjs restore <tag>
```
*Preview without modifying anything:*
```cmd
node scripts/version-manager.mjs restore <tag> --dry-run
```

---

## 6. Version Catalog

| Version Tag | Status | Description | File Count | Size |
|---|---|---|---|---|
| `v1` | **VERIFIED** | Legacy 10/5/2026 distribution snapshot (compiled core + UI bundle). | 11 | 7.46 MB |
| `v2` | **VERIFIED** | Daily-Use Baseline Freeze (Tasks 0–10.1 accepted; full source + tests + binaries + evidence). | 1,274 | 61.63 MB |

> **Cleanup Record (2026-10-13):**
> Following a cryptographic audit confirming 0 unique files, 3 redundant staging folders (`versions/v1-stage-20261012`, `versions/working-copy-20261012`, and `versions/working-copy-stage-20261012`) were safely removed under user approval. The versions repository now cleanly contains only verified, immutable releases (`v1` and `v2`).
>
> **Root v1 Retirement Record (2026-10-13):**
> The former duplicate root `CareerFlow\v1` directory was retired and removed following verification that all regular files are preserved in the immutable `versions\v1` snapshot. The Version Manager continues to enforce protection rules that disallow operations targeting a root `v1` path to prevent accidental workspace pollution.
