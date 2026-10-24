import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { execSync } from "node:child_process";

// Build ID shown in the status bar: "<git short hash> <ISO build time>".
// Falls back to "dev" when git is unavailable (e.g. a source export).
let buildId = "dev";
try {
  const hash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  if (hash) buildId = `${hash} ${new Date().toISOString()}`;
} catch { /* keep "dev" */ }

export default defineConfig({
  plugins: [svelte()],
  base: "./",
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("katex")) return "katex";
            if (id.includes("lucide-svelte")) return "icons";
            if (id.includes("/svelte/")) return "svelte-vendor";
            return "vendor";
          }
          return undefined;
        }
      }
    }
  }
});