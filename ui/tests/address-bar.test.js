// Address-bar input resolution: the URL / search / refusal contract,
// including the local-file refusal (Task A). Pure module, no DOM.
import { describe, it, expect } from "vitest";
import { resolveAddressBarInput, ADDRESS_BAR_REASONS } from "../src/features/browser/addressBar.js";

const LOCAL_MESSAGE =
  "Local files cannot be typed here. Use Open file to choose a file from your computer.";

describe("resolveAddressBarInput", () => {
  it("passes a full http(s) URL through", () => {
    expect(resolveAddressBarInput("https://example.com/a?b=1")).toEqual({
      ok: true,
      kind: "url",
      url: "https://example.com/a?b=1",
    });
    expect(resolveAddressBarInput("http://example.com/").kind).toBe("url");
  });

  it("infers https for a bare host", () => {
    expect(resolveAddressBarInput("example.com")).toEqual({
      ok: true,
      kind: "url",
      url: "https://example.com/",
    });
    expect(resolveAddressBarInput("localhost:3000").kind).toBe("url");
  });

  it("searches plain text with the chosen engine", () => {
    expect(resolveAddressBarInput("cats")).toEqual({
      ok: true,
      kind: "search",
      url: "https://duckduckgo.com/?q=cats",
      query: "cats",
    });
    expect(resolveAddressBarInput("cats", "bing").url).toBe("https://www.bing.com/search?q=cats");
    expect(resolveAddressBarInput("cats", "google").url).toBe("https://www.google.com/search?q=cats");
    expect(resolveAddressBarInput("cats", "nope").url).toBe("https://duckduckgo.com/?q=cats");
  });

  it("refuses empty and overlong input", () => {
    expect(resolveAddressBarInput("   ")).toEqual({ ok: false, reason: ADDRESS_BAR_REASONS.EMPTY });
    expect(resolveAddressBarInput("x".repeat(4097))).toEqual({ ok: false, reason: ADDRESS_BAR_REASONS.INVALID });
    expect(resolveAddressBarInput(42)).toEqual({ ok: false, reason: ADDRESS_BAR_REASONS.INVALID });
  });

  it("passes about:blank through", () => {
    expect(resolveAddressBarInput("about:blank")).toEqual({ ok: true, kind: "url", url: "about:blank" });
  });

  it("sends dangerous schemes to search, never to a navigation", () => {
    expect(resolveAddressBarInput("javascript:alert(1)").kind).toBe("search");
    expect(resolveAddressBarInput("data:text/html,hi").kind).toBe("search");
  });

  it("refuses local file references with the Open file message", () => {
    // The exact shape the user pasted: a colon-less file path whose
    // ".pdf" dot used to make it look like a host (https://file///...).
    expect(
      resolveAddressBarInput("file///C:/Users/Asus/Downloads/Diploma_Document_30-Jul-2026_04_33.pdf"),
    ).toEqual({ ok: false, reason: ADDRESS_BAR_REASONS.LOCAL_FILE, message: LOCAL_MESSAGE });
    expect(resolveAddressBarInput("file:///C:/Users/Asus/Downloads/x.pdf")).toEqual({
      ok: false,
      reason: ADDRESS_BAR_REASONS.LOCAL_FILE,
      message: LOCAL_MESSAGE,
    });
    expect(resolveAddressBarInput("FILE:///C:/x.pdf").reason).toBe(ADDRESS_BAR_REASONS.LOCAL_FILE);
    expect(resolveAddressBarInput("C:\\Users\\Asus\\Downloads\\x.pdf").reason).toBe(
      ADDRESS_BAR_REASONS.LOCAL_FILE,
    );
    expect(resolveAddressBarInput("C:/Users/Asus/x.png").reason).toBe(ADDRESS_BAR_REASONS.LOCAL_FILE);
    expect(resolveAddressBarInput("\\\\server\\share\\x.pdf").reason).toBe(ADDRESS_BAR_REASONS.LOCAL_FILE);
    expect(resolveAddressBarInput("file/C:/x.pdf").reason).toBe(ADDRESS_BAR_REASONS.LOCAL_FILE);
  });

  it("still treats a bare dotted word as a host, not a file", () => {
    // "file.pdf" has no scheme, drive, or slash: the bare-host rule owns it.
    expect(resolveAddressBarInput("file.pdf")).toEqual({
      ok: true,
      kind: "url",
      url: "https://file.pdf/",
    });
  });
});
