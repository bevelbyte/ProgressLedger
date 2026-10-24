import { safeHandle } from "../security/safe-handle.js";
import { ipcMain } from "electron";

export function register({ core }) {
  safeHandle("formulas:list", (_e, { profileId, subjectId, category }) =>
    core.getFormulas(profileId, subjectId ?? null, category ?? null)
  );
  safeHandle("formulas:add", (_e, { profileId, subjectId, title, latexContent, category }) =>
    core.addFormula(profileId, subjectId, title, latexContent, category ?? null)
  );
  safeHandle("formulas:update", (_e, { profileId, id, title, latexContent, category }) =>
    core.updateFormula(profileId, id, title, latexContent, category ?? null)
  );
  safeHandle("formulas:delete", (_e, { profileId, id }) => core.deleteFormula(profileId, id));
}
