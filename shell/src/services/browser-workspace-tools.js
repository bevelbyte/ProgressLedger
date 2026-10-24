// Compatibility tool names for the retired Donut page-control integration.
//
// Donut's supported Local API does not expose tab enumeration, page inspection,
// screenshots, click/type input, or page navigation. These names remain
// registered so older agent plans receive a stable, honest refusal instead of
// an unknown-tool error or a fabricated result. They never call browser, CDP,
// process, HWND/PID, or workspace operations.

import { register as registerTool, unregister as unregisterTool } from "./project-tools/index.js";
import { errorEnvelope } from "./project-tools/_runtime.js";

export const UNSUPPORTED_DONUT_TOOL_NAMES = Object.freeze([
  "browser_get_state",
  "browser_launch",
  "browser_stop",
  "browser_navigate",
  "browser_new_tab",
  "browser_close_tab",
  "browser_activate_tab",
  "browser_screenshot",
  "browser_get_page",
  "browser_extract_text",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_wait",
]);

export const UNSUPPORTED_DONUT_TOOL_MESSAGE =
  "Donut page/tab control is unavailable through its supported Local API. Use Saved Places to open a managed profile or URL, or use CareerFlow's embedded browser.";

const DESCRIPTIONS = Object.freeze({
  browser_get_state: "Donut page/tab state is unsupported; the Local API does not enumerate tabs.",
  browser_launch: "Donut page-control workspace launch is unsupported; use Browser Manager for explicit profile launch.",
  browser_stop: "Donut page-control workspace stop is unsupported.",
  browser_navigate: "Donut tab navigation is unsupported; use a saved URL/shortcut.",
  browser_new_tab: "Creating a Donut tab is unsupported through the Local API.",
  browser_close_tab: "Closing a Donut tab is unsupported through the Local API.",
  browser_activate_tab: "Activating a Donut tab is unsupported through the Local API.",
  browser_screenshot: "Capturing a Donut tab screenshot is unsupported through the Local API.",
  browser_get_page: "Inspecting a Donut page is unsupported through the Local API.",
  browser_extract_text: "Extracting text from a Donut page is unsupported through the Local API.",
  browser_click: "Clicking an element in a Donut page is unsupported through the Local API.",
  browser_type: "Typing into a Donut page is unsupported through the Local API.",
  browser_press_key: "Sending keys to a Donut page is unsupported through the Local API.",
  browser_wait: "Waiting for a Donut page selector is unsupported through the Local API.",
});

function unsupportedTool(name) {
  return {
    name,
    description: DESCRIPTIONS[name],
    permission: "READ",
    timeoutMs: 5_000,
    inputSchema: { type: "object", additionalProperties: true },
    async execute() {
      return errorEnvelope("feature-not-supported", UNSUPPORTED_DONUT_TOOL_MESSAGE);
    },
  };
}

/** Register legacy names as local, side-effect-free refusals. */
export function registerUnsupportedDonutTools() {
  for (const name of UNSUPPORTED_DONUT_TOOL_NAMES) registerTool(unsupportedTool(name));
  return () => {
    for (const name of UNSUPPORTED_DONUT_TOOL_NAMES) unregisterTool(name);
  };
}
