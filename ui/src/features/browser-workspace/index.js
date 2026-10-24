// Public surface of the browser-workspace feature.
//
// C2 (plan Phase 7, 2026-10-08): the BrowserWorkspaceDock and its
// ResizeHandle are RETIRED -- the dock was a persistent right-hand pane that
// rendered the Donut browser as if it were CareerFlow UI, which is exactly
// the "foreign browser as CareerFlow content" idea `integrated` mode died
// for. The Donut readout lives in the Research console
// (features/browser/components/BrowserManagerPanel.svelte), and the
// external-control backend this store still fronts is untouched:
// browser-workspace-tools.js -> browser-workspace.js -> cdp-adapter ->
// Donut Local API + CDP.
//
// What survives here is the STORE: the sanitized state mirror
// (status / tabs / activity / backend facts) that the Research console's
// live-workspace and operator-activity panels read, plus the launch /
// navigate / tab / screenshot actions behind the console's controls.

export {
  browserWorkspace,
  open,
  close,
  toggle,
  refresh,
  connectActivityFeed,
  disconnectActivityFeed,
  openInDonut,
  launch,
  navigate,
  newTab,
  closeTab,
  activateTab,
  reload,
  back,
  forward,
  screenshot,
  __resetForTests,
} from "../../shared/stores/browser-workspace.svelte.js";