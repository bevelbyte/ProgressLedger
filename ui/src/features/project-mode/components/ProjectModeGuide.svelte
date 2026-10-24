<script>
  // ProjectModeGuide — in-app user guide modal.
  // Loads docs/PROJECT-MODE-GUIDE.md on mount and renders it as HTML.
  // Styling follows the KeybindingsHelp modal pattern.
  import { X } from "lucide-svelte";

  let { onClose } = $props();

  let loading = $state(true);
  let error = $state(null);
  let html = $state("");

  const GUIDE_URL = "docs/PROJECT-MODE-GUIDE.md";

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inline(s) {
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return out;
  }

  // Minimal markdown -> HTML for the project's guide file.
  // Supports: H1, H2, paragraphs, unordered lists, fenced code blocks,
  // inline `code` and **bold**. Anything else is rendered as plain text.
  function renderMarkdown(src) {
    const lines = src.split(/\r?\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith("# ")) {
        out.push(`<h1>${inline(line.slice(2).trim())}</h1>`);
        i++;
        continue;
      }
      if (line.startsWith("## ")) {
        out.push(`<h2>${inline(line.slice(3).trim())}</h2>`);
        i++;
        continue;
      }
      if (line.startsWith("```")) {
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // closing fence
        out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
          i++;
        }
        out.push(
          "<ul>" + items.map((it) => `<li>${inline(it)}</li>`).join("") + "</ul>"
        );
        continue;
      }

      if (line.trim() === "") {
        i++;
        continue;
      }

      // Paragraph: collect contiguous non-empty, non-special lines.
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !lines[i].startsWith("# ") &&
        !lines[i].startsWith("## ") &&
        !lines[i].startsWith("```") &&
        !/^\s*[-*]\s+/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
    return out.join("\n");
  }

  $effect(() => {
    let cancelled = false;
    loading = true;
    error = null;
    fetch(GUIDE_URL, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((md) => {
        if (cancelled) return;
        html = renderMarkdown(md);
        loading = false;
      })
      .catch((e) => {
        if (cancelled) return;
        error = String(e && e.message ? e.message : e);
        loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function close() {
    onClose?.();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={close} role="presentation">
  <div
    class="modal"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    aria-label="Project Mode user guide"
    tabindex="-1"
    data-testid="project-mode-guide-modal"
  >
    <header class="modal-header" data-testid="project-mode-guide-header">
      <h3>Project Mode Guide</h3>
      <button
        class="close-btn"
        onclick={close}
        data-testid="project-mode-guide-close"
        aria-label="Close"
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </header>

    <div class="modal-body" data-testid="project-mode-guide-body">
      {#if loading}
        <p class="status" data-testid="project-mode-guide-loading">Loading guide…</p>
      {:else if error}
        <p class="status error" data-testid="project-mode-guide-error">
          Could not load guide: {error}
        </p>
      {:else}
        <div class="markdown" data-testid="project-mode-guide-content">{@html html}</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: var(--atlas-scrim);
    backdrop-filter: blur(4px);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 8vh;
  }

  .modal {
    width: min(720px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl);
    box-shadow: 0 16px 48px var(--atlas-scrim);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 82vh;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
  }

  .modal-header h3 {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text-main);
    margin: 0;
  }

  .close-btn {
    font-size: var(--text-md);
    color: var(--text-muted);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    transition: color var(--trans-fast), border-color var(--trans-fast);
  }

  .close-btn:hover {
    color: var(--text-main);
    border-color: var(--border-strong);
  }

  .modal-body {
    overflow-y: auto;
    padding: 16px 24px 24px;
  }

  .status {
    color: var(--text-muted);
    font-size: var(--text-lg);
    margin: 0;
  }
  .status.error {
    color: var(--danger, var(--atlas-bad));
  }

  .markdown :global(h1) {
    font-size: var(--text-2xl);
    color: var(--text-main);
    margin: 0 0 12px;
  }
  .markdown :global(h2) {
    font-size: var(--text-xl);
    color: var(--text-main);
    margin: 20px 0 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }
  .markdown :global(p) {
    color: var(--text-secondary);
    line-height: 1.55;
    font-size: var(--text-lg);
    margin: 8px 0;
  }
  .markdown :global(ul) {
    margin: 6px 0 6px 20px;
    padding: 0;
    color: var(--text-secondary);
    font-size: var(--text-lg);
    line-height: 1.5;
  }
  .markdown :global(li) {
    margin: 4px 0;
  }
  .markdown :global(code) {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
    font-size: var(--text-md);
    color: var(--accent);
  }
  .markdown :global(pre) {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 12px;
    overflow-x: auto;
  }
  .markdown :global(pre code) {
    border: none;
    background: transparent;
    padding: 0;
  }
  .markdown :global(strong) {
    color: var(--text-main);
  }
</style>