import { globalShortcut } from "electron";

/**
 * Quick capture: Alt+N opens the QuickNote overlay in the renderer, which
 * saves through resources:add-note against the user-picked subject (notes are
 * subject-owned; the old profile-level "notes:quick" inbox was removed —
 * the planner sync deleted its synthetic track, destroying those notes).
 */
export function register({ win, notify }) {
  // Registered here (not in main.js) so the shortcut lives next to the feature.
  globalShortcut.register("Alt+N", () => {
    notify("shortcut:quick-note");
  });
}

export function unregister() {
  globalShortcut.unregister("Alt+N");
}
