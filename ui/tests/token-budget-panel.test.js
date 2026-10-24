// TokenBudgetPanel — UI tests.
//
// Coverage:
//   - renders the empty state when no agentId is supplied
//   - renders current / cap / used% / last-updated after a successful IPC call
//   - colour-codes the bar by usedPct: <50% ok, 50-80% warn, >80% danger
//   - renders "no limit" when cap is 0 (budget module contract)
//   - polls every 5 seconds (fake timers advance the interval)
//
// The IPC namespace is mocked on window.progressLedger.projectMode, mirroring
// the shape shipped by shell/src/preload.cjs + shell/src/ipc/project-mode.js.

import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import TokenBudgetPanel from "../src/features/project-mode/components/TokenBudgetPanel.svelte";

const NOW = 1_700_000_000_000; // fixed timestamp for the lastUpdated field

function setupIpc({
  budget = { current: 50_000, cap: 200_000, usedPct: 25, lastUpdated: NOW },
  getBudgetImpl = null,
  error = null,
} = {}) {
  const getBudget = getBudgetImpl
    ? getBudgetImpl
    : vi.fn().mockResolvedValue({ ok: true, ...budget });
  window.progressLedger = {
    projectMode: { getBudget },
  };
  return { getBudget, error };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.progressLedger = undefined;
});

// ---------------------------------------------------------------------------
// Rendering — happy path
// ---------------------------------------------------------------------------

describe("TokenBudgetPanel — rendering", () => {
  it("renders the progress bar, current, cap, used% and last-updated", async () => {
    setupIpc();
    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 42 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("token-budget-panel")).toBeInTheDocument();
    expect(screen.getByTestId("token-budget-bar")).toBeInTheDocument();
    expect(screen.getByTestId("token-budget-fill")).toBeInTheDocument();
    // Current tokens
    expect(screen.getByTestId("token-budget-current")).toHaveTextContent("50,000");
    // Cap
    expect(screen.getByTestId("token-budget-cap")).toHaveTextContent("200,000");
    // Used % (one decimal place)
    expect(screen.getByTestId("token-budget-used-pct")).toHaveTextContent("25.0%");
    // Last updated (locale time string — at least the digits of the hour/minute)
    const updated = screen.getByTestId("token-budget-updated");
    expect(updated).toBeInTheDocument();
    expect(updated.textContent).toMatch(/Updated/);
    // State pill
    expect(screen.getByTestId("token-budget-state")).toHaveTextContent("ok");
  });

  it("renders the empty state when no agentId is supplied", async () => {
    setupIpc();
    render(TokenBudgetPanel, { props: { profileId: 1, agentId: null } });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("token-budget-empty")).toBeInTheDocument();
    expect(screen.getByTestId("token-budget-empty")).toHaveTextContent(/No active agent/i);
    expect(screen.queryByTestId("token-budget-bar")).not.toBeInTheDocument();
    expect(screen.getByTestId("token-budget-state")).toHaveTextContent("idle");
  });

  it("renders the error state when the IPC returns ok: false", async () => {
    setupIpc({ getBudgetImpl: vi.fn().mockResolvedValue({ ok: false, error: "agent-not-found" }) });
    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 42 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("token-budget-error")).toBeInTheDocument();
    expect(screen.getByTestId("token-budget-error")).toHaveTextContent("agent-not-found");
    expect(screen.queryByTestId("token-budget-bar")).not.toBeInTheDocument();
    expect(screen.getByTestId("token-budget-state")).toHaveTextContent("error");
  });
});

// ---------------------------------------------------------------------------
// Colour coding
// ---------------------------------------------------------------------------

describe("TokenBudgetPanel — colour coding", () => {
  it("renders the ok (green) class when usedPct < 50", async () => {
    setupIpc({ budget: { current: 50_000, cap: 200_000, usedPct: 25, lastUpdated: NOW } });
    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 42 } });
    await vi.advanceTimersByTimeAsync(0);

    const fill = screen.getByTestId("token-budget-fill");
    expect(fill.dataset.color).toBe("ok");
    expect(fill.className).toContain("progress-ok");
  });

  it("renders the warn (yellow) class when 50 <= usedPct < 80", async () => {
    setupIpc({ budget: { current: 100_000, cap: 200_000, usedPct: 60, lastUpdated: NOW } });
    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 42 } });
    await vi.advanceTimersByTimeAsync(0);

    const fill = screen.getByTestId("token-budget-fill");
    expect(fill.dataset.color).toBe("warn");
    expect(fill.className).toContain("progress-warn");
    expect(screen.getByTestId("token-budget-state")).toHaveTextContent("warn");
  });

  it("renders the danger (red) class when usedPct >= 80", async () => {
    setupIpc({ budget: { current: 170_000, cap: 200_000, usedPct: 85, lastUpdated: NOW } });
    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 42 } });
    await vi.advanceTimersByTimeAsync(0);

    const fill = screen.getByTestId("token-budget-fill");
    expect(fill.dataset.color).toBe("danger");
    expect(fill.className).toContain("progress-danger");
    expect(screen.getByTestId("token-budget-state")).toHaveTextContent("danger");
  });
});

// ---------------------------------------------------------------------------
// No-limit mode
// ---------------------------------------------------------------------------

describe("TokenBudgetPanel — no-limit mode", () => {
  it("renders 'no limit' for the cap and '—' for the used% when cap is 0", async () => {
    setupIpc({ budget: { current: 25_000, cap: 0, usedPct: 0, lastUpdated: NOW } });
    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 42 } });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("token-budget-cap")).toHaveTextContent("no limit");
    expect(screen.getByTestId("token-budget-used-pct")).toHaveTextContent("—");
    // The bar still renders, but with 0% width and a stable ok colour.
    const fill = screen.getByTestId("token-budget-fill");
    expect(fill.dataset.color).toBe("ok");
    expect(fill.style.width).toBe("0%");
    expect(screen.getByTestId("token-budget-state")).toHaveTextContent("no limit");
  });
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

describe("TokenBudgetPanel — polling", () => {
  it("calls getBudget again after 5 seconds (the polling interval)", async () => {
    const getBudget = vi.fn().mockResolvedValue({ ok: true, current: 10_000, cap: 200_000, usedPct: 5, lastUpdated: NOW });
    window.progressLedger = { projectMode: { getBudget } };

    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 42 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(getBudget).toHaveBeenCalledTimes(1);

    // Advance one polling interval — the second call fires.
    await vi.advanceTimersByTimeAsync(5000);
    expect(getBudget).toHaveBeenCalledTimes(2);

    // And a third tick — the loop is alive, not a one-shot setTimeout.
    await vi.advanceTimersByTimeAsync(5000);
    expect(getBudget).toHaveBeenCalledTimes(3);
  });

  it("updates the displayed numbers when a polled refresh returns new data", async () => {
    let next = { ok: true, current: 10_000, cap: 200_000, usedPct: 5, lastUpdated: NOW };
    const getBudget = vi.fn(() => Promise.resolve({ ...next }));
    window.progressLedger = { projectMode: { getBudget } };

    render(TokenBudgetPanel, { props: { profileId: 1, agentId: 42 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId("token-budget-current")).toHaveTextContent("10,000");

    // Simulate the agent consuming more tokens between polls.
    next = { ok: true, current: 170_000, cap: 200_000, usedPct: 85, lastUpdated: NOW + 1000 };
    await vi.advanceTimersByTimeAsync(5000);

    expect(screen.getByTestId("token-budget-current")).toHaveTextContent("170,000");
    expect(screen.getByTestId("token-budget-used-pct")).toHaveTextContent("85.0%");
    const fill = screen.getByTestId("token-budget-fill");
    expect(fill.dataset.color).toBe("danger");
  });
});
