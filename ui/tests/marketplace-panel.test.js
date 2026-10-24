// MarketplacePanel — UI tests.
//
// Coverage:
//   - renders the list of installed items from the mock
//   - renders install forms (local path + git URL)
//   - install-from-git submits a Git URL → calls installGit
//   - disable button calls disable on the correct item
//
// The IPC namespace is mocked via window.progressLedger.marketplace. Tests
// reset window.progressLedger between cases for hermetic isolation.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import MarketplacePanel from "../src/features/project-mode/components/MarketplacePanel.svelte";

function setupIpc({
  items = [],
  listImpl = null,
  installGitImpl = null,
  installLocalImpl = null,
  enableImpl = null,
  disableImpl = null,
  uninstallImpl = null,
  updateImpl = null,
} = {}) {
  const list = vi.fn(listImpl || (async () => ({ ok: true, items })));
  const installLocal = vi.fn(installLocalImpl || (async () => ({ ok: true, id: "new-item" })));
  const installGit = vi.fn(installGitImpl || (async () => ({ ok: true, id: "git-item", version: "1.0.0" })));
  const enable = vi.fn(enableImpl || (async () => ({ ok: true })));
  const disable = vi.fn(disableImpl || (async () => ({ ok: true })));
  const uninstall = vi.fn(uninstallImpl || (async () => ({ ok: true })));
  const update = vi.fn(updateImpl || (async () => ({ ok: true })));
  const get = vi.fn(async () => ({ ok: false, reason: "unknown-item" }));

  window.progressLedger = {
    marketplace: { list, installLocal, installGit, enable, disable, uninstall, update, get },
  };
  return { list, installLocal, installGit, enable, disable, uninstall, update };
}

beforeEach(() => {
  // jsdom does not implement window.confirm by default — stub it so the
  // uninstall button's confirmation step does not throw or block.
  window.confirm = () => true;
});

afterEach(() => {
  cleanup();
  delete window.progressLedger;
});

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

describe("MarketplacePanel — list rendering", () => {
  it("renders the list of installed items from the mock", async () => {
    setupIpc({
      items: [
        {
          id: "alpha",
          name: "Alpha Plugin",
          version: "1.2.3",
          enabled: true,
          source: { kind: "local", path: "/tmp/alpha" },
          skills: ["alpha-skill"],
          tools: [],
          mcpServers: [],
        },
        {
          id: "beta",
          name: "Beta Plugin",
          version: "0.4.0",
          enabled: false,
          source: { kind: "git", url: "https://github.com/owner/beta.git", ref: "main" },
          skills: ["beta-skill"],
          tools: ["beta-tool"],
          mcpServers: ["beta-mcp"],
        },
      ],
    });
    render(MarketplacePanel);
    const rendered = await screen.findAllByTestId("marketplace-item");
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toHaveTextContent("Alpha Plugin");
    expect(rendered[1]).toHaveTextContent("Beta Plugin");
    // Type pills reflect the derived extension types.
    expect(screen.getAllByTestId("item-types")[0]).toHaveTextContent("Skill");
    expect(screen.getAllByTestId("item-types")[1]).toHaveTextContent("MCP");
    // Source labels are surfaced (without leaking git install_path).
    expect(rendered[0]).toHaveTextContent("/tmp/alpha");
    expect(rendered[1]).toHaveTextContent("https://github.com/owner/beta.git");
  });

  it("shows the empty-state hint when no items are installed", async () => {
    setupIpc({ items: [] });
    render(MarketplacePanel);
    await waitFor(() => expect(screen.getByTestId("marketplace-empty")).toBeInTheDocument());
    expect(screen.getByText(/No marketplace items installed yet/i)).toBeInTheDocument();
    // Install forms remain visible in the empty state.
    expect(screen.getByTestId("install-local-form")).toBeInTheDocument();
    expect(screen.getByTestId("install-git-form")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Install forms
// ---------------------------------------------------------------------------

describe("MarketplacePanel — install forms", () => {
  it("renders install buttons for both local and git flows", async () => {
    setupIpc();
    render(MarketplacePanel);
    expect(screen.getByTestId("install-local-btn")).toBeInTheDocument();
    expect(screen.getByTestId("install-git-btn")).toBeInTheDocument();
    expect(screen.getByTestId("install-local-path")).toBeInTheDocument();
    expect(screen.getByTestId("install-git-url")).toBeInTheDocument();
    expect(screen.getByTestId("install-git-ref")).toBeInTheDocument();
  });

  it("install-from-git submits a Git URL → calls installGit with ref HEAD", async () => {
    const { installGit, list } = setupIpc();
    render(MarketplacePanel);
    fireEvent.input(screen.getByTestId("install-git-url"), {
      target: { value: "https://github.com/owner/foo.git" },
    });
    fireEvent.input(screen.getByTestId("install-git-ref"), {
      target: { value: "main" },
    });
    fireEvent.click(screen.getByTestId("install-git-btn"));
    await waitFor(() => expect(installGit).toHaveBeenCalledTimes(1));
    expect(installGit).toHaveBeenCalledWith(
      "https://github.com/owner/foo.git",
      "main",
    );
    // After install the panel refreshes the item list.
    expect(list).toHaveBeenCalled();
  });

  it("install-from-local submits a path → calls installLocal", async () => {
    const { installLocal } = setupIpc();
    render(MarketplacePanel);
    fireEvent.input(screen.getByTestId("install-local-path"), {
      target: { value: "/tmp/my-plugin" },
    });
    fireEvent.click(screen.getByTestId("install-local-btn"));
    await waitFor(() => expect(installLocal).toHaveBeenCalledTimes(1));
    expect(installLocal).toHaveBeenCalledWith("/tmp/my-plugin");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle actions
// ---------------------------------------------------------------------------

describe("MarketplacePanel — lifecycle actions", () => {
  it("disable button calls marketplace.disable on the correct item id", async () => {
    const { disable } = setupIpc({
      items: [
        {
          id: "alpha",
          name: "Alpha",
          version: "1.0.0",
          enabled: true,
          source: { kind: "local", path: "/tmp/alpha" },
          skills: [],
          tools: [],
          mcpServers: [],
        },
      ],
    });
    render(MarketplacePanel);
    // When enabled, the per-item button is "Disable".
    const disableBtn = await screen.findByTestId("item-disable");
    fireEvent.click(disableBtn);
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
    expect(disable).toHaveBeenCalledWith("alpha");
  });

  it("enable button appears for a disabled item and calls marketplace.enable", async () => {
    const { enable } = setupIpc({
      items: [
        {
          id: "beta",
          name: "Beta",
          version: "1.0.0",
          enabled: false,
          source: { kind: "local", path: "/tmp/beta" },
          skills: [],
          tools: [],
          mcpServers: [],
        },
      ],
    });
    render(MarketplacePanel);
    const enableBtn = await screen.findByTestId("item-enable");
    fireEvent.click(enableBtn);
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
    expect(enable).toHaveBeenCalledWith("beta");
  });

  it("uninstall button calls marketplace.uninstall with the item id", async () => {
    const { uninstall } = setupIpc({
      items: [
        {
          id: "alpha",
          name: "Alpha",
          version: "1.0.0",
          enabled: false,
          source: { kind: "local", path: "/tmp/alpha" },
          skills: [],
          tools: [],
          mcpServers: [],
        },
      ],
    });
    render(MarketplacePanel);
    const uninstallBtn = await screen.findByTestId("item-uninstall");
    fireEvent.click(uninstallBtn);
    await waitFor(() => expect(uninstall).toHaveBeenCalledTimes(1));
    expect(uninstall).toHaveBeenCalledWith("alpha");
  });
});