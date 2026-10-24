import { register as registerCore } from "./core-channels.js";
import { register as registerProfiles } from "./profiles.js";
import { register as registerAcademic } from "./academic.js";
import { register as registerResources } from "./resources.js";
import { register as registerDashboard } from "./dashboard.js";
import { register as registerDeadlines } from "./deadlines.js";
import { register as registerMistakes } from "./mistakes.js";
import { register as registerCards } from "./cards.js";
import { register as registerLinks } from "./links.js";
import { register as registerCourses } from "./courses.js";
import { register as registerLabs } from "./labs.js";
import { register as registerProjects } from "./projects.js";
import { register as registerFormulas } from "./formulas.js";
import { register as registerNotes } from "./notes.js";
import { register as registerSessions } from "./sessions.js";
import { register as registerCareer } from "./career.js";
import { register as registerBackups } from "./backups.js";
import { register as registerCloud } from "./cloud.js";
import { register as registerSync } from "./sync.js";
import { register as registerDiagnostics } from "./diagnostics.js";
import { register as registerUpdates } from "./updates.js";
import { register as registerDonut } from "./donut.js";
import { register as registerBrowserManager } from "./browser-manager.js";
import { register as registerFocusSignals } from "./focus-signals.js";
import { register as registerBrowserWorkspace } from "./browser-workspace.js";
import { register as registerProjectTools } from "./project-tools.js";
import { register as registerProjectMode } from "./project-mode.js";
import { register as registerSkillsPluginsMcp } from "./skills-plugins-mcp.js";
import { register as registerMarketplace } from "./marketplace.js";
import { register as registerProjectIntel } from "./project-intel.js";
import { registerDiffIpc } from "./diff.js";
import { registerSubAgentDiffIpc } from "./subagent-diff.js";
import { register as registerCommandsHooks } from "./commands-hooks.js";
import { register as registerMemory } from "./memory.js";
import { register as registerAudit } from "./audit.js";
import { register as registerGoals } from "./goals.js";
import { register as registerBrowser } from "./browser.js";
import { register as registerResearch } from "./research.js";

/**
 * IPC registrars. Each module exports register(ctx) where ctx = {
 *   core    – the loaded @careerflow/core native addon,
 *   win     – () => BrowserWindow (may be null),
 *   notify  – (channel, payload) => webContents.send guarded on window existence,
 * }.
 *
 * Every channel invoked by shell/src/preload.cjs MUST have a handler here.
 * scripts/check-ipc.mjs enforces preload ↔ main parity.
 */
export function makeIpcContext({ core, getWindow, app }) {
  return {
    core,
    win: getWindow,
    app,
    notify(channel, payload) {
      const w = getWindow();
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    },
  };
}

export function registerAllIpc(ctx) {
  registerCore(ctx);
  registerProfiles(ctx);
  registerAcademic(ctx);
  registerResources(ctx);
  registerDashboard(ctx);
  registerDeadlines(ctx);
  registerMistakes(ctx);
  registerCards(ctx);
  registerLinks(ctx);
  registerCourses(ctx);
  registerLabs(ctx);
  registerProjects(ctx);
  registerFormulas(ctx);
  registerNotes(ctx);
  registerSessions(ctx);
  registerCareer(ctx);
  registerBackups(ctx);
  registerCloud(ctx);
  registerSync(ctx);
  registerDiagnostics(ctx);
  registerUpdates(ctx);
  registerDonut(ctx);
  registerBrowserManager(ctx);
  registerFocusSignals(ctx);
  registerBrowserWorkspace(ctx);
  registerProjectTools(ctx);
  registerProjectMode(ctx);
  registerSkillsPluginsMcp(ctx);
  registerMarketplace(ctx);
  registerProjectIntel(ctx);
  registerCommandsHooks(ctx);
  registerMemory(ctx);
  registerDiffIpc(ctx);
  registerSubAgentDiffIpc(ctx);
  registerAudit(ctx);
  registerGoals(ctx);
  // The CareerFlow-owned embedded browser (D2-D6 plan, Phase 1). Registered
  // last on purpose: it is the newest surface and shares nothing with any
  // earlier registrar.
  registerBrowser(ctx);
  registerResearch(ctx);
}
