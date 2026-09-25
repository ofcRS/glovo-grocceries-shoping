import type { GlovoAuth } from "./auth";

export interface TokenProvider {
  getAuth(): Promise<GlovoAuth | null>;
  refresh(): Promise<GlovoAuth | null>;
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
    public readonly kind: "needs_login" | "http" | "network",
    message: string,
  ) {
    super(message);
    this.name = "GlovoApiError";
  }
}

export interface GlovoMe { id: number; name: string; deliveredOrdersCount: number; preferredCityCode: string }

export class GlovoApi {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = "https://api.glovoapp.com",
  ) {}

  async get<T>(path: string): Promise<T> {
    let auth = await this.tokens.getAuth();
    if (!auth) throw new GlovoApiError(401, "needs_login", "No Glovo session. Run `bun run login`.");

    let res = await this.send(path, auth);
    if (res.status === 401) {
      auth = await this.tokens.refresh();
      if (!auth) throw new GlovoApiError(401, "needs_login", "Glovo session expired. Run `bun run login`.");
      res = await this.send(path, auth);
      if (res.status === 401) throw new GlovoApiError(401, "needs_login", "Glovo rejected a refreshed token. Run `bun run login`.");
    }
    if (!res.ok) throw new GlovoApiError(res.status, "http", `Glovo GET ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
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
