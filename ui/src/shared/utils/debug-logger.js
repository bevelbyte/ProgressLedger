/**
 * Global Debug Logger Utility
 * Handles click tracking, global exception handlers, and component lifecycle logging
 */

export function initDebugLogger() {
  function logClick(e) {
    const isDebug = localStorage.getItem("careerflow_debug_mode") === "true";
    const isClickLog = localStorage.getItem("careerflow_click_logging") === "true";
    if (!isDebug && !isClickLog) return;

    const btn = e.target.closest("button, a, input, select");
    if (btn) {
      const isSidebar = btn.closest(".left-sidebar") || btn.closest(".nav-group") || btn.classList.contains("nav-item");
      const eventType = isSidebar ? "sidebar_click" : "button_click";
      const label = btn.innerText || btn.value || btn.placeholder || "";
      const msg = `[UI Click] ${isSidebar ? "Sidebar" : "Button"}: "${label.trim()}" (${btn.tagName.toLowerCase()})`;

      if (isClickLog) {
        console.log("[ClickLogger]", msg, btn);
      }

      if (isDebug) {
        window.careerflow?.diagnostics?.appendLog("info", msg, {
          timestamp: new Date().toISOString(),
          component: "UI",
          function: "logClick",
          event: eventType,
          tagName: btn.tagName,
          id: btn.id || null,
          className: btn.className || null,
          innerText: label.trim(),
          path: isSidebar ? "Sidebar" : "Main view"
        });
      }
    }
  }

  function handleException(message, source, lineno, colno, error) {
    if (localStorage.getItem("careerflow_debug_mode") === "true") {
      window.careerflow?.diagnostics?.appendLog("error", `[Unhandled Exception] ${message}`, {
        timestamp: new Date().toISOString(),
        component: "Exceptions",
        event: "exception",
        message,
        source,
        lineno,
        colno,
        stack: error?.stack || ""
      });
    }
  }

  function handleRejection(e) {
    if (localStorage.getItem("careerflow_debug_mode") === "true") {
      window.careerflow?.diagnostics?.appendLog("error", `[Unhandled Promise Rejection] ${e.reason}`, {
        timestamp: new Date().toISOString(),
        component: "Exceptions",
        event: "promise_rejection",
        reason: String(e.reason),
        stack: e.reason?.stack || ""
      });
    }
  }

  const errHandler = (e) => handleException(e.message, e.filename, e.lineno, e.colno, e.error);
  const rejHandler = (e) => handleRejection(e);

  window.addEventListener("click", logClick, true);
  window.addEventListener("error", errHandler);
  window.addEventListener("unhandledrejection", rejHandler);

  return () => {
    window.removeEventListener("click", logClick, true);
    window.removeEventListener("error", errHandler);
    window.removeEventListener("unhandledrejection", rejHandler);
  };
}

export function logViewLifecycle(event, viewName) {
  const isDebug = localStorage.getItem("careerflow_debug_mode") === "true";
  if (isDebug && viewName) {
    window.careerflow?.diagnostics?.appendLog("info", `[Component Lifecycle] ${event === "mount" ? "Mounted" : "Unmounted"} view "${viewName}"`, {
      timestamp: new Date().toISOString(),
      component: "UI",
      event,
      view: viewName
    });
  }
}
