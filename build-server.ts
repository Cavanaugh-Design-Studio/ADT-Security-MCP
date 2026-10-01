import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: {
    main: path.join(packageRoot, "src/main.ts"),
    server: path.join(packageRoot, "src/server.ts"),
  },
  outdir: path.join(packageRoot, "dist"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  packages: "external",
  banner: {
    js: "#!/usr/bin/env node",
  },
});

console.error("ADT MCP server build complete");
