import { describe, it, expect } from "vitest";
import {
  resolveAddressBarInput,
  DEFAULT_SEARCH_ENGINE,
  SEARCH_ENGINES,
  SEARCH_ENGINE_STORAGE_KEY,
  readSearchEngineId,
} from "./addressBar.js";

describe("resolveAddressBarInput", () => {
  it("defaults to DuckDuckGo for plain text", () => {
    expect(DEFAULT_SEARCH_ENGINE).toBe("duckduckgo");
    const r = resolveAddressBarInput("cats");
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("search");
    expect(r.url).toBe("https://duckduckgo.com/?q=cats");
    expect(r.query).toBe("cats");
  });

  it("searches multi-word text and encodes it", () => {
    const r = resolveAddressBarInput("how to bake bread");
    expect(r.kind).toBe("search");
    expect(r.url).toBe("https://duckduckgo.com/?q=how%20to%20bake%20bread");
  });

  it("honours the chosen engine, and falls back to DuckDuckGo for unknown ids", () => {
    expect(resolveAddressBarInput("cats", "bing").url).toBe("https://www.bing.com/search?q=cats");
    expect(resolveAddressBarInput("cats", "google").url).toBe("https://www.google.com/search?q=cats");
    expect(resolveAddressBarInput("cats", "nope").url).toBe("https://duckduckgo.com/?q=cats");
    expect(Object.keys(SEARCH_ENGINES).sort()).toEqual(["bing", "duckduckgo", "google"]);
  });

  it("passes a full http(s) URL through untouched", () => {
    expect(resolveAddressBarInput("https://example.com/a?b=c")).toEqual({
      ok: true,
      kind: "url",
      url: "https://example.com/a?b=c",
    });
    expect(resolveAddressBarInput("http://example.com/").kind).toBe("url");
    expect(resolveAddressBarInput("about:blank")).toEqual({ ok: true, kind: "url", url: "about:blank" });
  });

  it("infers https for a bare host, including localhost with a port", () => {
    expect(resolveAddressBarInput("example.com").url).toBe("https://example.com/");
    expect(resolveAddressBarInput("sub.example.co.uk/path").url).toBe("https://sub.example.co.uk/path");
    expect(resolveAddressBarInput("localhost:3000").url).toBe("https://localhost:3000/");
  });

  it("never navigates a dangerous or credentialed input — it becomes a search query", () => {
    for (const raw of ["javascript:alert(1)", "data:text/html,<h1>x</h1>", "file:///etc/passwd", "user:pass@example.com"]) {
      const r = resolveAddressBarInput(raw);
      expect(r.kind).toBe("search");
      expect(r.url.startsWith("https://duckduckgo.com/?q=")).toBe(true);
    }
  });

  it("refuses empty, non-string, and overlong input", () => {
    expect(resolveAddressBarInput("   ").ok).toBe(false);
    expect(resolveAddressBarInput("").ok).toBe(false);
    expect(resolveAddressBarInput(null).ok).toBe(false);
    expect(resolveAddressBarInput("x".repeat(4097)).ok).toBe(false);
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(resolveAddressBarInput("  cats  ").url).toBe("https://duckduckgo.com/?q=cats");
  });
});

describe("readSearchEngineId", () => {
  it("uses the storage key and falls back to the default", () => {
    expect(SEARCH_ENGINE_STORAGE_KEY).toBe("progressledger_v2_search_engine");
    const store = (value) => ({ getItem: () => value });
    expect(readSearchEngineId(store("bing"))).toBe("bing");
    expect(readSearchEngineId(store("google"))).toBe("google");
    expect(readSearchEngineId(store("duckduckgo"))).toBe("duckduckgo");
    expect(readSearchEngineId(store("nope"))).toBe("duckduckgo");
    expect(readSearchEngineId(store(null))).toBe("duckduckgo");
    expect(readSearchEngineId(undefined)).toBe("duckduckgo");
    expect(readSearchEngineId({ getItem: () => { throw new Error("denied"); } })).toBe("duckduckgo");
  });
});
