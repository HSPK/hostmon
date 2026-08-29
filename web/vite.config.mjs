import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({mode}) => {
  const plugin = mode === "plugin";
  return {
    define: {
      __HOSTMON_PLUGIN_UI__: JSON.stringify(plugin),
    },
    test: {
      exclude: ["e2e/**", "node_modules/**"],
    },
    build: {
      target: "es2022",
      outDir: resolve(
        root,
        plugin
          ? "../plugins/cluster-gpu/static/dashboard"
          : "../src/host_monitor/static/dashboard",
      ),
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
  };
});
