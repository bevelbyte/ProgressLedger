import { safeHandle } from "../security/safe-handle.js";
import { ipcMain, dialog, shell } from "electron";
import { basename, extname } from "node:path";
import { readFile } from "node:fs/promises";

export function register({ core, win }) {
  safeHandle("resources:list", (_e, { profileId, subjectId }) => core.listResources(profileId, subjectId));
  safeHandle("resources:get", (_e, { profileId, id }) => core.getResource(profileId, id));
  safeHandle("resources:add-note", (_e, { profileId, subjectId, title, content }) =>
    core.addNote(profileId, subjectId, title, content)
  );
  safeHandle("resources:update-note", (_e, { profileId, id, title, content }) =>
    core.updateNote(profileId, id, title, content)
  );
  safeHandle("resources:delete", (_e, { profileId, id }) => core.deleteResource(profileId, id));
  safeHandle("resources:search", (_e, { profileId, query }) => core.searchResources(profileId, query));

  // Aggregated single-subject workspace overview.
  safeHandle("subjects:overview", (_e, { profileId, subjectId }) => core.getSubjectOverview(profileId, subjectId));

  // Aggregated whole-semester progress overview.
  safeHandle("semester:overview", (_e, { profileId, semesterId }) => core.getSemesterOverview(profileId, semesterId));

  safeHandle("resources:open-file", async (_e, { profileId, resourceId }) => {
    // Resolve the filesystem path from the database rather than trusting a
    // renderer-supplied absolute path. The DB only ever stores paths the
    // user previously attached, so the resolved value is constrained to
    // either the attachments root or a legacy absolute path the user
    // explicitly added. A renderer compromise cannot coerce shell.openPath
    // into opening an arbitrary location.
    if (!Number.isInteger(resourceId) || resourceId < 0) {
      throw new Error("resource id must be a non-negative integer");
    }
    const res = core.getResource(profileId, resourceId);
    if (!res) throw new Error("resource not found");
    if (res.kind !== "pdf" || !res.filePath) {
      throw new Error("resource is not an openable file");
    }
    const err = await shell.openPath(res.filePath);
    if (err) throw new Error(err);
    return { ok: true };
  });

  safeHandle("resources:attach-file", async (_e, { profileId, subjectId }) => {
    const res = await dialog.showOpenDialog(win(), {
      title: "Attach Note or PDF",
      properties: ["openFile"],
      filters: [{ name: "Documents", extensions: ["pdf", "md", "markdown", "txt"] }],
    });
    if (res.canceled || res.filePaths.length === 0) return { added: false };

    const p = res.filePaths[0];
    if (extname(p).toLowerCase() === ".pdf") {
      const id = await core.attachFile(profileId, subjectId, basename(p), p);
      return { added: true, id, kind: "pdf" };
    }
    const content = await readFile(p, "utf8");
    const id = core.addNote(profileId, subjectId, basename(p), content);
    return { added: true, id, kind: "note" };
  });
}
