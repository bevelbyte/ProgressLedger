// PluginInventory — UI tests.
//
// Coverage:
//   - renders one row per plugin from window.progressLedger.extensions.listPlugins()
//   - enabled toggle button reflects plugin.enabled state
//   - clicking toggle calls enablePlugin / disablePlugin and updates state
//   - reload button calls reloadPlugin
//   - capability pills render for skills / tools / mcpServers
//   - click row expands manifest preview
//   - empty / failure states render correctly
//
// The IPC namespace is mocked via window.progressLedger.extensions. Tests
// reset window.progressLedger between cases for hermetic isolation.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, afterEach } from "vitest";

import PluginInventory from "../src/features/project-mode/components/PluginInventory.svelte";

const SAMPLE_PLUGINS = [
  {
    id: "ponytail",
    name: "Ponytail",
    version: "4.9.0",
    skills: ["ponytail", "ponytail-audit", "ponytail-debt"],
    tools: ["ponytail-lint"],
    mcpServers: [],
    enabled: true,
  },
  {
    id: "superpowers",
    name: "Superpowers",
    version: "6.3.0",
    skills: ["brainstorming", "writing-plans", "systematic-debugging"],
    tools: [],
    mcpServers: ["mcp-superpowers"],
    enabled: false,
  },
  {
    id: "minimal-plugin",
    name: "Minimal Plugin",
    version: "1.0.0",
    skills: [],
    tools: [],
    mcpServers: [],
    enabled: false,
  },
];

function setupIpc({
  plugins = SAMPLE_PLUGINS,
  listImpl = null,
  enableImpl = null,
  disableImpl = null,
  reloadImpl = null,
} = {}) {
  const list = vi.fn(listImpl || (async () => ({ ok: true, plugins })));
  const enable = vi.fn(enableImpl || (async (id) => ({ ok: true })));
  const disable = vi.fn(disableImpl || (async (id) => ({ ok: true })));
  const reload = vi.fn(reloadImpl || (async (id) => ({ ok: true, plugin: plugins.find((p) => p.id === id) })));

  window.progressLedger = {
    extensions: { listPlugins: list, enablePlugin: enable, disablePlugin: disable, reloadPlugin: reload },
  };
  return { list, enable, disable, reload };
}

afterEach(() => {
  cleanup();
  delete window.progressLedger;
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("PluginInventory — rendering", () => {
  it("renders one row per plugin returned by the IPC listPlugins() call", async () => {
    setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    const rows = await screen.findAllByTestId("plugin-row");
    expect(rows).toHaveLength(SAMPLE_PLUGINS.length);
    const ids = rows.map((r) => r.querySelector(".cell-id").textContent);
    expect(ids).toEqual(expect.arrayContaining(["ponytail", "superpowers", "minimal-plugin"]));
  });

  it("shows version in each row", async () => {
    setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    await screen.findAllByTestId("plugin-row");
    expect(screen.getByText("v4.9.0")).toBeInTheDocument();
    expect(screen.getByText("v6.3.0")).toBeInTheDocument();
  });

  it("renders capability pills for skills, tools, and MCP servers", async () => {
    setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    await screen.findAllByTestId("plugin-row");
    // ponytail has skills + tools
    const ponytailRow = screen.getAllByTestId("plugin-row").find((r) => r.dataset.pluginId === "ponytail");
    expect(ponytailRow.querySelector('[data-plugin-cap="Skill"]')).toBeInTheDocument();
    expect(ponytailRow.querySelector('[data-plugin-cap="Tool"]')).toBeInTheDocument();
    // superpowers has skills + mcpServers
    const spRow = screen.getAllByTestId("plugin-row").find((r) => r.dataset.pluginId === "superpowers");
    expect(spRow.querySelector('[data-plugin-cap="Skill"]')).toBeInTheDocument();
    expect(spRow.querySelector('[data-plugin-cap="MCP"]')).toBeInTheDocument();
    // minimal-plugin has no capabilities → muted dash
    const minRow = screen.getAllByTestId("plugin-row").find((r) => r.dataset.pluginId === "minimal-plugin");
    expect(minRow.querySelector(".muted")).toBeInTheDocument();
  });

  it("reflects enabled state on toggle buttons", async () => {
    setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    await screen.findAllByTestId("plugin-row");
    const ponytailToggle = screen.getAllByTestId("plugin-toggle").find((b) => b.dataset.pluginId === "ponytail");
    expect(ponytailToggle).toHaveClass("enabled");
    expect(ponytailToggle).toHaveTextContent("On");
    const spToggle = screen.getAllByTestId("plugin-toggle").find((b) => b.dataset.pluginId === "superpowers");
    expect(spToggle).not.toHaveClass("enabled");
    expect(spToggle).toHaveTextContent("Off");
  });

  it("renders a reload button per row", async () => {
    setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    await screen.findAllByTestId("plugin-row");
    const reloadBtns = screen.getAllByTestId("plugin-reload");
    expect(reloadBtns).toHaveLength(SAMPLE_PLUGINS.length);
    expect(reloadBtns.find((b) => b.dataset.pluginId === "ponytail")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Toggle enable / disable
// ---------------------------------------------------------------------------

describe("PluginInventory — toggle enable / disable", () => {
  it("calls disablePlugin when toggling an enabled plugin off", async () => {
    const { disable } = setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    const toggle = (await screen.findAllByTestId("plugin-toggle")).find((b) => b.dataset.pluginId === "ponytail");
    expect(toggle).toHaveClass("enabled");
    fireEvent.click(toggle);
    await waitFor(() => expect(disable).toHaveBeenCalledWith("ponytail", 7));
    // Button flips to Off after state update
    await waitFor(() => expect(toggle).not.toHaveClass("enabled"));
    await waitFor(() => expect(toggle).toHaveTextContent("Off"));
  });

  it("calls enablePlugin when toggling a disabled plugin on", async () => {
    const { enable } = setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    const toggle = (await screen.findAllByTestId("plugin-toggle")).find((b) => b.dataset.pluginId === "superpowers");
    expect(toggle).not.toHaveClass("enabled");
    fireEvent.click(toggle);
    await waitFor(() => expect(enable).toHaveBeenCalledWith("superpowers", 7));
    await waitFor(() => expect(toggle).toHaveClass("enabled"));
    await waitFor(() => expect(toggle).toHaveTextContent("On"));
  });

  it("disables the toggle button while the operation is in flight", async () => {
    let resolveEnable;
    const holdEnable = new Promise((r) => { resolveEnable = r; });
    setupIpc({ enableImpl: async () => { await holdEnable; return { ok: true }; } });
    render(PluginInventory, { props: { profileId: 7 } });
    const toggle = (await screen.findAllByTestId("plugin-toggle")).find((b) => b.dataset.pluginId === "superpowers");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeDisabled());
    resolveEnable();
    await waitFor(() => expect(toggle).not.toBeDisabled());
  });
});

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

describe("PluginInventory — reload", () => {
  it("calls reloadPlugin when the reload button is clicked", async () => {
    const { reload } = setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    const reloadBtn = (await screen.findAllByTestId("plugin-reload")).find((b) => b.dataset.pluginId === "ponytail");
    fireEvent.click(reloadBtn);
    await waitFor(() => expect(reload).toHaveBeenCalledWith("ponytail", 7));
  });

  it("disables the reload button while the operation is in flight", async () => {
    let resolveReload;
    const holdReload = new Promise((r) => { resolveReload = r; });
    setupIpc({ reloadImpl: async () => { await holdReload; return { ok: true, plugin: SAMPLE_PLUGINS[0] }; } });
    render(PluginInventory, { props: { profileId: 7 } });
    const reloadBtn = (await screen.findAllByTestId("plugin-reload")).find((b) => b.dataset.pluginId === "ponytail");
    fireEvent.click(reloadBtn);
    await waitFor(() => expect(reloadBtn).toBeDisabled());
    resolveReload();
    await waitFor(() => expect(reloadBtn).not.toBeDisabled());
  });
});

// ---------------------------------------------------------------------------
// Row expansion — manifest preview
// ---------------------------------------------------------------------------

describe("PluginInventory — manifest preview", () => {
  it("clicking a row expands the manifest preview", async () => {
    setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    const rows = await screen.findAllByTestId("plugin-row");
    expect(screen.queryByTestId("plugin-preview")).not.toBeInTheDocument();
    fireEvent.click(rows[0]);
    const preview = await screen.findByTestId("plugin-preview");
    expect(preview).toBeInTheDocument();
    expect(preview.dataset.pluginId).toBe("ponytail");
  });

  it("clicking the same row again collapses the preview", async () => {
    setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    const rows = await screen.findAllByTestId("plugin-row");
    fireEvent.click(rows[0]);
    await screen.findByTestId("plugin-preview");
    fireEvent.click(rows[0]);
    await waitFor(() => expect(screen.queryByTestId("plugin-preview")).not.toBeInTheDocument());
  });

  it("preview shows name, version, skills, tools, mcpServers, and status", async () => {
    setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    const rows = await screen.findAllByTestId("plugin-row");
    const spRow = rows.find((r) => r.dataset.pluginId === "superpowers");
    fireEvent.click(spRow);
    const preview = await screen.findByTestId("plugin-preview");
    expect(preview.textContent).toContain("Superpowers");
    expect(preview.textContent).toContain("6.3.0");
    expect(preview.textContent).toContain("brainstorming");
    expect(preview.textContent).toContain("mcp-superpowers");
    expect(preview.textContent).toContain("disabled");
  });

  it('preview shows "none" for empty capability lists', async () => {
    setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    const rows = await screen.findAllByTestId("plugin-row");
    const minRow = rows.find((r) => r.dataset.pluginId === "minimal-plugin");
    fireEvent.click(minRow);
    const preview = await screen.findByTestId("plugin-preview");
    // All three lists should show "none"
    const dds = preview.querySelectorAll("dd");
    const noneCount = Array.from(dds).filter((dd) => dd.textContent.trim() === "none").length;
    expect(noneCount).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Empty / failure states
// ---------------------------------------------------------------------------

describe("PluginInventory — empty / failure states", () => {
  it("renders the empty hint when the registry returns no plugins", async () => {
    setupIpc({ plugins: [] });
    render(PluginInventory, { props: { profileId: 7 } });
    await waitFor(() => expect(screen.getByTestId("plugin-inventory-empty")).toBeInTheDocument());
    expect(screen.getByText(/No plugins installed/i)).toBeInTheDocument();
  });

  it("treats a non-ok IPC response as a load failure", async () => {
    setupIpc({ listImpl: async () => ({ ok: false, reason: "no-userdata" }) });
    render(PluginInventory, { props: { profileId: 7 } });
    await waitFor(() => expect(screen.getByTestId("plugin-inventory-load-error")).toBeInTheDocument());
    expect(screen.queryByTestId("plugin-row")).toBeNull();
  });

  it("shows the refresh button and calls listPlugins on click", async () => {
    const { list } = setupIpc();
    render(PluginInventory, { props: { profileId: 7 } });
    const refreshBtn = await screen.findByTestId("plugin-inventory-refresh");
    vi.clearAllMocks();
    fireEvent.click(refreshBtn);
    await waitFor(() => expect(list).toHaveBeenCalled());
  });
});
