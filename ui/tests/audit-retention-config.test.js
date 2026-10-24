// AuditRetentionConfig — UI tests.
//
// Coverage:
//   - renders the current retention policy read from audit:get-retention
//   - "Save" calls audit:set-retention with numeric { days, count }
//   - out-of-range input is rejected inline and never reaches IPC
//   - a successful save writes a "Saved at HH:MM:SS" status line
//   - every audit call carries the caller's profileId as ownership proof (SF-3)
//
// The IPC namespace is mocked on window.progressLedger.audit, mirroring the
// shape shipped by shell/src/preload.cjs + shell/src/ipc/audit.js.

import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import AuditRetentionConfig from "../src/features/project-mode/components/AuditRetentionConfig.svelte";

const TIME_RE = /\d{2}:\d{2}:\d{2}/;
const PROFILE_ID = 7;

/** Install a mocked window.progressLedger.audit namespace. */
function setupAudit({ retention = { days: 30, count: 50_000 }, setRetentionImpl } = {}) {
  const getRetention = vi.fn().mockResolvedValue({ ok: true, retention });
  const setRetention = setRetentionImpl
    ? setRetentionImpl
    : vi.fn().mockImplementation(async (payload) => ({
        ok: true,
        retention: { days: payload.days, count: payload.count },
      }));
  window.progressLedger = { audit: { getRetention, setRetention } };
  return { getRetention, setRetention };
}

beforeEach(() => {
  window.progressLedger = undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AuditRetentionConfig", () => {
  it("renders the current retention values from audit:get-retention", async () => {
    const { getRetention } = setupAudit({ retention: { days: 14, count: 12_345 } });

    render(AuditRetentionConfig, { props: { profileId: PROFILE_ID } });
    await screen.findByTestId("audit-retention-config");
    const days = await screen.findByTestId("audit-retention-days");
    const count = screen.getByTestId("audit-retention-count");

    expect(getRetention).toHaveBeenCalledTimes(1);
    expect(days.value).toBe("14");
    expect(count.value).toBe("12345");
    // The bounds hint is present so the user knows the allowed range.
    expect(screen.getByTestId("audit-retention-hint")).toHaveTextContent(/100/);
    expect(screen.getByTestId("audit-retention-hint")).toHaveTextContent(/1,000,000/);
  });

  it("saves via audit:set-retention with numeric { days, count }", async () => {
    const { setRetention } = setupAudit();

    render(AuditRetentionConfig, { props: { profileId: PROFILE_ID } });
    await screen.findByTestId("audit-retention-days");

    fireEvent.input(screen.getByTestId("audit-retention-days"), { target: { value: "60" } });
    fireEvent.input(screen.getByTestId("audit-retention-count"), { target: { value: "250000" } });
    fireEvent.click(screen.getByTestId("audit-retention-save"));

    await waitFor(() => expect(setRetention).toHaveBeenCalledTimes(1));
    expect(setRetention).toHaveBeenCalledWith({ profileId: PROFILE_ID, days: 60, count: 250_000 });
    // Payload fields must be real numbers, not strings.
    expect(typeof setRetention.mock.calls[0][0].days).toBe("number");
    expect(typeof setRetention.mock.calls[0][0].count).toBe("number");
  });

  it("sends the caller's profileId on every audit call as ownership proof (SF-3)", async () => {
    const { getRetention, setRetention } = setupAudit();

    render(AuditRetentionConfig, { props: { profileId: PROFILE_ID } });
    await screen.findByTestId("audit-retention-days");

    // Read path.
    await waitFor(() => expect(getRetention).toHaveBeenCalled());
    expect(getRetention.mock.calls[0][0]).toEqual({ profileId: PROFILE_ID });

    // Write path.
    fireEvent.click(screen.getByTestId("audit-retention-save"));
    await waitFor(() => expect(setRetention).toHaveBeenCalledTimes(1));
    expect(setRetention.mock.calls[0][0].profileId).toBe(PROFILE_ID);
  });

  it("rejects out-of-range days and never calls set-retention", async () => {
    const { setRetention } = setupAudit();

    render(AuditRetentionConfig, { props: { profileId: PROFILE_ID } });
    await screen.findByTestId("audit-retention-days");
    const daysInput = screen.getByTestId("audit-retention-days");
    const save = screen.getByTestId("audit-retention-save");
    const status = screen.getByTestId("audit-retention-status");

    for (const bad of ["0", "999"]) {
      fireEvent.input(daysInput, { target: { value: bad } });
      fireEvent.click(save);
      await waitFor(() =>
        expect(status).toHaveTextContent(/Days must be a whole number between 1 and 365/)
      );
    }

    expect(setRetention).not.toHaveBeenCalled();
  });

  it("degrades gracefully when the audit namespace is unavailable", async () => {
    // window.progressLedger is left undefined by beforeEach() on purpose.
    render(AuditRetentionConfig, { props: { profileId: PROFILE_ID } });
    await screen.findByTestId("audit-retention-config");
    // The panel still renders its inputs; the failure is surfaced inline.
    expect(screen.getByTestId("audit-retention-days")).toBeInTheDocument();
    expect(screen.getByTestId("audit-retention-count")).toBeInTheDocument();
    expect(screen.getByTestId("audit-retention-load-error")).toHaveTextContent(
      "Audit retention is not available in this build."
    );
  });

  it("rejects an out-of-range event count", async () => {
    const { setRetention } = setupAudit();

    render(AuditRetentionConfig, { props: { profileId: PROFILE_ID } });
    await screen.findByTestId("audit-retention-count");
    fireEvent.input(screen.getByTestId("audit-retention-count"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("audit-retention-save"));

    await waitFor(() =>
      expect(screen.getByTestId("audit-retention-status")).toHaveTextContent(
        /Events must be a whole number between 100 and 1,000,000/
      )
    );
    expect(setRetention).not.toHaveBeenCalled();
  });

  it("shows a 'Saved at HH:MM:SS' status line after a successful save", async () => {
    const { setRetention } = setupAudit();

    render(AuditRetentionConfig, { props: { profileId: PROFILE_ID } });
    await screen.findByTestId("audit-retention-days");
    fireEvent.click(screen.getByTestId("audit-retention-save"));

    const status = await screen.findByTestId("audit-retention-status");
    await waitFor(() => expect(setRetention).toHaveBeenCalledTimes(1));
    expect(status).toHaveTextContent(/Saved at \d{2}:\d{2}:\d{2}/);
    expect(status.textContent).toMatch(TIME_RE);
  });

  it("reports a readable error when set-retention fails", async () => {
    // reportError() logs to console.error — keep the test output clean.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setupAudit({
        setRetentionImpl: vi.fn().mockRejectedValue(new Error("boom")),
      });

      render(AuditRetentionConfig, { props: { profileId: PROFILE_ID } });
      await screen.findByTestId("audit-retention-days");
      fireEvent.click(screen.getByTestId("audit-retention-save"));

      await waitFor(() =>
        expect(screen.getByTestId("audit-retention-status")).toHaveTextContent(
          "Could not save the retention policy."
        )
      );
      expect(screen.getByTestId("audit-retention-status")).toHaveTextContent("error");
    } finally {
      consoleError.mockRestore();
    }
  });
});
