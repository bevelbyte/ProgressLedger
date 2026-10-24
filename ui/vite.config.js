import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  plugins: [svelte()],
  base: "./",
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