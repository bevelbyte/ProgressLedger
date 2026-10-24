import { safeHandle } from "../security/safe-handle.js";
import { ipcMain, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { buildDiagnosticsReport } from "../services/diagnostics.js";
import { logPath, writeLog } from "../services/logger.js";
import { stampForFile } from "../services/local-vault.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { shell } from "electron";

export function register({ core, win }) {
  safeHandle("diagnostics:get-report", async (_e, options = {}) =>
    buildDiagnosticsReport(core, { includeNetwork: Boolean(options.includeNetwork) })
  );

  safeHandle("diagnostics:export-report", async (_e, options = {}) => {
    const report = await buildDiagnosticsReport(core, { includeNetwork: Boolean(options.includeNetwork) });
    const res = await dialog.showSaveDialog(win(), {
      title: "Export CareerFlow Diagnostics",
      defaultPath: `careerflow-diagnostics-${stampForFile()}.json`,
      filters: [{ name: "Diagnostics JSON", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePath) return { exported: false };
    await writeFile(res.filePath, JSON.stringify(report, null, 2), "utf8");
    await writeLog("info", "Diagnostics report exported", { path: res.filePath });
    return { exported: true, path: res.filePath, report };
  });

  safeHandle("diagnostics:open-logs", async () => {
    await writeLog("info", "Opening diagnostics log");
    const err = await shell.openPath(logPath());
    if (err) throw new Error(err);
    return { opened: true, path: logPath() };
  });

  safeHandle("diagnostics:append-log", async (_e, { level, message, detail }) => {
    await writeLog(level || "info", message, detail);
    return true;
  });

  safeHandle("diagnostics:read-log", async () => {
    try {
      if (logPath() && existsSync(logPath())) {
        return await readFile(logPath(), "utf8");
      }
      return "";
    } catch (e) {
      return "Error reading log: " + e.message;
    }
  });
}
