import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Vitest config for component tests. Svelte 5 needs the "browser" resolve
// condition so its client runtime (not SSR) is loaded under jsdom. We also inline
// @testing-library/svelte(-core) so Vite transforms the .svelte helper it ships.
export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: { conditions: ["browser"] },
  test: {
    maxWorkers: 4,
    minWorkers: 1,
    pool: "forks",
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.js"],
    server: {
      deps: { inline: [/@testing-library\/svelte/, /@testing-library\/svelte-core/] },
    },
  },
});
