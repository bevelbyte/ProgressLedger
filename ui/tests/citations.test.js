import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import NoteEditor from "../src/features/notes/components/NoteEditor.svelte";
import {
  parsePagesFromExtractedText,
  locatePassagePage,
  formatCitation,
  createGroundedCitation,
} from "../src/shared/utils/citations.js";

describe("Citations and PDF Source References", () => {
  const multiPageDocument = [
    "Introduction to Distributed Systems.\nThis is the first chapter covering basic consensus principles.",
    "Section 2: The Paxos Protocol.\nPaxos achieves consensus on a single value through two phases: Prepare and Accept.",
    "Section 3: The Raft Protocol.\nRaft decomposes consensus into leader election, log replication, and safety.",
  ].join("\f");

  it("splits extracted text into pages using form-feed delimiters", () => {
    const pages = parsePagesFromExtractedText(multiPageDocument);
    expect(pages).toHaveLength(3);
    expect(pages[0].pageNumber).toBe(1);
    expect(pages[0].text).toContain("Distributed Systems");
    expect(pages[1].pageNumber).toBe(2);
    expect(pages[1].text).toContain("Paxos achieves consensus");
    expect(pages[2].pageNumber).toBe(3);
    expect(pages[2].text).toContain("The Raft Protocol");
  });

  it("returns empty array for empty or whitespace text", () => {
    expect(parsePagesFromExtractedText("")).toEqual([]);
    expect(parsePagesFromExtractedText("   \f   \f  ")).toEqual([]);
  });

  it("locates passages and associates them with correct page numbers", () => {
    const res1 = locatePassagePage(multiPageDocument, "two phases: Prepare and Accept");
    expect(res1.found).toBe(true);
    expect(res1.pageNumber).toBe(2);

    const res2 = locatePassagePage(multiPageDocument, "log replication, and safety");
    expect(res2.found).toBe(true);
    expect(res2.pageNumber).toBe(3);

    const resNotFound = locatePassagePage(multiPageDocument, "Byzantine fault tolerance");
    expect(resNotFound.found).toBe(false);
    expect(resNotFound.pageNumber).toBe(null);
  });

  it("formats citations in Markdown, Inline, APA, and IEEE styles", () => {
    const meta = {
      title: "Distributed Systems: Principles and Paradigms",
      author: "Andrew S. Tanenbaum",
      year: 2023,
      page: 42,
      resourceId: 101,
      passage: "A distributed system is a collection of autonomous computing elements.",
    };

    const md = formatCitation(meta, "markdown");
    expect(md).toContain('> "A distributed system is a collection of autonomous computing elements."');
    expect(md).toContain("**Andrew S. Tanenbaum**");
    expect(md).toContain("*Distributed Systems: Principles and Paradigms*");
    expect(md).toContain("(p. 42)");
    expect(md).toContain("[Doc #101]");

    const inline = formatCitation(meta, "inline");
    expect(inline).toBe("[Distributed Systems: Principles and Paradigms, p. 42 [#101]]");

    const apa = formatCitation(meta, "apa");
    expect(apa).toContain("Andrew S. Tanenbaum. (2023). Distributed Systems: Principles and Paradigms, p. 42.");

    const ieee = formatCitation(meta, "ieee");
    expect(ieee).toContain("[1] Andrew S. Tanenbaum, “Distributed Systems: Principles and Paradigms”, 2023, p. 42.");
  });

  it("grounds citations in extracted text and avoids fabricated page numbers", () => {
    const meta = {
      title: "Consensus Algorithms Overview",
      author: "Leslie Lamport",
      resourceId: 55,
    };

    // Grounded passage on Page 2
    const grounded = createGroundedCitation({
      rawText: multiPageDocument,
      passage: "Paxos achieves consensus on a single value",
      meta,
      style: "markdown",
    });
    expect(grounded.valid).toBe(true);
    expect(grounded.grounded).toBe(true);
    expect(grounded.pageNumber).toBe(2);
    expect(grounded.citation).toContain("(p. 2)");

    // Ungrounded passage: not present in text
    const ungrounded = createGroundedCitation({
      rawText: multiPageDocument,
      passage: "Fabricated quote that does not exist in document",
      meta,
      style: "markdown",
    });
    expect(ungrounded.valid).toBe(true);
    expect(ungrounded.grounded).toBe(false);
    expect(ungrounded.pageNumber).toBeNull();
    expect(ungrounded.warning).toContain("Passage was not located");
    // Does NOT contain a fabricated page number
    expect(ungrounded.citation).not.toContain("(p.");

    // Document with empty text (e.g. scanned image PDF without OCR)
    const emptyDoc = createGroundedCitation({
      rawText: "",
      passage: "Some excerpt",
      meta,
      style: "markdown",
    });
    expect(emptyDoc.valid).toBe(true);
    expect(emptyDoc.grounded).toBe(false);
    expect(emptyDoc.pageNumber).toBeNull();
    expect(emptyDoc.warning).toContain("no extractable text");
  });

  it("rejects empty passages", () => {
    const res = createGroundedCitation({
      rawText: multiPageDocument,
      passage: "   ",
      meta: { title: "Doc" },
    });
    expect(res.valid).toBe(false);
    expect(res.warning).toContain("Passage cannot be empty");
  });
});

describe("NoteEditor Grounded Citation Workflow", () => {
  afterEach(() => {
    cleanup();
    delete window.progressLedger;
  });

  it("grounds passage against subject PDF and inserts citation with page attribution", async () => {
    const pdfContent = [
      "Page 1: Introduction to Operating Systems",
      "Page 2: Memory Management and Virtual Memory Algorithms",
    ].join("\f");

    window.progressLedger = {
      resources: {
        list: vi.fn(async () => [
          { id: 10, title: "OS Textbook.pdf", kind: "pdf" },
          { id: 11, title: "Lecture Notes", kind: "note" },
        ]),
        get: vi.fn(async ({ id }) => {
          if (id === 10) {
            return { id: 10, title: "OS Textbook.pdf", kind: "pdf", content: pdfContent };
          }
          return null;
        }),
      },
    };

    render(NoteEditor, {
      props: {
        open: true,
        profileId: 1,
        subjectId: 5,
        resourceId: null,
      },
    });

    const citeBtn = screen.getByTestId("note-cite-btn");
    await fireEvent.click(citeBtn);

    expect(await screen.findByTestId("cite-drawer")).toBeTruthy();
    expect(await screen.findByText("OS Textbook.pdf")).toBeTruthy();

    const passageInput = screen.getByTestId("cite-passage-input");
    await fireEvent.input(passageInput, {
      target: { value: "Virtual Memory Algorithms" },
    });

    const insertBtn = screen.getByTestId("insert-citation-btn");
    await fireEvent.click(insertBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("cite-drawer")).toBeNull();
    });

    const textarea = screen.getByPlaceholderText(/Write your notes here/);
    expect(textarea.value).toContain('> "Virtual Memory Algorithms"');
    expect(textarea.value).toContain("*OS Textbook.pdf*");
    expect(textarea.value).toContain("(p. 2)");
  });
});

