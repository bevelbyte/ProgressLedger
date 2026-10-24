import { safeHandle } from "../security/safe-handle.js";
import { ipcMain, dialog } from "electron";
import { donutMapper, clearBrowserBindingsForCfProfile } from "../services/donut-mapping.js";
import { Audit } from "../services/audit/index.js";

export function register({ core, win }) {
  safeHandle("profiles:list", () => core.getProfiles());
  safeHandle("profiles:add", (_evt, { name, slug }) => {
    const r = core.addProfile(name, slug);
    const id = typeof r === "number" ? r : r && typeof r.id === "number" ? r.id : null;
    // Creating a profile is the act that creates every ownership boundary in
    // the app, so it belongs on the security record.
    Audit.log({
      event: "profile.create",
      profileId: id,
      projectId: null,
      agentId: null,
      tool: null,
      input_summary: typeof name === "string" ? name : null,
      result: "ok",
      durationMs: null,
      detail: null,
    });
    return r;
  });
  safeHandle("profiles:delete", async (_evt, id) => {
    const result = await core.deleteProfile(id);
    // This is the most destructive operation in the product: it removes an
    // entire profile and every row scoped to it. It was previously invisible
    // on the security record, so after the fact there was no way to tell a
    // profile had ever existed. Logged BEFORE the mapping cleanup so the
    // event is recorded even if a cleanup step misbehaves.
    Audit.log({
      event: "profile.delete",
      profileId: typeof id === "number" ? id : null,
      projectId: null,
      agentId: null,
      tool: null,
      input_summary: null,
      result: result && result.ok === false ? "fail" : "ok",
      durationMs: null,
      detail: null,
    });
    // Lifecycle hook: a Donut mapping must not outlive its CareerFlow
    // profile, and neither may its browser-profile bindings. The CFâ†’Donut
    // identity is dropped from the mapping store AND every bfc-<localId>
    // entry whose owner column matches this cf profile is purged from the
    // browser-binding store. Best-effort â€” never masks the deletion result
    // (these are machine-local caches; orphaned entries are inert but we'd
    // rather not leave them around).
    try {
      await donutMapper.clearMapping(id);
    } catch {
      // mapping store issues must not fail profile deletion
    }
    try {
      await clearBrowserBindingsForCfProfile(id);
    } catch {
      // binding store issues must not fail profile deletion
    }
    return result;
  });

  safeHandle("profiles:export", async (_e, { profileId, slug }) => {
    const res = await dialog.showSaveDialog(win(), {
      title: "Export Profile Bundle",
      defaultPath: `${slug || "profile"}.cfprofile`,
      filters: [{ name: "CareerFlow Profile", extensions: ["cfprofile"] }],
    });
    if (res.canceled || !res.filePath) return { exported: false };
    const path = await core.exportProfile(profileId, res.filePath);
    return { exported: true, path };
  });

  safeHandle("profiles:import", async () => {
    const res = await dialog.showOpenDialog(win(), {
      title: "Import Profile Bundle",
      properties: ["openFile"],
      filters: [{ name: "CareerFlow Profile", extensions: ["cfprofile", "zip"] }],
    });
    if (res.canceled || res.filePaths.length === 0) return { imported: false };
    const profile = await core.importProfile(res.filePaths[0]);
    return { imported: true, profile };
  });
}
