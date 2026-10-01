import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const input = process.env.INPUT ?? "mcp-app.html";
const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(packageRoot, "src"),
  plugins: [react(), viteSingleFile()],
  server: { strictPort: true },
  build: {
    outDir: path.join(packageRoot, "dist"),
    emptyOutDir: false,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: path.join(packageRoot, "src", input),
      output: {
        entryFileNames: "mcp-app.js",
        assetFileNames: "mcp-app[extname]",
      },
    },
  },
});
