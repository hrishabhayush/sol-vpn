import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  // ledger/client (../ledger) is built for Node: shim its builtins and resolve its deps from app/node_modules.
  resolve: {
    alias: [
      { find: /^(node:)?(crypto|fs)$/, replacement: "/src/node-shim.ts" },
      { find: /^@anchor-lang\/core$/, replacement: "/src/anchor-shim.ts" },
    ],
    dedupe: ["@anchor-lang/core", "@arcium-hq/client", "@solana/web3.js", "@solana/spl-token", "buffer"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    fs: { allow: [".."] },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
