// Playwright-over-CDP session — the ONLY place CareerFlow talks to a browser
// over the official Donut per-profile CDP endpoint.
//
// Official integration contract (Donut 0.31.x docs):
//   POST /v1/profiles/{id}/run  ->  { remote_debugging_port }
//   chromium.connectOverCDP(`http://127.0.0.1:<port>`)
//   -> normal Playwright Page/BrowserContext APIs
//
// This module owns the Playwright connection and a provider-internal page
// mapping (opaque tab ids). Nothing here is renderer-visible: tab ids are
// session-local tokens, never CDP target ids, and the endpoint URL is
// constructed here from a validated loopback port only. Playwright never
// crosses the provider boundary (pinned by
// scripts/check-cdp-auth-boundary.mjs).
//
// Ownership rule: open() CONNECTS to an externally running browser and
// close() only DISCONNECTS this client. close() must never stop the browser
// or the provider runtime — Playwright's Browser.close() on a CDP-connected
// browser is documented to clear contexts and disconnect, not to kill the
// browser process.

export const CONNECT_TIMEOUT_MS = 8000;
export const OP_TIMEOUT_MS = 8000;

function validPort(port) {
  // Strict: only a genuine number may become a connection target. A numeric
  // STRING would coerce through Number(), which would let crafted input reach
  // the endpoint construction, so the type is checked first.
  if (typeof port !== "number") return null;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function isConnectionError(error) {
  const msg = String(error?.message || error || "");
  return /target (page|closed|crashed)|protocol error|connection closed|browser has been closed|websocket|econnrefused|econnreset|socket hang up/i.test(
    msg,
  );
}

async function defaultConnect(endpointUrl) {
  const { chromium } = await import("playwright-core");
  return chromium.connectOverCDP(endpointUrl, { timeout: CONNECT_TIMEOUT_MS });
}

/**
 * Session manager keyed by provider profile id. Injectable `connect` keeps
 * every test hermetic: the fake supplies Playwright-shaped browser/context/
 * page objects and no socket is ever opened.
 */
export function createCdpSession({ connect = defaultConnect } = {}) {
  const sessions = new Map();

  function attachPage(record, page, tabId) {
    record.pages.set(tabId, page);
    record.pageIds.set(page, tabId);
    page.on?.("close", () => {
      if (record.pages.get(tabId) === page) {
        record.pages.delete(tabId);
        record.pageIds.delete(page);
        if (record.activeTabId === tabId) {
          record.activeTabId = record.pages.keys().next().value ?? null;
        }
      }
    });
    return tabId;
  }

  /**
   * Attach a page exactly once. Playwright's context.newPage() fires the
   * context "page" event before it resolves, so a caller-side attach would
   * otherwise register the same page under two tab ids. The event listener
   * and the creating call both funnel through here.
   */
  function ensureAttached(record, page) {
    const existing = record.pageIds.get(page);
    if (existing) return existing;
    return attachPage(record, page, `tab-${(record.seq += 1)}`);
  }

  function mapExistingPages(record, context) {
    const existing = context.pages();
    for (const page of existing) {
      ensureAttached(record, page);
    }
    if (record.activeTabId == null || !record.pages.has(record.activeTabId)) {
      record.activeTabId = record.pages.keys().next().value ?? null;
    }
  }

  function get(donutId) {
    return sessions.get(String(donutId)) ?? null;
  }

  function drop(donutId) {
    const record = sessions.get(String(donutId));
    if (!record) return;
    sessions.delete(String(donutId));
    Promise.resolve(record.browser.close()).catch(() => {});
  }

  async function open(donutId, port) {
    const key = String(donutId);
    const p = validPort(port);
    if (p === null) return { ok: false, reason: "backend-unavailable" };
    const existing = sessions.get(key);
    if (existing) {
      if (Number(existing.port) === p) return { ok: true, reused: true };
      drop(key);
    }
    let browser;
    try {
      // Loopback endpoint constructed from a validated port number only.
      // No /json discovery, no DevTools URL building, no raw socket.
      browser = await connect(`http://127.0.0.1:${p}`);
    } catch {
      return { ok: false, reason: "backend-unavailable" };
    }
    const context = browser?.contexts?.()?.[0] ?? null;
    if (!context) {
      Promise.resolve(browser?.close?.()).catch(() => {});
      return { ok: false, reason: "backend-unavailable" };
    }
    const record = {
      donutId: key,
      port: p,
      browser,
      context,
      pages: new Map(),
      pageIds: new WeakMap(),
      activeTabId: null,
      seq: 0,
    };
    mapExistingPages(record, context);
    context.on?.("page", (page) => {
      ensureAttached(record, page);
    });
    sessions.set(key, record);
    return { ok: true };
  }

  function requirePage(record, tabId) {
    const page = record.pages.get(String(tabId));
    return page ?? null;
  }

  async function safeOp(donutId, tabId, fn, { missing = "invalid-tab", failReason = "backend-unavailable" } = {}) {
    const record = get(donutId);
    if (!record) return { ok: false, reason: "backend-unavailable" };
    const page = requirePage(record, tabId);
    if (!page) return { ok: false, reason: missing };
    try {
      return await fn(record, page);
    } catch (error) {
      if (isConnectionError(error)) {
        drop(donutId);
        return { ok: false, reason: "backend-unavailable" };
      }
      return { ok: false, reason: failReason };
    }
  }

  return {
    open,
    drop,
    isOpen: (donutId) => get(donutId) !== null,
    portOf: (donutId) => get(donutId)?.port ?? null,

    async tabs(donutId) {
      const record = get(donutId);
      if (!record) return { ok: false, reason: "backend-unavailable" };
      const snap = [];
      for (const [id, page] of record.pages) {
        let title = "";
        let url = "";
        try {
          title = typeof page.title === "function" ? await page.title() : "";
          url = typeof page.url === "function" ? String(page.url() ?? "") : "";
        } catch (error) {
          if (isConnectionError(error)) {
            drop(donutId);
            return { ok: false, reason: "backend-unavailable" };
          }
        }
        snap.push({ id, title, url, active: id === record.activeTabId });
      }
      return { ok: true, tabs: snap };
    },

    async newTab(donutId) {
      const record = get(donutId);
      if (!record) return { ok: false, reason: "backend-unavailable" };
      try {
        const page = await record.context.newPage();
        // The context "page" event may have attached this page already;
        // ensureAttached is idempotent and returns its tab id.
        const tabId = ensureAttached(record, page);
        record.activeTabId = tabId;
        return { ok: true, tabId };
      } catch (error) {
        if (isConnectionError(error)) drop(donutId);
        return { ok: false, reason: "backend-unavailable" };
      }
    },

    async openUrl(donutId, url) {
      const record = get(donutId);
      if (!record) return { ok: false, reason: "backend-unavailable" };
      try {
        const page = await record.context.newPage();
        const tabId = ensureAttached(record, page);
        record.activeTabId = tabId;
        try {
          await page.goto(url, { waitUntil: "commit", timeout: OP_TIMEOUT_MS });
        } catch {
          // The tab exists even when the navigation itself errors (slow or
          // broken page). Open-URL semantics are "create the tab", matching
          // the REST open-url contract; page-side failures are not op failures.
        }
        return { ok: true, tabId };
      } catch (error) {
        if (isConnectionError(error)) drop(donutId);
        return { ok: false, reason: "backend-unavailable" };
      }
    },

    closeTab: (donutId, tabId) =>
      safeOp(donutId, tabId, async (record, page) => {
        await page.close();
        return { ok: true };
      }),

    activateTab: (donutId, tabId) =>
      safeOp(donutId, tabId, async (record, page) => {
        await page.bringToFront();
        record.activeTabId = String(tabId);
        return { ok: true };
      }),

    reload: (donutId, tabId) =>
      safeOp(donutId, tabId, async (_record, page) => {
        await page.reload({ timeout: OP_TIMEOUT_MS });
        return { ok: true };
      }),

    back: (donutId, tabId) =>
      safeOp(donutId, tabId, async (_record, page) => {
        await page.goBack({ timeout: OP_TIMEOUT_MS });
        return { ok: true };
      }),

    forward: (donutId, tabId) =>
      safeOp(donutId, tabId, async (_record, page) => {
        await page.goForward({ timeout: OP_TIMEOUT_MS });
        return { ok: true };
      }),

    pageInfo: (donutId, tabId) =>
      safeOp(donutId, tabId, async (_record, page) => {
        const title = typeof page.title === "function" ? await page.title() : "";
        const url = typeof page.url === "function" ? String(page.url() ?? "") : "";
        return { ok: true, title: String(title ?? ""), url };
      }),

    screenshot: (donutId, tabId) =>
      safeOp(donutId, tabId, async (_record, page) => {
        const buffer = await page.screenshot({ type: "png" });
        return {
          ok: true,
          dataUrl: `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`,
        };
      }),

    evaluate: (donutId, tabId, expression) =>
      safeOp(
        donutId,
        tabId,
        async (_record, page) => {
          const value = await page.evaluate(expression);
          return { ok: true, value };
        },
        { failReason: "evaluate-failed" },
      ),

    mouseClick: (donutId, tabId, x, y) =>
      safeOp(donutId, tabId, async (_record, page) => {
        await page.mouse.click(x, y);
        return { ok: true };
      }),

    insertText: (donutId, tabId, text) =>
      safeOp(donutId, tabId, async (_record, page) => {
        await page.keyboard.insertText(text);
        return { ok: true };
      }),

    pressKey: (donutId, tabId, keyName) =>
      safeOp(donutId, tabId, async (_record, page) => {
        await page.keyboard.press(keyName);
        return { ok: true };
      }),
  };
}

let shared = null;
export function sharedCdpSession() {
  if (!shared) shared = createCdpSession();
  return shared;
}
export function _resetSharedCdpSession() {
  shared = null;
}
