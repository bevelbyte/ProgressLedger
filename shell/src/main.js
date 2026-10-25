import { app, BrowserWindow, Menu, ipcMain, dialog, session, protocol, net } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";

import {
  getLauncherState,
  setActiveWorkspace,
  switchWorkspace,
  resolveDbPath,
  resolveLogPath,
  resolveReservationsDbPath,
  resolveMarketplaceDir,
  resolveTempDir,
  unlockWorkspace,
  isDestinationOccupied,
} from "./workspace.js";
import { initLogger, installFileLogger, rotateAndPruneLogs } from "./services/logger.js";
import { makeIpcContext, registerAllIpc } from "./ipc/index.js";
import { setupAutoUpdater } from "./ipc/updates.js";
import {
  initReservationsStore,
  startSweeper,
  stopSweeper,
  closeReservationsStore,
} from "./services/file-reservations.js";
import { unregister as unregisterNotesShortcut } from "./ipc/notes.js";
import { scheduleAutomation, stopAutomation } from "./services/sync-runner.js";
import { cancelAllAgents } from "./services/agent/loop.js";
import { stopAllObservations } from "./services/goals/engine.js";
import { Plugins } from "./services/plugins/index.js";
import { Skills } from "./services/skills/index.js";
import { Audit } from "./services/audit/index.js";
import { _closeAll as _closeAllProjectIntel } from "./services/project-intel/index.js";
import { _closeAll as _closeAllProjectMemory } from "./services/memory/index.js";
import { bootstrapMarketplace, shutdownMarketplace } from "./services/marketplace/bootstrap.js";
import { MCP } from "./services/mcp/index.js";
import { CSP_HEADER } from "./security/csp.js";
import { isGovernedWebContents } from "./services/browser/host.js";
import { makeWillNavigateGuard } from "./services/browser/navigation.js";
// Re-exported for IPC modules: drop-in `safeHandle(channel, fn)` that
// enforces the sender-origin allow-list (see ./security/ipc-auth.js for
// the pure primitive; the wrapper lives in ./security/safe-handle.js
// because Electron's `ipcMain` is CJS-only). Existing channels keep
// using raw `ipcMain.handle` until each module is migrated (tracked in
// CAPABILITY-MATRIX.md).
export { safeHandle } from "./security/safe-handle.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILT_UI_ROOT = resolvePath(join(__dirname, "../../ui/dist"));

// A sandboxed renderer loaded directly from file:// gets an opaque storage
// origin in recent Electron/Chromium releases, which makes DOM storage (used
// by the local-first UI for lightweight preferences) unavailable. Use a
// dedicated standard/secure application origin instead of weakening the
// renderer sandbox. The handler serves only files under the packaged UI root.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "progressledger-v2",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
 ]);
const core = require(join(__dirname, "../../core"));

const isDev = !app.isPackaged;
const isE2E = process.env.PROGRESSLEDGER_V2_E2E === "1";
const isMigrationTest = process.env.PROGRESSLEDGER_V2_MIGRATION_TEST === "1";

// Packaged E2E runs must be isolated from the user's real Progress Ledger data.
// Electron's Chromium switch does not reliably change app.getPath("userData")
// for a packaged executable launched through the Electron test harness, so a
// test-only environment override is applied before app readiness. Production
// launches have no supported path to this branch.
if ((isE2E || isMigrationTest) && process.env.PROGRESSLEDGER_V2_E2E_USER_DATA) {
  app.setPath("userData", process.env.PROGRESSLEDGER_V2_E2E_USER_DATA);
} else {
  // v2 identity: this build must never open the original Progress Ledger's
  // data folder, so its own userData directory carries a -v2 suffix.
  app.setPath("userData", join(app.getPath("appData"), "progress-ledger-v2"));
}


// --- Single instance ---
if (!isE2E) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    console.info("Progress Ledger is already running. Exiting second instance.");
    app.quit();
    process.exit(0);
  }
}

let mainWindow = null;
let ipcContext = null;

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// --- Global web-contents guard (D2-D6 plan, Phase 1 + R2) ----------------
//
// Every webContents this application ever creates refuses to open a window. The
// embedded browser registers its own per-view gates (navigation refusals and
// the permission handlers) in services/browser/host.js, and main.js's
// `web-contents-created` handler is the BACKSTOP the approved design asks for
// (D3-2, enforcement point 5): a view created in future code that forgot to
// wire its own gates still gets the navigation allowlist, so "we forgot to wire
// the new view" cannot ship silently.
//
// The backstop is deliberately NARROW in scope. It must never see the app's own
// privileged renderer, which navigates to `file:`/`progressLedger:` app surfaces by
// design and is governed by its own `isTrustedNavigation` check below. The two
// privileged windows therefore register their contents in `appContents`, and
// the embedded browser registers its pages in `governedWebContents` — either
// registration exempts a contents from the backstop. A third surface that is
// neither would get the allowlist applied to it, which is the intended
// fail-closed behaviour for something nobody thought about.
const appContents = new WeakSet();

app.on("web-contents-created", (_event, contents) => {
  try {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  } catch {
    // A contents object that refuses the handler is not a reason to abort boot;
    // the per-view gates still apply to every browser page.
  }
  if (appContents.has(contents) || isGovernedWebContents(contents)) return;
  try {
    contents.on("will-navigate", makeWillNavigateGuard());
  } catch {
    // Same reasoning: the backstop is best-effort, never a boot blocker.
  }
});

function getWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0d1117",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: isE2E ? ["--progressledger-v2-e2e"] : [],
    },
  });

  // This renderer is privileged and is exempt from the global navigation
  // backstop above (see the comment there): it loads the app UI from
  // `file:` / `progressLedger:`, and its own `isTrustedNavigation` check is what
  // governs it.
  appContents.add(mainWindow.webContents);

  const builtUiPath = resolvePath(join(__dirname, "../../ui/dist/index.html"));
  const isTrustedNavigation = (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      if (url.protocol === "file:") {
        return url.hostname === "" && resolvePath(fileURLToPath(url)) === builtUiPath;
      }
      if (url.protocol === "progressLedger:") {
        return url.hostname === "app" && url.pathname === "/index.html";
      }
      return isDev
        && url.protocol === "http:"
        && url.hostname === "127.0.0.1"
        && url.port === "5173";
    } catch {
      return false;
    }
  };

  // The main renderer is privileged because it owns the preload bridge.
  // Never let navigation or redirects replace it with arbitrary remote or
  // filesystem content that would inherit that bridge.
  const rejectUntrustedNavigation = (event, url) => {
    if (!isTrustedNavigation(url)) event.preventDefault();
  };
  mainWindow.webContents.on("will-navigate", rejectUntrustedNavigation);
  mainWindow.webContents.on("will-redirect", rejectUntrustedNavigation);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // --- E2E off-screen launch (test infrastructure only) ---------------------
  // The window stays REAL: same BrowserWindow, same renderer, same preload
  // bridge, same IPC, same native services, and a normal top-level HWND with
  // normal visibility and focus semantics. It is only MOVED off the user's
  // desktop so an automated run never flashes a window over their screen.
  //
  // (-32000, -32000) is outside any virtual desktop, so Windows never
  // composites it on a display, while the HWND remains a fully functional
  // top-level window.
  //
  // This is the default for EVERY E2E spec, including the native
  // separate-mode browser specs. PROGRESSLEDGER_V2_E2E_VISIBLE=1 exists only as
  // an explicit, per-invocation escape hatch; no spec sets it, because an
  // automated run must not take over the operator's desktop.
  //
  // Gated on isE2E, so the packaged/shipped app is bit-for-bit unaffected.
  if (isE2E && process.env.PROGRESSLEDGER_V2_E2E_VISIBLE !== "1") {
    mainWindow.setPosition(-32000, -32000);
  }

  mainWindow.show();

  const useBuiltUI = !isDev || isE2E;
  if (useBuiltUI) {
    mainWindow.loadURL("progressledger-v2://app/index.html");
  } else {
    mainWindow.loadURL("http://127.0.0.1:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function cleanupTempDir() {
  try {
    const tempDir = resolveTempDir();
    if (!existsSync(tempDir)) return;
    const files = await readdir(tempDir);
    for (const file of files) {
      await rm(join(tempDir, file), { recursive: true, force: true }).catch((e) =>
        console.warn(`Failed to cleanup temp file ${file}:`, e)
      );
    }
  } catch (e) {
    console.error("Temp directory cleanup failed:", e);
  }
}

app.whenReady().then(async () => {
  protocol.handle("progressledger-v2", async (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const candidate = resolvePath(join(BUILT_UI_ROOT, relativePath || "index.html"));
    if (candidate !== BUILT_UI_ROOT && !candidate.startsWith(`${BUILT_UI_ROOT}${process.platform === "win32" ? "\\" : "/"}`)) {
      return new Response("Not Found", { status: 404 });
    }
    if (!existsSync(candidate)) return new Response("Not Found", { status: 404 });
    return net.fetch(pathToFileURL(candidate).toString());
  });
  // --- Strict CSP on the main BrowserWindow's session ---
  // session.defaultSession covers the main app window; the migration
  // window runs in its own session-less default partition and ships only
  // static HTML, so leaving it untouched keeps the migration wizard
  // readable even if a future change tightens the renderer CSP.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...(details.responseHeaders || {}) };
    // Drop any CSP set by Vite/dev server, then set ours.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-security-policy") delete headers[key];
    }
    headers["Content-Security-Policy"] = [CSP_HEADER];
    callback({ responseHeaders: headers });
  });
  const launcherState = getLauncherState();
  // --- Workspace initialization (first run ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ migration wizard) ---
  if (isE2E) {
    // E2E bypasses UI and forces a valid workspace.
    const legacyPath = app.getPath("userData");
    mkdirSync(legacyPath, { recursive: true });
    writeFileSync(
      join(legacyPath, "workspace.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: require("node:crypto").randomUUID(),
        createdAt: new Date().toISOString(),
        appVersion: app.getVersion(),
      })
    );
    const legacyLock = join(legacyPath, ".progressLedger.lock");
    if (existsSync(legacyLock)) {
      try {
        unlinkSync(legacyLock);
      } catch {}
    }
    setActiveWorkspace(legacyPath);
    switchWorkspace(legacyPath);
  } else if (!launcherState.lastWorkspace) {
    const migration = await runMigrationFlow();
    // Closing the migration wizard is an explicit application cancellation.
    // Do not continue bootstrapping services after app.quit() was requested.
    if (migration?.cancelled) return;
  } else {
    try {
      setActiveWorkspace(launcherState.lastWorkspace);
    } catch (e) {
      console.warn("Saved workspace invalid, rerunning first-run flow:", e);
      const migration = await runMigrationFlow();
      if (migration?.cancelled) return;
    }
  }
  Menu.setApplicationMenu(null);
  initLogger(isDev ? join(process.cwd(), "logs", "progress-ledger-v2.log") : resolveLogPath());
  installFileLogger();
  rotateAndPruneLogs();
  await cleanupTempDir();

  console.info("Progress Ledger starting", { packaged: app.isPackaged, version: app.getVersion() });

  // --- Native core / SQLite ---
  const dbPath = resolveDbPath();
  try {
    core.initDb(dbPath);
    console.log("DB initialized at", dbPath);
    core.cleanupOrphanAttachments();
    console.log("Orphan attachments cleanup completed");
  } catch (e) {
    console.error("initDb failed:", e);
  }

  // --- Security audit log -------------------------------------------------
  //
  // The audit log is the app's record of privileged actions. `Audit.log()` is
  // a silent no-op until `start()` has been called (it guards on
  // `state.started`), and `list()` answers `[]` while `state` is null.
  //
  // `start()` therefore has to be called here, in the main process, or the
  // whole trail is inert in the real application: nothing is written to
  // <userData>/audit-log.jsonl, and `audit:list` / `audit:list-events` return
  // an empty array forever. This is the same class of defect as the
  // Marketplace registry having no production caller — an integration that
  // only the unit tests exercised.
  //
  // WHAT IS RECORDED TODAY (enumerated from the actual `Audit.log(` call
  // sites, not from intent):
  //   agent.start / agent.end
  //   tool.invoked / tool.completed / tool.failed  (both the IPC path in
  //     services/project-tools/_runtime.js AND the agent path in
  //     services/agent/loop.js, which calls tool.execute() directly)
  //   approval.resolve (approved | denied)
  //   provider.call, shell:exec
  //   project.create / project.delete, agent.create
  //   profile.create / profile.delete
  //   goal.create / goal.delete / goal.promote / goal.start / goal.cancel /
  //     goal.terminal / goal.resume / goal.recovery.sweep
  //
  // WHAT IS NOT RECORDED — a real, reported gap, not an oversight to paper
  // over: marketplace install/enable/disable/update/uninstall, provider
  // credential writes and clears, backup export/restore, and every browser
  // lifecycle and navigation action. See
  // _evidence_FINALVAL_remaining_gaps_20260926.txt.
  //
  // Initialized immediately after the DB, because the audit trail must be able
  // to record the initialization work itself. Failure is non-fatal by design:
  // the audit service never throws, and a missing audit file must not stop the
  // application from starting.
  try {
    const auditPath = join(app.getPath("userData"), "audit-log.jsonl");
    await Audit.start(auditPath);
    console.log("Audit log ready at", Audit.filePath());
  } catch (e) {
    console.error("Audit log initialization failed:", e);
  }

  // Initialize the on-disk plugin registry against the active workspace.
  // Auto-reload is deliberately opt-in so production does not open filesystem
  // watchers unless explicitly configured. When enabled, the same startup
  // path also arms watchers for every plugin discovered from disk.
  try {
    const pluginRoot = dirname(dbPath);
    Plugins.configurePlugins({ rootDir: pluginRoot });
    const loaded = Plugins.loadFromDisk({ rootDir: pluginRoot });
    if (!loaded.ok) console.warn("Plugin registry load reported errors:", loaded.errors);
    const autoReload = process.env.PROGRESSLEDGER_V2_PLUGIN_AUTO_RELOAD === "1";
    Plugins.configureAutoReload({ enabled: autoReload });
    console.log("Plugin registry ready", {
      count: loaded.count,
      errors: loaded.errors.length,
      autoReload,
    });
  } catch (e) {
    console.error("Plugin registry initialization failed:", e);
  }

  // --- Skills registry -------------------------------------------------------
  // Skills are reusable instruction packs: `<userData>/skills/<id>/SKILL.md`.
  // They MUST be configured here, in the main process, at startup.
  //
  // Why this call is load-bearing: `Skills.configureSkills()` is what sets
  // `_rootDir`/`_statePath`, and `Skills.loadFromDisk()` is what populates the
  // registry. Without BOTH, the registry stays empty, so in the running app:
  //   - `skills:list` always answers `{ ok:true, skills: [] }`
  //   - `skills:set-enabled` always fails `unknown-skill`
  //   - `Skills.buildSystemPrompt()` returns "" so the agent never sees a skill
  // while the Skill Inventory panel renders permanently empty and
  // docs/PROJECT-MODE-GUIDE.md advertises a capability the product lacks.
  //
  // The root is `app.getPath("userData")` — deliberately the SAME root the
  // `skills:preview` IPC handler resolves independently
  // (shell/src/ipc/skills-plugins-mcp.js getUserDataDir()). The two halves of
  // the feature must agree on one root, otherwise the panel can list a skill
  // whose SKILL.md the preview handler refuses to read.
  //
  // Placed immediately after the plugin registry: skills and plugins are the
  // same class of on-disk extension manifest.
  try {
    const skillsRoot = app.getPath("userData");
    Skills.configureSkills({ rootDir: skillsRoot });
    const loadedSkills = Skills.loadFromDisk({ rootDir: skillsRoot });
    if (!loadedSkills.ok) console.warn("Skill registry load reported errors:", loadedSkills.errors);
    console.log("Skill registry ready", {
      count: loadedSkills.count,
      errors: loadedSkills.errors.length,
      root: skillsRoot,
    });
  } catch (e) {
    console.error("Skill registry initialization failed:", e);
  }

  // --- Marketplace registry (install + discovery for plugin-shaped items) ---
  // The marketplace service is the install/discovery layer ABOVE the plugin
  // runtime: an installed marketplace item IS a plugin, stored at
  // <workspace>/marketplace/<id>/ with a marketplace-state.json sidecar.
  //
  // It MUST be configured in the main process at startup. Without this the
  // secured service stays unreachable and every marketplace:* IPC operation
  // answers `no-root` — the containment policy in
  // services/marketplace/path-security.js would never actually be exercised.
  //
  // Placed immediately after the plugin registry because the marketplace reads
  // and writes the same class of on-disk manifests. Initialized exactly once
  // per process; the containment policy is never bypassed or duplicated.
  try {
    const marketplaceRoot = resolveMarketplaceDir();
    const loaded = bootstrapMarketplace(marketplaceRoot);
    if (!loaded.ok) console.warn("Marketplace registry load reported errors:", loaded.errors);
    console.log("Marketplace registry ready", {
      root: loaded.root,
      count: loaded.count,
      errors: loaded.errors.length,
    });
  } catch (e) {
    console.error("Marketplace registry initialization failed:", e);
  }

  // --- Sidecar reservations store (file-write conflict protection) ---
  // Lives in a SEPARATE SQLite file so it never touches the pm_* schema.
  // A background sweeper auto-releases reservations older than 10 minutes
  // to guard against crashed agents.
  try {
    const reservationsDbPath = resolveReservationsDbPath();
    const init = await initReservationsStore({ dbPath: reservationsDbPath });
    if (init.ok) {
      const sweeper = startSweeper();
      console.log("Reservations store ready at", init.dbPath, "sweeper:", sweeper.ok);
    } else {
      console.error("initReservationsStore failed:", init.error);
    }
  } catch (e) {
    console.error("Reservations store init threw:", e);
  }
  const ctx = makeIpcContext({ core, getWindow, app });
  ipcContext = ctx;
  registerAllIpc(ctx);
  if (!isDev) setupAutoUpdater(ctx.notify);

  createWindow();
  // V2-41: pending-delete cleanup runs only after the window is
  // shown, so it can never delay or block the first window. It is
  // async and budgeted inside the cleanup itself (30 s); a leftover
  // row simply waits for the next start.
  if (typeof ctx.runPendingDeleteCleanup === "function") {
    void ctx.runPendingDeleteCleanup();
  }
  scheduleAutomation(core, ctx.notify);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});


app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("will-quit", () => {
  stopAutomation();
  try { stopSweeper(); } catch {}
  try { closeReservationsStore(); } catch {}
  try { shutdownMarketplace(); } catch {}
  try { Plugins.configureAutoReload({ enabled: false }); } catch {}
  // Flush in-flight audit writes so the last privileged action of the session
  // is durable on disk rather than lost with the process.
  try { void Audit.stop(); } catch {}
  // Close the sidecar SQLite handles (project-intel + project-memory) so they
  // are checkpointed before the process goes away rather than held until
  // teardown. Both services cache their handles per projectId and would
  // otherwise keep the -wal/-shm files locked until exit.
  try { _closeAllProjectIntel(); } catch {}
  try { _closeAllProjectMemory(); } catch {}
  try {
    const dbPath = resolveDbPath();
    if (dbPath) core.checkpointDb(dbPath);
  } catch (err) {
    console.error("Failed to checkpoint primary database on quit:", err);
  }
  try { cancelAllAgents(); } catch {}
  try { stopAllObservations(); } catch {}
  unregisterNotesShortcut();
  unlockWorkspace();
});

// --- First-run / workspace migration wizard (separate small window) ---
function runMigrationFlow() {
  return new Promise((resolve, reject) => {
    let migWindow = new BrowserWindow({
      width: 600,
      height: 450,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, "migration-preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        // Match the main window's hardening contract. The migration window
        // exposes a small directory-picker surface (migration-preload.cjs);
        // it does not need the lower-friction default.
        sandbox: true,
      },
    });

    migWindow.loadFile(join(__dirname, "migration.html"));
    migWindow.once("ready-to-show", () => migWindow.show());

    // Privileged surface: exempt from the global navigation backstop, exactly
    // like the main window. It loads a local `file:` document and its own
    // migration preload governs it.
    appContents.add(migWindow.webContents);

    let isResolved = false;
    let selectedMigrationPath = null;

    // The migration-test mode uses a pre-created directory instead of opening
    // a native folder picker. This keeps first-run migration reproducible and
    // isolated without weakening the production picker/IPC path.
    if (isMigrationTest && process.env.PROGRESSLEDGER_V2_MIGRATION_TEST_TARGET) {
      try {
        selectedMigrationPath = realpathSync(
          resolvePath(process.env.PROGRESSLEDGER_V2_MIGRATION_TEST_TARGET),
        );
      } catch {
        selectedMigrationPath = null;
      }
    }

    const isMigrationSender = (event) =>
      event?.sender === migWindow.webContents
      && event?.senderFrame === migWindow.webContents.mainFrame;

    ipcMain.handle("migration:select-dir", async (event) => {
      if (!isMigrationSender(event)) return null;
      if (isMigrationTest && selectedMigrationPath) return selectedMigrationPath;
      const res = await dialog.showOpenDialog(migWindow, {
        properties: ["openDirectory", "createDirectory"],
        title: "Select Workspace Directory",
      });
      if (res.canceled || !res.filePaths[0]) {
        selectedMigrationPath = null;
      } else {
        try {
          // Store the canonical filesystem identity returned by the picker.
          // This closes the reparse-point/junction TOCTOU where a renderer can
          // submit the same textual path after it has been redirected.
          selectedMigrationPath = realpathSync(resolvePath(res.filePaths[0]));
        } catch {
          selectedMigrationPath = null;
        }
      }
      return selectedMigrationPath;
    });

    ipcMain.handle("migration:cancel", (event) => {
      if (!isMigrationSender(event)) return { ok: false, reason: "unauthorized-sender" };
      isResolved = true;
      migWindow.close();
      app.quit();
      return { ok: true };
    });

    ipcMain.handle("migration:start", async (event, targetPath) => {
      if (!isMigrationSender(event)) return { ok: false, reason: "unauthorized-sender" };
      if (typeof targetPath !== "string" || !targetPath.trim() || !isAbsolute(targetPath)) {
        return { ok: false, reason: "invalid-target-path" };
      }
      targetPath = resolvePath(targetPath);
      let canonicalTargetPath;
      try {
        canonicalTargetPath = realpathSync(targetPath);
      } catch {
        return { ok: false, reason: "workspace-path-not-selected" };
      }
      if (!selectedMigrationPath || canonicalTargetPath !== selectedMigrationPath) {
        return { ok: false, reason: "workspace-path-not-selected" };
      }

      targetPath = canonicalTargetPath;
      if (isDestinationOccupied(targetPath)) {
        return { ok: false, reason: "destination-occupied" };
      }
      const { cp, writeFile } = require("node:fs/promises");
      const { renameSync } = require("node:fs");
      const { randomUUID } = require("node:crypto");

      mkdirSync(targetPath, { recursive: true });

      const legacyDbPath = join(app.getPath("userData"), "progress-ledger-v2.db");
      const hasLegacyData = existsSync(legacyDbPath);

      if (hasLegacyData) {
        // Flush committed SQLite WAL pages into the primary file before copy.
        core.checkpointDb(legacyDbPath);
        migWindow.webContents.send("migration:progress", { step: "Copying database...", percent: 10 });
        const targetDbPath = join(targetPath, "progress-ledger-v2.db");
        await cp(legacyDbPath, targetDbPath);

        migWindow.webContents.send("migration:progress", {
          step: "Verifying database integrity...",
          percent: 20,
        });
        const verifyRes = core.verifyDb(targetDbPath);
        if (!verifyRes.success) {
          throw new Error(`Database verification failed: ${verifyRes.message}`);
        }

        migWindow.webContents.send("migration:progress", { step: "Copying attachments...", percent: 40 });
        const legacyAttachments = join(app.getPath("userData"), "attachments");
        const targetAttachments = join(targetPath, "attachments");
        if (existsSync(legacyAttachments)) {
          await cp(legacyAttachments, targetAttachments, { recursive: true });
        }
      }

      const wsJsonPath = join(targetPath, "workspace.json");
      await writeFile(
        wsJsonPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            workspaceId: randomUUID(),
            createdAt: new Date().toISOString(),
            appVersion: app.getVersion(),
          },
          null,
          2
        )
      );

      setActiveWorkspace(targetPath);
      switchWorkspace(targetPath);

      if (hasLegacyData) {
        const getUniqueMigratedPath = (originalPath) => {
          let target = `${originalPath}.migrated`;
          let counter = 1;
          while (existsSync(target)) {
            target = `${originalPath}.migrated-${counter++}`;
          }
          return target;
        };
        renameSync(legacyDbPath, getUniqueMigratedPath(legacyDbPath));
      }

      migWindow.webContents.send("migration:progress", { step: "Done!", percent: 100 });
      isResolved = true;
      setTimeout(() => {
        selectedMigrationPath = null;
      ipcMain.removeHandler("migration:select-dir");
        ipcMain.removeHandler("migration:cancel");
        ipcMain.removeHandler("migration:start");
        migWindow.close();
        resolve();
      }, 1000);
      return { ok: true };
    });

    migWindow.on("closed", () => {
      selectedMigrationPath = null;
      ipcMain.removeHandler("migration:select-dir");
      ipcMain.removeHandler("migration:cancel");
      ipcMain.removeHandler("migration:start");
      if (!isResolved) {
        // A user closing the migration wizard is cancellation, not an
        // exceptional boot failure. Resolve explicitly so the whenReady
        // continuation can stop without creating an unhandled rejection.
        resolve({ cancelled: true });
        app.quit();
      }
    });
  });
}
