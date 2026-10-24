import { describe, it, expect } from "vitest";
import { parseSnippet } from "../src/features/command-palette/snippet.js";

describe("parseSnippet", () => {
  it("splits SQLite <mark> markers into highlighted parts", () => {
    expect(parseSnippet("before <mark>clock</mark> after")).toEqual([
      { t: "before ", hl: false },
      { t: "clock", hl: true },
      { t: " after", hl: false },
    ]);
  });

  it("handles multiple and adjacent highlights", () => {
    const parts = parseSnippet("<mark>a</mark><mark>b</mark> tail");
    expect(parts).toEqual([
      { t: "a", hl: true },
      { t: "b", hl: true },
      { t: " tail", hl: false },
    ]);
  });

  it("passes snippets with no matches through unhighlighted", () => {
    expect(parseSnippet("plain text")).toEqual([{ t: "plain text", hl: false }]);
    expect(parseSnippet("")).toEqual([{ t: "", hl: false }]);
  });
});
