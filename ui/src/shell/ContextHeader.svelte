<script>
  // Atlas shell — per-view context header.
  //
  // Every view states what it is and what you can do to it, in the same place,
  // with the same rhythm. Previously each view invented its own header (or had
  // none), which is why the app never felt like one product.
  //
  // `actions` is a snippet so a view can contribute its own view-level
  // controls without the shell knowing what they are.

  let {
    title = "",
    subtitle = "",
    icon = null,
    actions = null,
    meta = null,
  } = $props();
</script>

<header class="context">
  {#if icon}
    {@const ViewIcon = icon}
    <div class="ctx-main">
      <span class="ctx-icon" aria-hidden="true">
        <ViewIcon size={16} strokeWidth={1.6} />
      </span>
      <div class="ctx-text">
        <!--
          Deliberately NOT a heading.

          Two reasons. First, the icon above was written as `<icon …>` (lowercase),
          which Svelte treats as an unknown HTML element rather than the component,
          so no view icon ever actually rendered.

          Second, every view's own panel already opens with its own `h2`/`h3`. A
          heading here made the document outline announce the view twice — and
          where a panel's heading matched the view name (Study Sessions, Deadlines)
          a role-based query resolved to two elements, which is a real ambiguity for
          assistive tech, not just for Playwright.
        -->
        <span class="ctx-title">{title}</span>
        {#if subtitle}<p class="ctx-sub">{subtitle}</p>{/if}
      </div>
    </div>
  {:else}
    <div class="ctx-main">
      <div class="ctx-text">
        <span class="ctx-title">{title}</span>
        {#if subtitle}<p class="ctx-sub">{subtitle}</p>{/if}
      </div>
    </div>
  {/if}

  <div class="ctx-side">
    {#if meta}
      <div class="ctx-meta">{@render meta()}</div>
    {/if}
    {#if actions}
      <div class="ctx-actions">{@render actions()}</div>
    {/if}
  </div>
</header>

<style>
  .context {
    height: var(--shell-context-h);
    flex: 0 0 var(--shell-context-h);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    padding: 0 var(--space-6);
    background: var(--atlas-base);
    border-bottom: 1px solid var(--atlas-line);
  }

  .ctx-main {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .ctx-icon {
    display: inline-flex;
    color: var(--atlas-signal);
    flex-shrink: 0;
  }

  .ctx-text {
    min-width: 0;
  }

  .ctx-title {
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--atlas-ink);
    line-height: 1.25;
  }

  .ctx-sub {
    font-size: var(--text-sm);
    color: var(--atlas-ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ctx-side {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-shrink: 0;
  }

  .ctx-meta {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .ctx-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
