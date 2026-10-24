<script>
  let { automation = $bindable(), working, onSave } = $props();
</script>

<div class="grid">
  <label>
    <span>Target</span>
    <select bind:value={automation.target} disabled={working} onchange={() => onSave({ target: automation.target })}>
      <option value="local">Local Vault</option>
      <option value="cloud">Cloud Vault</option>
      <option value="both">Local + Cloud</option>
    </select>
  </label>
  <label>
    <span>Every</span>
    <select
      bind:value={automation.intervalMinutes}
      disabled={working}
      onchange={() => onSave({ intervalMinutes: Number(automation.intervalMinutes) })}
    >
      <option value={15}>15 minutes</option>
      <option value={30}>30 minutes</option>
      <option value={60}>1 hour</option>
      <option value={180}>3 hours</option>
      <option value={720}>12 hours</option>
    </select>
  </label>
  <label>
    <span>Retention</span>
    <select
      bind:value={automation.retentionKeep}
      disabled={working}
      onchange={() => onSave({ retentionKeep: Number(automation.retentionKeep) })}
    >
      <option value={3}>Keep 3 per profile</option>
      <option value={5}>Keep 5 per profile</option>
      <option value={10}>Keep 10 per profile</option>
      <option value={20}>Keep 20 per profile</option>
    </select>
  </label>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 16px;
  }
  label span {
    display: block;
    color: var(--atlas-ink-3);
    font-size: var(--text-sm);
    margin-bottom: 5px;
  }
  select {
    width: 100%;
    background: var(--atlas-void);
    color: var(--atlas-ink);
    border: 1px solid var(--atlas-line);
    border-radius: var(--radius-md);
    padding: 9px 10px;
  }
  select:focus { outline: 2px solid var(--atlas-warn); outline-offset: 1px; }

  @media (max-width: 860px) {
    .grid { grid-template-columns: 1fr; }
  }
</style>
