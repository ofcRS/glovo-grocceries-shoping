import { config } from "../src/config";
import { GlovoSession } from "../src/glovo/session";
import { GlovoApi } from "../src/glovo/api";
import type { GlovoAuth } from "../src/glovo/auth";
import { mkdirSync } from "node:fs";

mkdirSync(config.profileDir, { recursive: true });
const session = await GlovoSession.launch({ profileDir: config.profileDir, headed: true });
const page = await session.newPage();
await page.goto("https://glovoapp.com/en/ge/tbilisi/", { waitUntil: "domcontentloaded" });

console.log("A browser window is open. Log in to Glovo with Google in that window.");
console.log("Waiting up to 5 minutes for the session cookie...");

const deadline = Date.now() + 5 * 60_000;
let auth: GlovoAuth | null = null;
while (Date.now() < deadline) {
  auth = await session.getAuth();
  if (auth) break;
  await page.waitForTimeout(2000);
}

if (!auth) {
  console.error("No session detected. Close the window and try again.");
  await session.close();
  process.exit(1);
}

const me = await new GlovoApi(session).me();
console.log(`Logged in as ${me.name} (${me.deliveredOrdersCount} delivered orders). Profile saved to ${config.profileDir}`);
await session.close();
