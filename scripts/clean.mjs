import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(packageRoot, "dist");

if (path.dirname(target) !== packageRoot || path.basename(target) !== "dist") {
  throw new Error(`Refusing to clean unexpected path: ${target}`);
}

await rm(target, { recursive: true, force: true });
