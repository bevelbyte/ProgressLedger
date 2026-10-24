// ProviderHealth — UI tests.
//
// Coverage:
//   - renders one row per provider with name, requests, errors, error rate,
//     avg latency and last-429 age after a successful IPC call
//   - renders the empty state when the IPC returns no providers
//   - renders the error state when the IPC returns ok: false
//   - renders the error state when the IPC surface is missing
//   - colour-codes rows: ok (green), warn (any error or a 429 <10 min old),
//     danger (>=25% error rate), idle (0 requests)
//   - the Refresh button re-fetches and re-renders the new numbers
//   - the pure helpers (classifyProviderHealth / formatLatencyMs / formatAgo /
//     providerErrorRate) are exercised directly, no jsdom needed
//
// The IPC namespace is mocked on window.careerflow.projectMode, mirroring
// the shape shipped by shell/src/preload.cjs + shell/src/ipc/project-mode.js
// (`provider:health` → { ok, providers, updatedAt }).

import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import ProviderHealth from "../src/features/project-mode/components/ProviderHealth.svelte";
import {
  classifyProviderHealth,
  providerErrorRate,
  formatLatencyMs,
  formatErrorRate,
  formatAgo,
  formatNumber,
  statusLabel,
  HEALTH_429_WARN_MS,
} from "../src/features/project-mode/lib/providerHealth.js";

const NOW = 1_700_000_000_000;

const OK_ROW = {
  name: "api.openai.com · gpt-4o-mini",
  requests: 20,
  success: 20,
  errors: 0,
  errorRate: 0,
  avgLatencyMs: 412,
  last429: null,
};

function setupIpc({ providers = [OK_ROW], impl = null, updatedAt = NOW } = {}) {
  const getProviderHealth = impl
    ? impl
    : vi.fn().mockResolvedValue({ ok: true, providers, updatedAt });
  window.careerflow = { projectMode: { getProviderHealth } };
  return { getProviderHealth };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.careerflow = undefined;
});

// ---------------------------------------------------------------------------
// Rendering — happy path / empty / error
// ---------------------------------------------------------------------------

describe("ProviderHealth — rendering", () => {
  it("renders one row per provider with requests, errors, rate, latency and last 429", async () => {
    setupIpc();
    render(ProviderHealth);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("provider-health-panel")).toBeInTheDocument();
    const rows = screen.getAllByTestId("provider-health-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset.status).toBe("ok");

    expect(screen.getByTestId("provider-health-name")).toHaveTextContent("api.openai.com · gpt-4o-mini");
    expect(screen.getByTestId("provider-health-state")).toHaveTextContent("ok");
    expect(screen.getByTestId("provider-health-requests")).toHaveTextContent("20");
    expect(screen.getByTestId("provider-health-errors")).toHaveTextContent("0");
    expect(screen.getByTestId("provider-health-error-rate")).toHaveTextContent("0.0%");
    expect(screen.getByTestId("provider-health-latency")).toHaveTextContent("412 ms");
    expect(screen.getByTestId("provider-health-429")).toHaveTextContent("never");
    expect(screen.queryByTestId("provider-health-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-health-error")).not.toBeInTheDocument();
  });

  it("renders the empty state when the IPC returns no providers", async () => {
    setupIpc({ providers: [] });
    render(ProviderHealth);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("provider-health-empty")).toBeInTheDocument();
    expect(screen.getByTestId("provider-health-empty")).toHaveTextContent(/No provider calls recorded yet/i);
    expect(screen.queryByTestId("provider-health-row")).not.toBeInTheDocument();
  });

  it("renders the error state when the IPC returns ok: false", async () => {
    setupIpc({ impl: vi.fn().mockResolvedValue({ ok: false, error: "core-not-wired" }) });
    render(ProviderHealth);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("provider-health-error")).toBeInTheDocument();
    expect(screen.getByTestId("provider-health-error")).toHaveTextContent("core-not-wired");
    expect(screen.queryByTestId("provider-health-row")).not.toBeInTheDocument();
  });

  it("renders the error state when the IPC surface is missing", async () => {
    window.careerflow = { projectMode: {} };
    render(ProviderHealth);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("provider-health-error")).toHaveTextContent(/not available/i);
    expect(screen.queryByTestId("provider-health-row")).not.toBeInTheDocument();
  });

  it("renders a formatted last-429 age for rows that were rate limited", async () => {
    setupIpc({
      providers: [
        {
          name: "api.openai.com · gpt-4o-mini",
          requests: 10,
          success: 9,
          errors: 1,
          errorRate: 0.1,
          avgLatencyMs: 1240,
          last429: NOW - 90_000,
        },
      ],
    });
    render(ProviderHealth);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByTestId("provider-health-429")).toHaveTextContent("1m ago");
    expect(screen.getByTestId("provider-health-latency")).toHaveTextContent("1.24 s");
    expect(screen.getByTestId("provider-health-error-rate")).toHaveTextContent("10.0%");
  });
});

// ---------------------------------------------------------------------------
// Colour coding
// ---------------------------------------------------------------------------

describe("ProviderHealth — colour coding", () => {
  async function renderRow(row) {
    setupIpc({ providers: [row] });
    render(ProviderHealth);
    await vi.advanceTimersByTimeAsync(0);
    return screen.getByTestId("provider-health-row");
  }

  it("renders ok (green) for a clean provider with no recent 429", async () => {
    const row = await renderRow(OK_ROW);
    expect(row.dataset.status).toBe("ok");
    expect(screen.getByTestId("provider-health-state")).toHaveTextContent("ok");
  });

  it("renders warn (yellow) when any request failed", async () => {
    const row = await renderRow({ ...OK_ROW, requests: 20, success: 19, errors: 1, errorRate: 0.05 });
    expect(row.dataset.status).toBe("warn");
    expect(screen.getByTestId("provider-health-state")).toHaveTextContent("warn");
  });

  it("renders warn (yellow) for a clean provider whose last 429 is < 10 min old", async () => {
    const row = await renderRow({ ...OK_ROW, last429: NOW - 60_000 });
    expect(row.dataset.status).toBe("warn");
  });

  it("renders danger (red) at a 25% error rate", async () => {
    const row = await renderRow({ ...OK_ROW, requests: 4, success: 3, errors: 1, errorRate: 0.25 });
    expect(row.dataset.status).toBe("danger");
    expect(screen.getByTestId("provider-health-state")).toHaveTextContent("danger");
  });

  it("renders idle for a provider with no recorded requests", async () => {
    const row = await renderRow({
      name: "localhost:11434 · llama3",
      requests: 0, success: 0, errors: 0, errorRate: 0, avgLatencyMs: null, last429: null,
    });
    expect(row.dataset.status).toBe("idle");
    expect(screen.getByTestId("provider-health-state")).toHaveTextContent("idle");
    expect(screen.getByTestId("provider-health-error-rate")).toHaveTextContent("—");
    expect(screen.getByTestId("provider-health-latency")).toHaveTextContent("—");
  });
});

// ---------------------------------------------------------------------------
// Refresh button
// ---------------------------------------------------------------------------

describe("ProviderHealth — refresh", () => {
  it("re-fetches on click and re-renders the new numbers", async () => {
    let providers = [OK_ROW];
    const getProviderHealth = vi.fn(() =>
      Promise.resolve({ ok: true, providers, updatedAt: NOW })
    );
    window.careerflow = { projectMode: { getProviderHealth } };

    render(ProviderHealth);
    await vi.advanceTimersByTimeAsync(0);
    expect(getProviderHealth).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("provider-health-requests")).toHaveTextContent("20");

    // The provider degrades between polls.
    providers = [
      {
        name: "api.openai.com · gpt-4o-mini",
        requests: 8,
        success: 5,
        errors: 3,
        errorRate: 0.375,
        avgLatencyMs: 905,
        last429: NOW - 30_000,
      },
    ];
    fireEvent.click(screen.getByTestId("provider-health-refresh"));
    await vi.advanceTimersByTimeAsync(0);

    expect(getProviderHealth).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("provider-health-requests")).toHaveTextContent("8");
    expect(screen.getByTestId("provider-health-errors")).toHaveTextContent("3");
    expect(screen.getByTestId("provider-health-error-rate")).toHaveTextContent("37.5%");
    expect(screen.getByTestId("provider-health-latency")).toHaveTextContent("905 ms");
    expect(screen.getByTestId("provider-health-429")).toHaveTextContent("30s ago");
    expect(screen.getByTestId("provider-health-row").dataset.status).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("providerHealth helpers", () => {
  it("providerErrorRate clamps to [0,1] and returns 0 for empty rows", () => {
    expect(providerErrorRate({ requests: 0, errors: 0 })).toBe(0);
    expect(providerErrorRate({ requests: null, errors: 5 })).toBe(0);
    expect(providerErrorRate({ requests: 4, errors: 99 })).toBe(1);
    expect(providerErrorRate({ requests: 10, errors: 2 })).toBeCloseTo(0.2);
  });

  it("classifyProviderHealth honours the 429 recency window", () => {
    const base = { requests: 10, errors: 0, errorRate: 0 };
    expect(classifyProviderHealth({ ...base, last429: null })).toBe("ok");
    expect(classifyProviderHealth({ ...base, last429: NOW - (HEALTH_429_WARN_MS + 1000) })).toBe("ok");
    expect(classifyProviderHealth({ ...base, last429: NOW - HEALTH_429_WARN_MS })).toBe("warn");
    expect(classifyProviderHealth({ ...base, last429: NOW - 1000 })).toBe("warn");
    // A future 429 (clock skew) must not pin the row to warn forever.
    expect(classifyProviderHealth({ ...base, last429: NOW + 60_000 })).toBe("ok");
    // Danger beats the 429 window.
    expect(classifyProviderHealth({ requests: 4, errors: 1, errorRate: 0.25, last429: null })).toBe("danger");
    expect(classifyProviderHealth(null)).toBe("idle");
  });

  it("formatLatencyMs / formatErrorRate / formatAgo / formatNumber are stable", () => {
    expect(formatLatencyMs(412)).toBe("412 ms");
    expect(formatLatencyMs(1240)).toBe("1.24 s");
    expect(formatLatencyMs(null)).toBe("—");
    expect(formatLatencyMs(Number.NaN)).toBe("—");

    expect(formatErrorRate({ requests: 0, errors: 0 })).toBe("—");
    expect(formatErrorRate({ requests: 20, errors: 2 })).toBe("10.0%");

    expect(formatAgo(null, NOW)).toBe("never");
    expect(formatAgo(NOW - 45_000, NOW)).toBe("45s ago");
    expect(formatAgo(NOW - 12 * 60_000, NOW)).toBe("12m ago");
    expect(formatAgo(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatAgo(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");

    expect(formatNumber(50_000)).toBe("50,000");
    expect(formatNumber("x")).toBe("—");
    expect(statusLabel("bogus")).toBe("idle");
  });
});
