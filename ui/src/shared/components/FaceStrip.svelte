<script>
  // Atlas §5.2 — the Space face strip.
  //
  // A Space (Subject or Project) is one durable body of work viewed from a
  // handful of angles: Overview, Work, Knowledge, Sessions, Research, Agent.
  // Those are *faces* of one object, not separate destinations, so they are
  // presented as a tablist inside the Space — the rail never learns about them.
  //
  // Owned behaviours:
  //   * `role="tablist"` / `role="tab"` / `aria-selected`, with arrow-key
  //     movement and Home/End, so a keyboard user can sweep the faces without
  //     tabbing through every one of them.
  //   * Roving tabindex — exactly one face is in the tab order.
  //   * `count` renders only when it is a real number. A zero dressed up as
  //     information is worse than silence.

  /**
   * @type {{
   *   faces?: Array<{id: string, label: string, icon?: any, count?: number, note?: string}>,
   *   active?: string,
   *   label?: string,
   *   faceClass?: string,
   * }}
   */
  let { faces = [], active = $bindable("overview"), label = "Space faces", faceClass = "" } = $props();

  let stripEl = $state(null);

  function focusFace(id) {
    active = id;
    // Move focus with the selection so the strip behaves like one control.
    const node = stripEl?.querySelector(`[data-face="${id}"]`);
    node?.focus();
  }

  function onkeydown(e) {
    const ids = faces.map((f) => f.id);
    const i = ids.indexOf(active);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusFace(ids[(i + 1) % ids.length]);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusFace(ids[(i - 1 + ids.length) % ids.length]);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusFace(ids[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      focusFace(ids[ids.length - 1]);
    }
  }
</script>

<div
  class="face-strip"
  role="tablist"
  aria-label={label}
  tabindex="-1"
  bind:this={stripEl}
  onkeydown={onkeydown}
>
  {#each faces as face (face.id)}
    {@const Icon = face.icon}
    <button
      type="button"
      role="tab"
      class="face {faceClass}"
      class:on={active === face.id}
      data-face={face.id}
      aria-selected={active === face.id}
      tabindex={active === face.id ? 0 : -1}
      title={face.note ?? face.label}
      onclick={() => (active = face.id)}
    >
      {#if Icon}<Icon size={14} strokeWidth={2} aria-hidden="true" />{/if}
      <span>{face.label}</span>
      {#if typeof face.count === "number" && face.count > 0}
        <span class="cf-badge tally">{face.count}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .face-strip {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    border-bottom: 1px solid var(--atlas-line);
    padding-bottom: var(--space-2);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .face-strip::-webkit-scrollbar {
    display: none;
  }

  .face {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    height: calc(var(--ctl-h) - 2px);
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--atlas-ink-3);
    font-size: var(--text-md);
    font-weight: 500;
    cursor: pointer;
    transition: color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
  }

  .face:hover {
    color: var(--atlas-ink);
    background: var(--atlas-wash);
  }

  .face.on {
    color: var(--atlas-ink);
    background: var(--atlas-wash-2);
    box-shadow: inset 0 -2px 0 var(--atlas-signal);
  }

  .face:focus-visible {
    outline: 2px solid var(--atlas-signal);
    outline-offset: -2px;
  }

  .tally {
    background: var(--atlas-raise);
    color: var(--atlas-ink-2);
  }
</style>
