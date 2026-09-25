import { chromium, type BrowserContext, type Page } from "playwright";
import { parseAuthCookie, isExpiring, type GlovoAuth } from "./auth";
import type { TokenProvider } from "./api";

const HOME = "https://glovoapp.com/en/ge/tbilisi/";
const COOKIE = "glovo_auth_info";

export class GlovoSession implements TokenProvider {
  private constructor(private readonly ctx: BrowserContext) {}

  static async launch(opts: { profileDir: string; headed?: boolean }): Promise<GlovoSession> {
    const ctx = await chromium.launchPersistentContext(opts.profileDir, {
      headless: !opts.headed,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "Asia/Tbilisi",
      args: ["--disable-blink-features=AutomationControlled"],
    });
    return new GlovoSession(ctx);
  }

  async getAuth(): Promise<GlovoAuth | null> {
    const cookies = await this.ctx.cookies("https://glovoapp.com");
    const c = cookies.find((k) => k.name === COOKIE);
    if (!c) return null;
    const auth = parseAuthCookie(c.value);
    if (!auth) return null;
    if (isExpiring(auth, Math.floor(Date.now() / 1000))) return this.refresh();
    return auth;
  }

  /** Load the home page so the web app trades its refresh token for a new access token. */
  async refresh(): Promise<GlovoAuth | null> {
    const page = await this.ctx.newPage();
    try {
      await page.goto(HOME, { waitUntil: "networkidle", timeout: 30_000 });
      const before = Date.now();
      // Poll up to 10s for a non-expiring cookie.
      while (Date.now() - before < 10_000) {
        const cookies = await this.ctx.cookies("https://glovoapp.com");
        const c = cookies.find((k) => k.name === COOKIE);
        const auth = c ? parseAuthCookie(c.value) : null;
        if (auth && !isExpiring(auth, Math.floor(Date.now() / 1000))) return auth;
        await page.waitForTimeout(500);
      }
      return null;
    } finally {
      await page.close();
    }
  }

  newPage(): Promise<Page> {
    return this.ctx.newPage();
  }

  async close(): Promise<void> {
    await this.ctx.close();
  }
}
