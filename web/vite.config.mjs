import { defineConfig } from "vite";

export default defineConfig({
  test: {
    exclude: ["e2e/**", "node_modules/**"],
  },
  build: {
    target: "es2022",
    outDir: "../src/host_monitor/static/dashboard",
    emptyOutDir: false,
    sourcemap: false,
    cssCodeSplit: true,
    assetsInlineLimit: 2048,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:9108",
        ws: true,
      },
      "/metrics": "http://127.0.0.1:9108",
      "/healthz": "http://127.0.0.1:9108",
    },
  },
});
