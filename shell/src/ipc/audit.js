import { safeHandle } from "../security/safe-handle.js";
// Project Mode — IPC surface for the security audit log.
//
// The audit log is owned by the main process (see
// shell/src/services/audit/index.js). The renderer can read the most
// recent entries and discover the on-disk JSONL path; it cannot write
// to it.
//
// Channels:
//   audit:list           → return the last N events (capped at 200 per call)
//   audit:list-events    → typed filter; takes { profileId, eventName, since, until, limit }
//   audit:export         → return the export filename for the JSONL file
//   audit:get-retention  → return the current retention policy
//   audit:set-retention  → update the retention policy
//
// Failures are returned as structured envelopes (`{ ok: false, reason }`)
// so the renderer can show a user-visible error.
//
// ---------------------------------------------------------------------------
// SF-3 — ownership boundary. What is global and what is profile-scoped.
// ---------------------------------------------------------------------------
//
// The audit STORE is process-global BY DESIGN, and that is deliberate:
//
//   * one JSONL file        — <userData>/audit-log.jsonl (+ one rotated .1)
//   * one in-memory ring    — a single `state.ring` array
//   * one retention policy  — module-scoped `retention` in services/audit
//   * one prune             — `prune()` rewrites the WHOLE file from the ring
//
// A per-profile retention policy is not representable in that storage model:
// pruning is whole-file, so two profiles cannot hold divergent windows over
// one log. Inventing per-profile retention here would be a second, redundant
// authorization+storage system that the store cannot honour. So the POLICY
// stays process-global.
//
// What IS profile-scoped is the audit EVENT surface: `audit:list` and
// `audit:list-events` filter the ring by profileId after proving the caller
// owns that profile.
//
// The three channels below (`export`, `get-retention`, `set-retention`) carry
// no per-profile data — they expose global policy state. They are STILL
// ownership-gated, because "the data is global" is not a reason to let an
// unauthenticated renderer rewrite the audit log's retention policy. Before
// SF-3 they were the only audit channels with no ownership check at all, which
// meant a compromised renderer could shrink the app-wide audit retention
// (destroying the audit trail) without proving it drives any profile.
//
// The gate is on the CHANNEL, not a claim of per-profile partitioning:
//   - ownership is proven (an existing, profile-owned profileId is required)
//   - the value read/written remains the single process-global policy
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import { Audit, _getRetention, _setRetention } from "../services/audit/index.js";

async function assertProfileOwned(ctx, profileId) {
  if (!Number.isInteger(profileId) || profileId <= 0) return { ok: false, reason: "invalid-profile-id" };
  if (!ctx?.core || typeof ctx.core.getProfiles !== "function") return { ok: false, reason: "core-not-wired" };
  try {
    const profiles = await Promise.resolve(ctx.core.getProfiles());
    const owned = Array.isArray(profiles) && profiles.some((p) => Number(p?.id ?? p?.profile_id) === profileId);
    return owned ? { ok: true } : { ok: false, reason: "profile-not-found" };
  } catch { return { ok: false, reason: "profile-ownership-check-failed" }; }
}

export function register(ctx) {
  safeHandle("audit:list", async (_e, options = {}) => {
    const profileId = options?.profileId;
    const ownership = await assertProfileOwned(ctx, profileId);
    if (!ownership.ok) return ownership;
    const filter = { profileId };
    if (typeof options.event === "string") filter.event = options.event;

    if (typeof options.since === "number") filter.since = options.since;
    if (typeof options.until === "number") filter.until = options.until;
    if (typeof options.limit === "number") filter.limit = options.limit;
    const events = Audit.list(filter);
    return { ok: true, events };
  });

  // Typed, filterable list for the renderer's ShellHistoryFilter panel.
  // Accepts eventName (maps to the audit event name, e.g. "shell:exec") so
  // the renderer doesn't need to know the internal filter key naming.
  safeHandle("audit:list-events", async (_e, options = {}) => {
    const profileId = options?.profileId;
    const ownership = await assertProfileOwned(ctx, profileId);
    if (!ownership.ok) return ownership;
    const filter = { profileId };
    if (typeof options.eventName === "string") filter.event = options.eventName;

    if (typeof options.since === "number") filter.since = options.since;
    if (typeof options.until === "number") filter.until = options.until;
    if (typeof options.limit === "number") filter.limit = options.limit;
    const events = Audit.list(filter);
    return { ok: true, events };
  });

  // Returns the export FILENAME only — never the absolute path. Handing the
  // renderer <userData> would leak the OS username and the app's data layout
  // (the same reason marketplace:install-git strips install_path).
  safeHandle("audit:export", async (_e, options = {}) => {
    const ownership = await assertProfileOwned(ctx, options?.profileId);
    if (!ownership.ok) return ownership;
    const p = Audit.filePath();
    if (!p) return { ok: false, reason: "not-initialised" };
    return { ok: true, filename: "audit-log.jsonl" };
  });

  // Process-global policy read (see the SF-3 note above). Ownership-gated at
  // the channel, but the value is the single app-wide policy.
  safeHandle("audit:get-retention", async (_e, options = {}) => {
    const ownership = await assertProfileOwned(ctx, options?.profileId);
    if (!ownership.ok) return ownership;
    return { ok: true, retention: _getRetention() };
  });

  // Process-global policy WRITE. Ownership-gated at the channel; _setRetention
  // additionally clamps to [1..3650] days / [1..1_000_000] count so a
  // misconfigured renderer still cannot disable audit retention entirely.
  safeHandle("audit:set-retention", async (_e, options = {}) => {
    const ownership = await assertProfileOwned(ctx, options?.profileId);
    if (!ownership.ok) return ownership;
    const next = _setRetention({
      days: typeof options.days === "number" ? options.days : undefined,
      count: typeof options.count === "number" ? options.count : undefined,
    });
    return { ok: true, retention: next };
  });
}
