// ResumeBanner — UI tests.
//
// Coverage:
//   1. does NOT render anything when the IPC returns agent=null
//      (the most common case — no leftover run from a previous session)
//   2. renders a banner with the truncated objective + Resume / Discard
//      buttons when the IPC returns a resumable agent row
//   3. clicking Resume calls projectMode.startAgent with the leftover
//      agent id and hides the banner
//
// The IPC namespace is mocked on window.progressLedger.projectMode, mirroring
// the shape shipped by shell/src/preload.cjs +
// shell/src/ipc/project-mode.js (`agent:list-resumable` → { ok, agent }).

import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import ResumeBanner from "../src/features/project-mode/components/ResumeBanner.svelte";

const RESUMABLE_AGENT = {
  id: 42,
  projectId: 7,
  objective: "Add a ResumeBanner to surface interrupted agent runs on Project Mode load.",
  state: "executing_tool",
  tokensIn: 1200,
  tokensOut: 800,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:05.000Z",
};

function setupIpc({
  listResumableAgent = vi.fn().mockResolvedValue({ ok: true, agent: null }),
  startAgent = vi.fn().mockResolvedValue({ ok: true, runId: "abc123" }),
} = {}) {
  window.progressLedger = { projectMode: { listResumableAgent, startAgent } };
  return { listResumableAgent, startAgent };
}

beforeEach(() => {
  // Make sure the dismissed flag is clean for each test.
  try {
    localStorage.clear();
  } catch (_) {
    // localStorage unavailable — skip
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.progressLedger = undefined;
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("ResumeBanner — rendering", () => {
  it("does not render when the IPC returns agent=null", async () => {
    setupIpc();
    render(ResumeBanner, { profileId: 1 });
    // Let the onMount -> fetchResumable -> state update settle.
    await vi.waitFor(() =>
      expect(screen.queryByTestId("resume-banner")).not.toBeInTheDocument()
    );
    expect(screen.queryByTestId("resume-banner-resume")).not.toBeInTheDocument();
    expect(screen.queryByTestId("resume-banner-discard")).not.toBeInTheDocument();
  });

  it("renders a banner with the truncated objective and Resume/Discard buttons when a resumable agent exists", async () => {
    setupIpc({
      listResumableAgent: vi.fn().mockResolvedValue({ ok: true, agent: RESUMABLE_AGENT }),
    });
    render(ResumeBanner, { profileId: 1 });

    await vi.waitFor(() =>
      expect(screen.getByTestId("resume-banner")).toBeInTheDocument()
    );
    expect(screen.getByTestId("resume-banner-goal")).toHaveTextContent(
      RESUMABLE_AGENT.objective
    );
    expect(screen.getByTestId("resume-banner-state")).toHaveTextContent("executing_tool");
    expect(screen.getByTestId("resume-banner-resume")).toBeInTheDocument();
    expect(screen.getByTestId("resume-banner-discard")).toBeInTheDocument();
  });

  it("truncates very long objectives so the banner stays compact", async () => {
    const long = "x".repeat(500);
    setupIpc({
      listResumableAgent: vi.fn().mockResolvedValue({
        ok: true,
        agent: { ...RESUMABLE_AGENT, objective: long },
      }),
    });
    render(ResumeBanner, { profileId: 1 });

    await vi.waitFor(() =>
      expect(screen.getByTestId("resume-banner")).toBeInTheDocument()
    );
    const goal = screen.getByTestId("resume-banner-goal").textContent || "";
    expect(goal.length).toBeLessThanOrEqual(120);
    expect(goal.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resume button
// ---------------------------------------------------------------------------

describe("ResumeBanner — resume action", () => {
  it("calls projectMode.startAgent with the leftover agent id and hides the banner", async () => {
    const startAgent = vi.fn().mockResolvedValue({ ok: true, runId: "run-xyz" });
    setupIpc({
      listResumableAgent: vi.fn().mockResolvedValue({ ok: true, agent: RESUMABLE_AGENT }),
      startAgent,
    });
    render(ResumeBanner, { profileId: 1 });

    await vi.waitFor(() =>
      expect(screen.getByTestId("resume-banner")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId("resume-banner-resume"));

    await vi.waitFor(() =>
      expect(screen.queryByTestId("resume-banner")).not.toBeInTheDocument()
    );
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(startAgent).toHaveBeenCalledWith(1, RESUMABLE_AGENT.id);
  });

  it("surfaces an inline error and keeps the banner visible when startAgent refuses", async () => {
    setupIpc({
      listResumableAgent: vi.fn().mockResolvedValue({ ok: true, agent: RESUMABLE_AGENT }),
      startAgent: vi.fn().mockResolvedValue({ ok: false, reason: "already-running" }),
    });
    render(ResumeBanner, { profileId: 1 });

    await vi.waitFor(() =>
      expect(screen.getByTestId("resume-banner")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId("resume-banner-resume"));

    await vi.waitFor(() =>
      expect(screen.getByTestId("resume-banner-error")).toHaveTextContent("already-running")
    );
    expect(screen.getByTestId("resume-banner")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Discard button
// ---------------------------------------------------------------------------

describe("ResumeBanner — discard action", () => {
  it("hides the banner for the session when Discard is clicked (localStorage flag)", async () => {
    setupIpc({
      listResumableAgent: vi.fn().mockResolvedValue({ ok: true, agent: RESUMABLE_AGENT }),
    });
    render(ResumeBanner, { profileId: 1 });

    await vi.waitFor(() =>
      expect(screen.getByTestId("resume-banner")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId("resume-banner-discard"));

    await vi.waitFor(() =>
      expect(screen.queryByTestId("resume-banner")).not.toBeInTheDocument()
    );
    // The dismiss flag is profile-scoped so a different profile would
    // still see its own banner.
    expect(localStorage.getItem("progressledger_v2_resume_banner_dismissed:1")).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Missing IPC surface
// ---------------------------------------------------------------------------

describe("ResumeBanner — missing IPC surface", () => {
  it("renders nothing when projectMode.listResumableAgent is not on the namespace", async () => {
    window.progressLedger = { projectMode: {} };
    render(ResumeBanner, { profileId: 1 });
    await vi.waitFor(() =>
      expect(screen.queryByTestId("resume-banner")).not.toBeInTheDocument()
    );
  });
});