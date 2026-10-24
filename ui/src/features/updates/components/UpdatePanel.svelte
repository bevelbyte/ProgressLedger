<script>
  import { toast } from "../../../shared/stores/toasts.svelte.js";
  import { updateService } from "../services/update.service.js";
  import UpdateCard from "./UpdateCard.svelte";

  let status = $state({ status: "idle" });
  let checking = $state(false);
  let downloading = $state(false);

  // Subscribe to update status events from main process
  $effect(() => {
    const unsubscribe = updateService.onStatus((payload) => {
      status = payload;
      checking = payload.status === "checking";
      downloading = payload.status === "downloading";

      // Show toasts for important events.
      //
      // `toast.*` has the signature (message, title) where BOTH are strings
      // (see shared/stores/toasts.svelte.js). Passing an options object here
      // made Toaster render `String({duration:8000})` — the literal text
      // "[object Object]" — as the toast TITLE, and the `description` (the
      // only human-readable part) was never displayed at all. The store has no
      // `duration` option, so the object carried no behaviour either: it was
      // pure loss. The failure reason now goes in the message slot where it
      // is actually shown.
      if (payload.status === "available") {
        toast.info(`Update v${payload.version} available`, "Update available");
      } else if (payload.status === "downloaded") {
        toast.success(
          `Update v${payload.version} is ready to install.`,
          "Update ready"
        );
      } else if (payload.status === "error") {
        toast.error(payload.message || "Update failed.", "Update failed");
      }
    });

    return unsubscribe;
  });

  async function checkForUpdates() {
    checking = true;
    try {
      const result = await updateService.check();
      if (result.status === "disabled") {
        toast.warning(result.message || "Auto-updater disabled.", "Auto-updater disabled");
      }
    } catch (e) {
      toast.error(e?.message ?? String(e), "Update check failed");
    } finally {
      checking = false;
    }
  }

  async function downloadUpdate() {
    downloading = true;
    try {
      const result = await updateService.download();
      if (result.status === "error") {
        toast.error(result.message || "Download failed.", "Download failed");
      }
    } catch (e) {
      toast.error(e?.message ?? String(e), "Download failed");
      downloading = false;
    }
  }

  async function installUpdate() {
    try {
      await updateService.install();
      // App will quit and install, no need to handle response
    } catch (e) {
      toast.error(e?.message ?? String(e), "Install failed");
    }
  }
</script>

<section class="update-panel">
  <header>
    <h2>Software Updates</h2>
    <p class="subtitle">Keep CareerFlow up to date with the latest features and fixes</p>
  </header>

  <UpdateCard 
    {status} 
    {checking} 
    {downloading} 
    onCheck={checkForUpdates} 
    onDownload={downloadUpdate} 
    onInstall={installUpdate} 
  />

  <div class="info-box">
    <h4>About Updates</h4>
    <ul>
      <li>Updates are checked automatically when you start CareerFlow</li>
      <li>You can also check manually at any time</li>
      <li>Updates are downloaded in the background</li>
      <li>The app will restart to install updates (your data is safe)</li>
    </ul>
  </div>
</section>

<style>
  .update-panel {
    max-width: 700px;
    margin: 0 auto;
  }

  header {
    margin-bottom: 24px;
  }

  h2 {
    font-size: var(--text-2xl);
    font-weight: 600;
    margin: 0 0 8px 0;
    color: var(--text-primary, var(--atlas-ink));
  }

  .subtitle {
    color: var(--text-secondary, var(--atlas-ink-3));
    margin: 0;
    font-size: var(--text-lg);
  }

  .info-box {
    background: var(--bg-secondary, var(--atlas-panel));
    border: 1px solid var(--border, var(--atlas-line));
    border-radius: var(--radius-lg);
    padding: 16px;
  }

  .info-box h4 {
    margin: 0 0 12px 0;
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text-primary, var(--atlas-ink));
  }

  .info-box ul {
    margin: 0;
    padding-left: 20px;
    color: var(--text-secondary, var(--atlas-ink-3));
    font-size: var(--text-md);
    line-height: 1.6;
  }

  .info-box li {
    margin-bottom: 4px;
  }
</style>
