import { shell } from "electron";
import { safeHandle } from "../security/safe-handle.js";

// System browser opener for subject links. Only http(s) URLs are accepted;
// anything else (file:, internal schemes, javascript:) is refused, and the
// renderer never learns more than whether the open succeeded.
export function register() {
  safeHandle("system:open-external", async (_event, { url }) => {
    try {
      const parsed = new URL(String(url));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { opened: false };
      await shell.openExternal(parsed.toString());
      return { opened: true };
    } catch {
      return { opened: false };
    }
  });
}
