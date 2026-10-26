import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Overlay guard (V2-43, Phase 4): a WebContentsView paints above ALL
// renderer DOM, so ANY overlay that can own the screen must join
// App's one `occluded` flag, which main turns into hiding every
// native view. A missing line here is a real bug: the view would
// paint over the dialog/toast/menu and the user could not click it.
// Source test (engine-guard precedent): App.svelte is not
// unit-renderable, so the test reads the sources.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

describe("overlay guard (V2-43)", () => {
  it("App occluded includes every overlay source", () => {
    const app = stripComments(read("ui/src/App.svelte"));
    const m = app.match(/const occluded = \$derived\(([\s\S]*?)\);/);
    assert.ok(m, "App must define occluded as a $derived");
    const flag = m[1];
    for (const source of [
      "operator.consoleOpen",
      "newTabMenuOpen",
      "keyboardHelpOpen",
      "onboarding.active",
      "commandPaletteOpen",
      "arrangeMenuOpen",
      "noteEditor.open",
      "quickNoteOpen",
      "focusOpen",
      "toastState.items.length",
      "toastState.confirm",
      "browserDialogOpen",
    ]) {
      assert.ok(flag.includes(source), `occluded must include ${source}`);
    }
    assert.ok(
      app.includes("toastState") && app.includes('from "./shared/stores/toasts.svelte.js"'),
      "App must import toastState from the toasts store",
    );
    assert.ok(app.includes("onBrowserOverlayChange"), "viewDeps must carry onBrowserOverlayChange");
  });

  it("pane views forward the browser-dialog flag to App", () => {
    const paneView = stripComments(read("ui/src/shell/PaneView.svelte"));
    assert.ok(paneView.includes("onBrowserOverlayChange"), "PaneView must declare onBrowserOverlayChange");
    assert.ok(
      paneView.includes("{onBrowserOverlayChange}"),
      "PaneView must pass onBrowserOverlayChange to the browser views",
    );
    const surface = stripComments(read("ui/src/features/browser/components/BrowserSurface.svelte"));
    assert.ok(
      surface.includes("onBrowserOverlayChange(showNewProfile"),
      "BrowserSurface must report its new-profile dialog state",
    );
    const profiles = stripComments(read("ui/src/features/browser/components/BrowserProfiles.svelte"));
    assert.ok(
      profiles.includes("onBrowserOverlayChange(dialog") && profiles.includes("deleteTarget"),
      "BrowserProfiles must report its dialog and delete-confirm state",
    );
  });
});
