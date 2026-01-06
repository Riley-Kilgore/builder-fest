import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { NodeGlobalsPolyfillPlugin } from "@esbuild-plugins/node-globals-polyfill";
import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.VITE_BASE ?? (repoName ? `/${repoName}/` : "/");

export default defineConfig({
  base,
  plugins: [wasm(), react()],
  build: {
    target: "esnext",
  },
  define: {
    global: "globalThis",
    "process.env": "{}",
    "process.browser": "true",
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: "globalThis",
        "process.env": "{}",
        "process.browser": "true",
      },
      plugins: [
        NodeGlobalsPolyfillPlugin({
          process: true,
          buffer: true,
        }),
        NodeModulesPolyfillPlugin(),
      ],
    },
  },
  resolve: {
    alias: {
      "libsodium-wrappers-sumo":
        resolve(
          rootDir,
          "node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js",
        ),
      process: "process/browser",
      util: "util",
      events: "events",
      stream: "stream-browserify",
      buffer: "buffer",
    },
  },
});
