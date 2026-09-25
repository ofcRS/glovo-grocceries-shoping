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

export class GlovoApi {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = "https://api.glovoapp.com",
  ) {}

  /** GET with a budget of one token refresh per call (pre-flight for a missing/expired token, or after a 401). */
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

    let res = await this.send(path, auth);
    if (res.status === 401) {
      if (refreshed) throw new GlovoApiError(401, "needs_login", "Glovo rejected a refreshed token. Run `bun run login`.");
      const rejected = auth.accessToken;
      auth = await this.provider(() => this.tokens.refresh(rejected));
      if (!auth) throw new GlovoApiError(401, "needs_login", "Glovo session expired. Run `bun run login`.");
      res = await this.send(path, auth);
      if (res.status === 401) throw new GlovoApiError(401, "needs_login", "Glovo rejected a refreshed token. Run `bun run login`.");
    }
    if (!res.ok) throw new GlovoApiError(res.status, "http", `Glovo GET ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
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
