const { ipcRenderer } = require("electron");

function probe() {
  ipcRenderer.invoke("profiles:list")
    .then((result) => {
      const reason = result && result.ok === false ? result.reason : "executed";
      document.title = `${window.top === window ? "main" : "child"}:${reason}`;
    })
    .catch(() => {
      document.title = `${window.top === window ? "main" : "child"}:rejected`;
    });
}

process.once("loaded", () => {
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", probe, { once: true });
    else probe();
  }
});
