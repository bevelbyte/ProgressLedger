<script>
  let { check } = $props();

  function statusText(status) {
    if (status === "pass") return "Pass";
    if (status === "warn") return "Warn";
    return "Fail";
  }
</script>

<article class="check {check.status}">
  <div>
    <strong>{check.label}</strong>
    {#if check.detail}<span>{check.detail}</span>{/if}
  </div>
  <em>{statusText(check.status)}</em>
</article>

<style>
  .check {
    border: 1px solid var(--atlas-raise);
    background: var(--atlas-void);
    border-radius: var(--radius-md);
    padding: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .check.pass { border-color: var(--atlas-ok-bg); }
  .check.warn { border-color: var(--atlas-warn-bg); }
  .check.fail { border-color: var(--atlas-bad-bg); }
  
  strong {
    display: block;
    color: var(--atlas-ink);
    font-size: var(--text-md);
  }
  span {
    display: block;
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
  em {
    flex: none;
    color: var(--atlas-ink-2);
    font-style: normal;
    font-size: var(--text-sm);
  }
  @media (max-width: 860px) {
    .check { flex-direction: column; align-items: stretch; }
  }
</style>
