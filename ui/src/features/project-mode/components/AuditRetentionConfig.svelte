<script>
  // AuditRetentionConfig — UI for the audit log retention policy.
  //
  // The audit log itself is owned by the main process
  // (shell/src/services/audit/index.js); the renderer can only READ the
  // current policy and PROPOSE a new one. The main process clamps values
  // hard (max 3650 days / 1_000_000 count) so a misbehaving renderer can't
  // disable retention entirely. We mirror the same checks here so the user
  // gets a friendly inline error instead of a silent server-side clamp.
  //
  // Channels (shell/src/preload.cjs -> window.progressLedger.audit):
  //   getRetention({profileId})            -> { ok: true, retention: { days, count } }
  //   setRetention({profileId,days,count}) -> { ok: true, retention: { days, count } }
  //
  // The retention POLICY is process-global (one JSONL, one in-memory ring, one
  // whole-file prune) — see the SF-3 note in shell/src/ipc/audit.js. Every audit
  // channel is nonetheless ownership-gated, so each call must carry a profileId
  // the caller owns; we forward the active profile purely as that proof.

  import { reportError } from "../../../shared/utils/errors.js";

  let { profileId = null } = $props();

  // UI contract. Looser than the server's hard clamp on purpose — the
  // server is the last line of defence, these are the sane defaults we
  // ask a human to stay within.
  const DAYS_MIN = 1;
  const DAYS_MAX = 365;
  const COUNT_MIN = 100;
  const COUNT_MAX = 1_000_000;

  // Bound to type="number" inputs: Svelte coerces the binding to a number,
  // so keep the seed values numeric and re-parse defensively in validate().
  let daysInput = $state(30);
  let countInput = $state(50_000);

  let saving = $state(false);
  let loadFailed = $state(false);
  let status = $state("");      // "" | "Saved at HH:MM:SS" | an error message
  let statusKind = $state("");  // "" | "ok" | "err"

  function fmt(n) {
    return n.toLocaleString("en-US");
  }

  function hhmmss(d = new Date()) {
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function auditApi() {
    const w = typeof window !== "undefined" ? window : undefined;
    const ns = w && w.progressLedger && w.progressLedger.audit;
    return ns && typeof ns.getRetention === "function" && typeof ns.setRetention === "function"
      ? ns
      : null;
  }

  /**
   * Validate the two fields. Returns "" when both are in range, otherwise a
   * human-readable message. Non-numeric / empty input is an error too.
   * Tolerates both string and numeric bindings — Svelte coerces
   * type="number" to a number, but an empty field still needs reporting.
   */
  function validate(daysRaw, countRaw) {
    const daysStr = String(daysRaw ?? "").trim();
    const countStr = String(countRaw ?? "").trim();
    const days = Number(daysStr);
    const count = Number(countStr);
    if (daysStr === "" || !Number.isInteger(days) || days < DAYS_MIN || days > DAYS_MAX) {
      return `Days must be a whole number between ${DAYS_MIN} and ${DAYS_MAX}.`;
    }
    if (
      countStr === "" ||
      !Number.isInteger(count) ||
      count < COUNT_MIN ||
      count > COUNT_MAX
    ) {
      return `Events must be a whole number between ${fmt(COUNT_MIN)} and ${fmt(COUNT_MAX)}.`;
    }
    return "";
  }

  async function load() {
    const api = auditApi();
    if (!api) {
      loadFailed = true;
      status = "Audit retention is not available in this build.";
      statusKind = "err";
      return;
    }
    try {
      const res = await api.getRetention({ profileId });
      if (res && res.ok && res.retention) {
        if (Number.isFinite(res.retention.days)) daysInput = Math.floor(res.retention.days);
        if (Number.isFinite(res.retention.count)) countInput = Math.floor(res.retention.count);
        loadFailed = false;
      } else {
        loadFailed = true;
        status = res && res.reason ? `Could not read retention (${res.reason}).` : "Could not read the current retention policy.";
        statusKind = "err";
      }
    } catch (e) {
      loadFailed = true;
      reportError(e, "Could not read retention");
      status = "Could not read the current retention policy.";
      statusKind = "err";
    }
  }

  async function save() {
    const invalid = validate(daysInput, countInput);
    if (invalid) {
      status = invalid;
      statusKind = "err";
      return;
    }
    const api = auditApi();
    if (!api) return;

    const payload = {
      profileId,
      days: Math.floor(Number(daysInput)),
      count: Math.floor(Number(countInput)),
    };
    saving = true;
    try {
      const res = await api.setRetention(payload);
      if (res && res.ok && res.retention) {
        daysInput = Math.floor(res.retention.days);
        countInput = Math.floor(res.retention.count);
        status = `Saved at ${hhmmss()}`;
        statusKind = "ok";
      } else {
        status = res && res.reason ? `Save failed (${res.reason}).` : "Save failed.";
        statusKind = "err";
      }
    } catch (e) {
      reportError(e, "Could not save retention");
      status = "Could not save the retention policy.";
      statusKind = "err";
    } finally {
      saving = false;
    }
  }

  // Read the current policy once on mount.
  $effect(() => {
    load();
  });
</script>

<div class="panel" data-testid="audit-retention-config">
  <div class="panel-head">
    <h3 class="title">Audit retention</h3>
    <span class="hint" data-testid="audit-retention-hint">
      {fmt(COUNT_MIN)}–{fmt(COUNT_MAX)} events · {DAYS_MIN}–{DAYS_MAX} days
    </span>
  </div>

  {#if loadFailed}
    <p class="note err" data-testid="audit-retention-load-error">{status}</p>
  {/if}

  <div class="fields">
    <label class="field">
      <span>Keep events for</span>
      <span class="inline">
        <input
          type="number"
          min={DAYS_MIN}
          max={DAYS_MAX}
          step="1"
          bind:value={daysInput}
          disabled={saving}
          data-testid="audit-retention-days"
        />
        <em>days</em>
      </span>
    </label>

    <label class="field">
      <span>Keep at most</span>
      <span class="inline">
        <input
          type="number"
          min={COUNT_MIN}
          max={COUNT_MAX}
          step="1"
          bind:value={countInput}
          disabled={saving}
          data-testid="audit-retention-count"
        />
        <em>events</em>
      </span>
    </label>
  </div>

  <div class="actions">
    <span class="status" data-testid="audit-retention-status" aria-live="polite">
      {status}{#if statusKind === "err"} <span class="tag err">error</span>{/if}{#if statusKind === "ok"} <span class="tag ok">ok</span>{/if}
    </span>
    <button type="button" class="btn btn-primary" onclick={save} disabled={saving} data-testid="audit-retention-save">
      {saving ? "Saving…" : "Save"}
    </button>
  </div>
</div>

<style>
  .panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px;
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .title {
    margin: 0;
    font-size: var(--text-md);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--text-md);
  }
  .field > span:first-child {
    color: var(--text-secondary);
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .inline input {
    flex: 1;
    min-width: 0;
    background: var(--bg-main);
    color: var(--text-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font-size: var(--text-md);
    font-variant-numeric: tabular-nums;
  }
  .inline em {
    font-style: normal;
    font-size: var(--text-sm);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .note {
    font-size: var(--text-sm);
    padding: 6px 8px;
    border-radius: var(--radius-sm);
  }
  .note.err {
    color: var(--color-danger);
    background: var(--color-danger-bg);
    border: 1px solid var(--border);
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 4px;
  }
  .status {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .tag {
    font-size: var(--text-xs);
    padding: 1px 6px;
    border-radius: var(--radius-full);
  }
  .tag.ok {
    color: var(--color-success);
    background: var(--color-success-bg);
  }
  .tag.err {
    color: var(--color-danger);
    background: var(--color-danger-bg);
  }
  .btn {
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: var(--text-md);
    white-space: nowrap;
  }
  .btn-primary {
    background: var(--accent);
    color: var(--bg-main);
    border-color: var(--accent);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
