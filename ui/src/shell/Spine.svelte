<script>
  /**
   * Spine — the obligation/status readout at the top of the rail.
   *
   * This is the Space Bunny v2 "Spine" (`shell/src/shell/Spine.tsx`, and the
   * 48px column in `v1/shots/regression-v2z/01-desk.png`), transferred for its
   * SEMANTICS, not its pixels: the rail's job is to say *how much is on you right
   * now*, so the user reads a count column instead of sixteen destination words.
   *
   * Every number here is real, and every door leads to the thing itself:
   *   BLOCKED ON YOU  pending approvals in the operator store → the Runs console
   *   OPERATOR LIVE   runs in a non-terminal state        → the Runs console
   *   DUE TODAY       deadlines due today (local calendar)  → Deadlines
   *   OVERDUE         deadlines past due (local calendar)   → Deadlines
   *
   * The Lab's own critique (weakness #10) was that its signals opened broad lists
   * rather than the fact they described. Where the destination is more precise
   * (an approval view, a filtered lane) that is a later wave; W1 at least lands
   * on the surface that owns the count.
   *
   * NOT TRANSFERRED: the Lab's UNFILED signal. It counted items captured into an
   * Inbox surface that Progress Ledger does not have. Rendering it would be a
   * decorative copy — a number with nothing behind it — so the row is omitted
   * until there is a real capture store to count.
   *
   * Zeros are rendered on purpose. An instrument that hides its zeroes is not a
   * readout, it is a notification; the Lab's reference shows `DUE TODAY 0` and
   * that is the honest form.
   */

  import { operator, activeRunCount } from "./operator.svelte.js";
  import { deadlinesService } from "../features/deadlines/services/deadlines.service.js";
  import { buildToday, localDayString } from "../features/dashboard/today.js";

  let {
    profileId = null,
    slim = false,
    collapsed = false,
    onOpen = () => {},
  } = $props();

  /** Today model, loaded from the existing `deadlines:list` channel. */
  let model = $state(null);

  $effect(() => {
    const id = profileId;
    if (id == null) {
      model = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const deadlines = await deadlinesService.list(id);
        if (!cancelled) model = buildToday({ deadlines, today: localDayString() });
      } catch {
        // A failed fetch must not invent a zero that looks like good news.
        if (!cancelled) model = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  const signals = $derived([
    {
      id: "blocked",
      label: "Blocked on you",
      count: operator.approvals.length,
      tone: "warn",
      view: "project",
    },
    {
      id: "live",
      label: "Operator live",
      count: activeRunCount(),
      tone: "machine",
      view: "project",
    },
    {
      id: "overdue",
      label: "Overdue",
      count: model ? model.overdue.length : null,
      tone: "bad",
      view: "deadlines",
    },
    {
      id: "today",
      label: "Due today",
      count: model ? model.dueToday.length : null,
      tone: "warn",
      view: "deadlines",
    },
  ]);
</script>

<div class="spine" class:slim class:collapsed aria-label="Obligation readout">
  {#each signals as s (s.id)}
    <button
      type="button"
      class="signal"
      class:zero={s.count === 0}
      class:unknown={s.count === null}
      data-tone={s.count ? s.tone : undefined}
      data-signal={s.id}
      aria-label="{s.label}: {s.count === null ? 'not loaded' : s.count}"
      title="{s.label}{s.count === null ? " — not loaded" : `: ${s.count}`}"
      onclick={() => onOpen(s.view)}
    >
      <span class="glyph" aria-hidden="true">
        {#if s.id === "blocked"}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M8 2.5 14 13H2z" stroke-linejoin="round" />
            <path d="M8 6.5v3" stroke-linecap="round" />
          </svg>
        {:else if s.id === "live"}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 5.5 8 2.5 13 5.5v5L8 13.5 3 10.5z" stroke-linejoin="round" />
          </svg>
        {:else if s.id === "overdue"}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 5v3.5l2 1.5" stroke-linecap="round" />
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
            <path d="M2.5 6.5h11" />
          </svg>
        {/if}
      </span>
      <span class="count" aria-hidden="true">{s.count === null ? "—" : s.count}</span>
      <span class="caption" aria-hidden="true">{s.label}</span>
    </button>
  {/each}
</div>

<style>
  .spine {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 8px 10px;
    border-bottom: 1px solid var(--atlas-line);
  }

  .signal {
    display: grid;
    grid-template-columns: 16px 1fr;
    grid-template-rows: auto auto;
    align-items: center;
    column-gap: 9px;
    padding: 5px 6px;
    border-radius: var(--radius-sm);
    text-align: left;
    color: var(--atlas-ink-3);
  }

  .signal:hover {
    background: var(--atlas-wash);
    color: var(--atlas-ink-2);
  }

  .glyph {
    grid-row: 1 / span 2;
    display: inline-flex;
    color: var(--atlas-ink-4);
  }

  .signal[data-tone="warn"] .glyph {
    color: var(--atlas-warn);
  }
  .signal[data-tone="bad"] .glyph {
    color: var(--atlas-bad);
  }
  .signal[data-tone="machine"] .glyph {
    color: var(--atlas-machine);
  }

  .count {
    font-family: var(--font-mono);
    font-size: var(--text-md);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
    color: var(--atlas-ink-2);
  }

  .signal.zero .count {
    color: var(--atlas-ink-4);
  }

  .signal.unknown .count {
    opacity: 0.5;
  }

  .signal[data-tone="warn"] .count {
    color: var(--atlas-warn-ink);
  }
  .signal[data-tone="bad"] .count {
    color: var(--atlas-bad);
  }

  .caption {
    font-family: var(--font-mono);
    font-size: 8.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--atlas-ink-4);
    overflow: hidden;
    text-overflow: clip;
    white-space: nowrap;
  }

  /* Numeric rail: glyph above count, caption hidden (the rail is 64px). */
  .spine.slim {
    padding: 6px 4px;
    align-items: center;
  }

  .spine.slim .signal {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto;
    justify-items: center;
    width: 100%;
    padding: 6px 2px;
  }

  .spine.slim .glyph {
    grid-row: auto;
  }

  .spine.slim .caption {
    display: none;
  }

  /* Icon-only rail. */
  .spine.collapsed {
    padding: 6px 0;
    align-items: center;
  }

  .spine.collapsed .signal {
    grid-template-columns: 1fr;
    justify-items: center;
    width: 100%;
    padding: 5px 0;
  }

  .spine.collapsed .caption,
  .spine.collapsed .count {
    display: none;
  }
</style>
