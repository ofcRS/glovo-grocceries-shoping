import type { GlovoAuth } from "./auth";

export interface TokenProvider {
  getAuth(): Promise<GlovoAuth | null>;
  /** Obtain a new access token. `staleToken` is the token to move past (rejected or expired), if any. */
  refresh(staleToken?: string): Promise<GlovoAuth | null>;
}

export const GLOVO_HEADERS: Record<string, string> = {
  "glovo-app-platform": "web",
  "glovo-api-version": "14",
  "glovo-location-city-code": "TBI",
  "glovo-language-code": "en",
  accept: "application/json",
};

export class GlovoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly kind: "needs_login" | "http" | "network" | "browser",
    message: string,
  ) {
    super(message);
    this.name = "GlovoApiError";
  }
}

export interface GlovoMe { id: number; name: string; deliveredOrdersCount: number; preferredCityCode: string }

const nowSec = () => Math.floor(Date.now() / 1000);

/** Retries after a 429 before giving up; the catalog endpoints throttle bursts. */
const MAX_429_RETRIES = 3;

/** Retry-After in whole seconds (capped at 60), else exponential backoff from 2 s. */
function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) return Math.min(Number(retryAfter), 60) * 1000;
  return 2000 * 2 ** attempt;
}

type SourceReviver = (key: string, value: unknown, context: { source?: string }) => unknown;

/** JSON.parse that keeps integers beyond 2^53 (Glovo product and basket ids) exact, as strings. */
function parseGlovoJson(text: string): unknown {
  const reviver: SourceReviver = (_key, value, context) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context.source !== undefined && /^-?\d+$/.test(context.source)
      ? context.source
      : value;
  return (JSON.parse as (text: string, reviver: SourceReviver) => unknown)(text, reviver);
}

export class GlovoApi {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = "https://api.glovoapp.com",
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  /**
   * GET with a budget of one token refresh per call (pre-flight for a missing/expired token, or after a 401)
   * and up to MAX_429_RETRIES waits on 429. Returns null for 204. Integers beyond 2^53 come back as strings.
   */
  async get<T>(path: string): Promise<T> {
    let refreshed = false;
    let auth = await this.provider(() => this.tokens.getAuth());

    if (!auth || auth.expiresAt <= nowSec()) {
      const stale = auth?.accessToken;
      auth = await this.provider(() => this.tokens.refresh(stale));
      refreshed = true;
      if (!auth) {
        throw new GlovoApiError(401, "needs_login", stale === undefined
          ? "No Glovo session. Run `bun run login`."
          : "Glovo session expired. Run `bun run login`.");
      }
    }

    let res = await this.sendPaced(path, auth);
    if (res.status === 401) {
      if (refreshed) throw new GlovoApiError(401, "needs_login", "Glovo rejected a refreshed token. Run `bun run login`.");
      const rejected = auth.accessToken;
      auth = await this.provider(() => this.tokens.refresh(rejected));
      if (!auth) throw new GlovoApiError(401, "needs_login", "Glovo session expired. Run `bun run login`.");
      res = await this.sendPaced(path, auth);
      if (res.status === 401) throw new GlovoApiError(401, "needs_login", "Glovo rejected a refreshed token. Run `bun run login`.");
    }
    if (res.status === 429) {
      throw new GlovoApiError(429, "http", `Glovo GET ${path}: HTTP 429, rate limited after ${MAX_429_RETRIES} retries`);
    }
    if (!res.ok) throw new GlovoApiError(res.status, "http", `Glovo GET ${path}: HTTP ${res.status}`);
    if (res.status === 204) return null as T;
    return parseGlovoJson(await res.text()) as T;
  }

  private async sendPaced(path: string, auth: GlovoAuth): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.send(path, auth);
      if (res.status !== 429 || attempt === MAX_429_RETRIES) return res;
      await this.sleep(retryDelayMs(res.headers.get("retry-after"), attempt));
    }
  }

  /** Token provider calls drive a browser; any failure there surfaces as kind "browser". */
  private async provider(call: () => Promise<GlovoAuth | null>): Promise<GlovoAuth | null> {
    try {
      return await call();
    } catch (e) {
      if (e instanceof GlovoApiError) throw e;
      throw new GlovoApiError(0, "browser", `Glovo browser session: ${(e as Error).message}`);
    }
  }

  private async send(path: string, auth: GlovoAuth): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        headers: { ...GLOVO_HEADERS, authorization: auth.accessToken },
      });
    } catch (e) {
      throw new GlovoApiError(0, "network", `Glovo GET ${path}: ${(e as Error).message}`);
    }
  }

  async me(): Promise<GlovoMe> {
    const raw = await this.get<GlovoMe>("/v3/me");
    return { id: raw.id, name: raw.name, deliveredOrdersCount: raw.deliveredOrdersCount, preferredCityCode: raw.preferredCityCode };
  }
}
