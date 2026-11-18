import { config } from "../src/config";
import { GlovoSession, HOME } from "../src/glovo/session";
import { GlovoApi } from "../src/glovo/api";
import type { GlovoAuth } from "../src/glovo/auth";
import { mkdirSync } from "node:fs";

mkdirSync(config.profileDir, { recursive: true });
const session = await GlovoSession.launch({ profileDir: config.profileDir, headed: true });
try {
  const page = await session.newPage();
  await page.goto(HOME, { waitUntil: "domcontentloaded" });

  console.log("A browser window is open. Log in to Glovo with Google in that window.");
  console.log("Waiting up to 5 minutes for the session cookie...");

  // getAuth() is a pure cookie read, so check expiry here: a stale cookie from an old profile must not count.
  const deadline = Date.now() + 5 * 60_000;
  let auth: GlovoAuth | null = null;
  while (Date.now() < deadline) {
    const found = await session.getAuth();
    if (found && found.expiresAt > Math.floor(Date.now() / 1000)) {
      auth = found;
      break;
    }
    await Bun.sleep(2000);
  }

  if (!auth) {
    console.error("No session detected within 5 minutes. Run `bun run login` again.");
    process.exitCode = 1; // not process.exit(): that would skip the finally and leave the browser open
  } else {
    const me = await new GlovoApi(session).me();
    console.log(`Logged in as ${me.name} (${me.deliveredOrdersCount} delivered orders). Profile saved to ${config.profileDir}`);
  }
} finally {
  await session.close();
}
