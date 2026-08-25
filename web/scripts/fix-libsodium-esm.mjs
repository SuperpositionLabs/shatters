// Works around an upstream packaging gap: libsodium-wrappers-sumo's ESM entry
// imports ./libsodium-sumo.mjs, which ships in the separate libsodium-sumo
// package instead of alongside it. Upstream relies on a lifecycle hook that
// modern npm blocks by default, so we perform the copy ourselves.
// Idempotent and safe on every platform.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(
  root,
  "node_modules",
  "libsodium-wrappers-sumo",
  "dist",
  "modules-sumo-esm",
);
const target = join(targetDir, "libsodium-sumo.mjs");
const source = join(
  root,
  "node_modules",
  "libsodium-sumo",
  "dist",
  "modules-sumo-esm",
  "libsodium-sumo.mjs",
);

if (!existsSync(source)) {
  console.warn("[fix-libsodium-esm] libsodium-sumo not installed; skipping.");
  process.exit(0);
}
if (!existsSync(target)) {
  copyFileSync(source, target);
  console.log("[fix-libsodium-esm] patched libsodium-wrappers-sumo ESM entry.");
}
