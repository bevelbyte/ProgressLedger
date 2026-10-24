<script>
  import { onMount } from "svelte";
  import { Bookmark, Globe, RotateCw, ExternalLink, Quote } from "lucide-svelte";
  import { reportError } from "../../../shared/utils/errors.js";
  import { formatCitation } from "../../../shared/utils/citations.js";

  let { profileId = null, researchPageId = null, onOpenResearchSource = () => {} } = $props();
  let sources = $state([]);
  let captures = $state([]);
  let loading = $state(false);
  let notice = $state("");
  let filter = $state("all");
  let passageText = $state("");
  let savingPassage = $state(false);
  let refreshRequest = 0;

  async function refresh(requestedProfileId = profileId) {
    if (!Number.isInteger(Number(requestedProfileId))) return;
    const requestId = ++refreshRequest;
    loading = true;
    try {
      const [nextSources, nextCaptures] = await Promise.all([
        window.progressLedger.research.listSources(Number(requestedProfileId)),
        window.progressLedger.research.listCaptures(Number(requestedProfileId)),
      ]);
      if (requestId !== refreshRequest) return false;
      sources = Array.isArray(nextSources) ? nextSources : [];
      captures = Array.isArray(nextCaptures) ? nextCaptures : [];
      notice = "";
      return true;
    } catch (error) {
      if (requestId !== refreshRequest) return false;
      notice = "Research ledger could not be loaded. Retry.";
      reportError(error, "Could not load Research ledger");
      return false;
    } finally {
      if (requestId === refreshRequest) loading = false;
    }
  }

  async function keepCurrentPassage() {
    if (!researchPageId || !passageText.trim() || savingPassage) return;
    savingPassage = true;
    notice = "";
    try {
      const result = await window.progressLedger.research.capture(Number(profileId), researchPageId, "clip", passageText.trim());
      if (result?.ok === false) throw new Error(result.reason ?? "capture-failed");
      const refreshed = await refresh();
      if (!refreshed) throw new Error("capture-saved-refresh-failed");
      passageText = "";
    } catch (error) {
      notice = error?.message === "capture-saved-refresh-failed"
        ? "Passage may be saved, but Research could not be refreshed. Your text is preserved; retry before assuming the latest state."
        : "Passage was not saved. Your text is preserved; retry when storage is available.";
      reportError(error, "Could not save Research passage");
    } finally { savingPassage = false; }
  }

  async function copyCitation(capture) {
    const title = capture.sourceTitle || capture.source_title || "Research Source";
    const url = capture.sourceUrl || capture.source_url || "";
    const citation = formatCitation({
      title,
      url,
      passage: capture.text,
    }, "markdown");
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(citation);
      }
      notice = "Citation copied to clipboard.";
    } catch (e) {
      reportError(e, "Could not copy citation");
      notice = "Could not copy citation to clipboard.";
    }
  }

  onMount(() => { void refresh(profileId); });
  const rows = $derived([
    ...(filter === "all" || filter === "sources" ? sources.map((source) => ({ type: "source", at: source.savedAt, source })) : []),
    ...(filter === "all" || filter === "kept" ? captures.filter((capture) => capture.kind !== "extraction").map((capture) => ({ type: "capture", at: capture.createdAt ?? capture.created_at, capture })) : []),
    ...(filter === "all" || filter === "operator" ? captures.filter((capture) => capture.kind === "extraction").map((capture) => ({ type: "capture", at: capture.createdAt ?? capture.created_at, capture })) : []),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))));
</script>

<main class="research-ledger-page" data-testid="research-ledger-page">
  <header class="ledger-header">
    <div><p class="eyebrow">RESEARCH</p><h1>Research ledger</h1><p class="sub">Sources and passages kept from Progress Ledger's embedded browser.</p></div>
    <button class="refresh" type="button" aria-label="Refresh Research ledger" onclick={() => refresh()} disabled={loading}><RotateCw size={13} /> Refresh</button>
  </header>
  <nav class="filters" aria-label="Research ledger filter">
    {#each [{id:"all",label:"Ledger"},{id:"sources",label:"Sources"},{id:"kept",label:"Kept passages"},{id:"operator",label:"Operator extractions"}] as item}
      <button type="button" class:active={filter===item.id} aria-pressed={filter===item.id} onclick={() => filter=item.id}>{item.label}</button>
    {/each}
    <span class="count">{rows.length} items</span>
  </nav>
  {#if researchPageId}
    <form class="capture-form" onsubmit={(event) => { event.preventDefault(); void keepCurrentPassage(); }}>
      <label for="research-current-passage">Keep a passage from the active browser page</label>
      <div><textarea id="research-current-passage" data-testid="research-passage-text" bind:value={passageText} maxlength="8000" rows="2" placeholder="Paste selected page text here…"></textarea><button type="submit" data-testid="research-keep-passage" disabled={savingPassage || !passageText.trim()}>Keep passage</button></div>
    </form>
  {/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  <section class="rows" aria-label="Saved sources and captured passages">
    {#each rows as row (row.type === "source" ? `s-${row.source.id}` : `c-${row.capture.id}`)}
      {#if row.type === "source"}
        <article class="row" data-source-id={row.source.id}>
          <Globe size={14} />
          <div class="copy"><strong>{row.source.title}</strong><span>{row.source.domain} · {row.source.keptCount} kept</span><small>{row.source.url}</small></div>
          <button type="button" aria-label={`Open ${row.source.title}`} title="Return to this page" onclick={() => { void onOpenResearchSource(row.source.url); }}><ExternalLink size={13} /></button>
        </article>
      {:else}
        <article class="row" data-capture-id={row.capture.id}>
          <Bookmark size={14} />
          <div class="copy"><strong>{row.capture.kind === "extraction" ? "Operator extraction" : "Kept passage"}</strong><span>{row.capture.sourceTitle || row.capture.source_title || "Research Source"} · {row.capture.kind}</span><p>{row.capture.text}</p><small>{row.capture.sourceUrl || row.capture.source_url || ""}</small></div>
          <div class="row-actions">
            <button type="button" aria-label={`Copy citation for ${row.capture.sourceTitle || row.capture.source_title || "Research Source"}`} title="Copy citation" onclick={() => copyCitation(row.capture)}><Quote size={13} /></button>
            <button type="button" aria-label={`Open source ${row.capture.sourceTitle || row.capture.source_title || "Research Source"}`} title="Return to originating page" onclick={() => { void onOpenResearchSource(row.capture.sourceUrl || row.capture.source_url); }}><ExternalLink size={13} /></button>
          </div>
        </article>
      {/if}
    {/each}
    {#if rows.length === 0}<div class="empty">{filter === "sources" ? "No sources saved yet." : filter === "kept" ? "No passages kept yet." : filter === "operator" ? "No operator extractions yet." : "Save a browser page or keep a passage to begin."}</div>{/if}
  </section>
</main>

<style>
  .research-ledger-page{height:100%;min-height:0;display:flex;flex-direction:column;gap:12px;padding:24px 28px;background:var(--atlas-base);color:var(--atlas-ink);overflow:auto}
  .ledger-header{display:flex;align-items:flex-start;justify-content:space-between;border-bottom:1px solid var(--atlas-line);padding-bottom:14px;gap:16px}
  .eyebrow{margin:0 0 5px;font:10px var(--font-mono);letter-spacing:.08em;color:var(--atlas-ink-4)}
  h1{margin:0;font-size:20px;font-weight:550;letter-spacing:-.02em}.sub{margin:5px 0 0;color:var(--atlas-ink-3);font-size:12px}
  .refresh,.filters button,.row button{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--atlas-line);border-radius:var(--radius-sm);padding:5px 8px;color:var(--atlas-ink-3);background:var(--atlas-panel);font-size:11px}
  .refresh:hover,.filters button:hover,.row button:hover{color:var(--atlas-ink);background:var(--atlas-wash)}.refresh:disabled{opacity:.5}
  .filters{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.filters button.active{color:var(--atlas-ink);border-color:var(--atlas-signal);background:var(--atlas-panel)}.count{margin-left:auto;color:var(--atlas-ink-4);font:10px var(--font-mono)}
  .capture-form{display:flex;flex-direction:column;gap:5px;padding:9px;border:1px solid var(--atlas-line);border-radius:var(--radius-sm);background:var(--atlas-panel)}.capture-form label{font-size:11px;color:var(--atlas-ink-3)}.capture-form>div{display:flex;gap:6px}.capture-form textarea{flex:1;min-width:0;resize:vertical;border:1px solid var(--atlas-line);border-radius:var(--radius-sm);padding:7px;background:var(--atlas-base);color:var(--atlas-ink);font:12px var(--font-sans)}.capture-form button{align-self:center;border:1px solid var(--atlas-line);border-radius:var(--radius-sm);padding:7px 10px;background:var(--atlas-panel);color:var(--atlas-ink);font-size:11px}.capture-form button:disabled{opacity:.45}
  .rows{display:flex;flex-direction:column;gap:6px;overflow:auto}.row{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--atlas-line);border-radius:var(--radius-sm);background:var(--atlas-panel)}.row> :global(svg){margin-top:2px;color:var(--atlas-ink-4);flex:0 0 auto}.row-actions{display:flex;align-items:center;gap:4px}.copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}.copy strong{font-size:12px;font-weight:550}.copy span,.copy small{font-size:10px;color:var(--atlas-ink-4);overflow-wrap:anywhere}.copy p{margin:2px 0;color:var(--atlas-ink-2);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.empty,.notice{padding:24px;text-align:center;color:var(--atlas-ink-4);font-size:12px}.notice{color:var(--atlas-bad)}
</style>
