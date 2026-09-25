import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dataDir = process.env.GROCERY_DATA_DIR ?? resolve(root, "data");

export const config = {
  root,
  dataDir,
  profileDir: resolve(dataDir, "browser-profile"),
  dbPath: process.env.GROCERY_DB_PATH ?? resolve(dataDir, "grocery.db"),
  discoveryDir: resolve(dataDir, "discovery"),
  preferencesPath: resolve(dataDir, "preferences.md"),
  dryRun: process.env.GROCERY_DRY_RUN === "1",
} as const;
