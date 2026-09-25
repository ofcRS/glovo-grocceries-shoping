import { chromium, type BrowserContext, type Page } from "playwright";
import { parseAuthCookie, selectFreshAuth, type GlovoAuth } from "./auth";
import type { TokenProvider } from "./api";

export const HOME = "https://glovoapp.com/en/ge/tbilisi/";
const COOKIE = "glovo_auth_info";
const COOKIE_URL = "https://glovoapp.com";

export class GlovoSession implements TokenProvider {
  private inflight: Promise<GlovoAuth | null> | null = null;

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

  /** Pure read of the auth cookie. No refresh, no page load; callers decide what to do with an expired token. */
  async getAuth(): Promise<GlovoAuth | null> {
    const value = await this.readCookie();
    return value === undefined ? null : parseAuthCookie(value);
  }

  /**
   * Load the home page so the web app trades its refresh credential for a new access token.
   * Single-flight: concurrent callers share one page load (and the first caller's `staleToken`).
   */
  refresh(staleToken?: string): Promise<GlovoAuth | null> {
    if (this.inflight) return this.inflight;
    const flight: Promise<GlovoAuth | null> = this.doRefresh(staleToken).finally(() => {
      if (this.inflight === flight) this.inflight = null;
    });
    this.inflight = flight;
    return flight;
  }

  private async doRefresh(staleToken: string | undefined): Promise<GlovoAuth | null> {
    const page = await this.ctx.newPage();
    try {
      try {
        await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 20_000 });
      } catch {
        /* a slow or failed navigation may still have re-minted the token: fall through to the poll */
      }
      const deadline = Date.now() + 10_000;
      for (;;) {
        const auth = selectFreshAuth(await this.readCookie(), staleToken, Math.floor(Date.now() / 1000));
        if (auth) return auth;
        if (Date.now() >= deadline) return null;
        await Bun.sleep(500);
      }
    } finally {
      await page.close().catch(() => { /* never mask the refresh result */ });
    }
  }

  private async readCookie(): Promise<string | undefined> {
    const cookies = await this.ctx.cookies(COOKIE_URL);
    return cookies.find((c) => c.name === COOKIE)?.value;
  }

  newPage(): Promise<Page> {
    return this.ctx.newPage();
  }

  async close(): Promise<void> {
    await this.ctx.close();
  }
}
