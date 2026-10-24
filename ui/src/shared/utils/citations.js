/**
 * Citation and Source Reference Engine for CareerFlow.
 *
 * Provides citation formatting (Markdown, Inline, APA, IEEE) and grounds
 * quoted passages in actual extracted document text with verified page numbers.
 *
 * Page separation: PDF text extractors (such as pdf-extract) emit form-feed
 * characters (\f / \x0C) between pages. Page numbers are 1-based and strictly
 * grounded in the extracted text.
 */

/**
 * Splits extracted document text into individual pages using form-feed delimiters.
 * @param {string} rawText
 * @returns {Array<{ pageNumber: number, text: string }>}
 */
export function parsePagesFromExtractedText(rawText) {
  if (typeof rawText !== "string" || !rawText) return [];
  const pages = rawText.split(/\f|\x0C/);
  return pages.map((pageText, idx) => ({
    pageNumber: idx + 1,
    text: pageText.trim(),
  })).filter((p) => p.text.length > 0);
}

/**
 * Finds which page contains the specified passage within the extracted text.
 * @param {string} rawText
 * @param {string} passage
 * @returns {{ pageNumber: number | null, found: boolean, snippet: string }}
 */
export function locatePassagePage(rawText, passage) {
  if (typeof rawText !== "string" || typeof passage !== "string") {
    return { pageNumber: null, found: false, snippet: "" };
  }
  const cleanPassage = passage.trim().toLowerCase();
  if (!cleanPassage) return { pageNumber: null, found: false, snippet: "" };

  const pages = parsePagesFromExtractedText(rawText);
  if (pages.length === 0) {
    // Single page document without form feeds
    const found = rawText.toLowerCase().includes(cleanPassage);
    return {
      pageNumber: found ? 1 : null,
      found,
      snippet: found ? passage.trim() : "",
    };
  }

  for (const p of pages) {
    if (p.text.toLowerCase().includes(cleanPassage)) {
      return { pageNumber: p.pageNumber, found: true, snippet: passage.trim() };
    }
  }

  return { pageNumber: null, found: false, snippet: "" };
}

/**
 * Formats a verified citation reference for a document, note, or research source.
 * @param {object} source
 * @param {string} source.title - Document or source title
 * @param {string} [source.author] - Author name or organization
 * @param {string|number} [source.year] - Publication or creation year
 * @param {string} [source.url] - URL for web sources
 * @param {number} [source.resourceId] - Local CareerFlow resource ID
 * @param {string} [source.passage] - Quoted passage or text excerpt
 * @param {number} [source.page] - Verified page number
 * @param {string} [style="markdown"] - Citation style ("markdown" | "inline" | "apa" | "ieee")
 * @returns {string} Formatted citation string
 */
export function formatCitation(source, style = "markdown") {
  if (!source || typeof source !== "object") return "";
  const title = (source.title || "Untitled Document").trim();
  const author = source.author ? source.author.trim() : "";
  const year = source.year ? String(source.year).trim() : "";
  const page = Number.isInteger(source.page) && source.page > 0 ? source.page : null;
  const passage = source.passage ? source.passage.trim() : "";
  const resourceId = source.resourceId ? `#${source.resourceId}` : "";
  const url = source.url ? source.url.trim() : "";

  switch (style.toLowerCase()) {
    case "inline": {
      const pagePart = page ? `, p. ${page}` : "";
      const idPart = resourceId ? ` [${resourceId}]` : "";
      return `[${title}${pagePart}${idPart}]`;
    }

    case "apa": {
      const authorPart = author ? `${author}. ` : "";
      const yearPart = year ? `(${year}). ` : "";
      const pagePart = page ? `, p. ${page}` : "";
      const urlPart = url ? ` Retrieved from ${url}` : "";
      return `${authorPart}${yearPart}${title}${pagePart}.${urlPart}`.trim();
    }

    case "ieee": {
      const authorPart = author ? `${author}, ` : "";
      const yearPart = year ? `, ${year}` : "";
      const pagePart = page ? `, p. ${page}` : "";
      const urlPart = url ? ` [Online]. Available: ${url}` : "";
      return `[1] ${authorPart}“${title}”${yearPart}${pagePart}.${urlPart}`.trim();
    }

    case "markdown":
    default: {
      if (passage) {
        const attribution = [
          author ? `**${author}**` : null,
          `*${title}*`,
          page ? `(p. ${page})` : null,
          resourceId ? `[Doc ${resourceId}]` : null,
        ].filter(Boolean).join(", ");

        return `> "${passage}"\n>\n> — ${attribution}`;
      }

      const ref = [
        author ? `${author}. ` : "",
        `*${title}*`,
        year ? ` (${year})` : "",
        page ? `, p. ${page}` : "",
        resourceId ? ` [Resource ${resourceId}]` : "",
        url ? ` <${url}>` : "",
      ].filter(Boolean).join("");
      return ref;
    }
  }
}

/**
 * Validates and grounds a citation against actual extracted text content.
 * Prevents fabricated page numbers or ungrounded quotes.
 *
 * @param {object} params
 * @param {string} params.rawText - Extracted text from PDF or resource
 * @param {string} params.passage - The passage to quote
 * @param {object} params.meta - Source metadata (title, author, resourceId, url)
 * @param {string} [params.style="markdown"] - Citation style
 * @returns {{ valid: boolean, citation: string, pageNumber: number | null, grounded: boolean, warning?: string }}
 */
export function createGroundedCitation({ rawText, passage, meta = {}, style = "markdown" }) {
  if (typeof passage !== "string" || !passage.trim()) {
    return {
      valid: false,
      citation: "",
      pageNumber: null,
      grounded: false,
      warning: "Passage cannot be empty",
    };
  }

  const cleanPassage = passage.trim();

  if (typeof rawText !== "string" || !rawText.trim()) {
    // Text extraction absent or failed: create citation without fabricated page
    const citation = formatCitation({ ...meta, passage: cleanPassage, page: null }, style);
    return {
      valid: true,
      citation,
      pageNumber: null,
      grounded: false,
      warning: "Document has no extractable text content; page number omitted",
    };
  }

  const { found, pageNumber } = locatePassagePage(rawText, cleanPassage);

  if (!found) {
    const citation = formatCitation({ ...meta, passage: cleanPassage, page: null }, style);
    return {
      valid: true,
      citation,
      pageNumber: null,
      grounded: false,
      warning: "Passage was not located in document text; citation ungrounded",
    };
  }

  const citation = formatCitation({ ...meta, passage: cleanPassage, page: pageNumber }, style);
  return {
    valid: true,
    citation,
    pageNumber,
    grounded: true,
  };
}
