import { test, expect } from "bun:test";
import { GlovoApi, GlovoApiError, GLOVO_HEADERS } from "../src/glovo/api";
import type { GlovoAuth } from "../src/glovo/auth";

const nowSec = () => Math.floor(Date.now() / 1000);
const auth = (token: string, expiresAt = 4102444800): GlovoAuth => ({ accessToken: token, expiresAt, userId: 1 });

function provider(tokens: (GlovoAuth | null)[]) {
  let i = 0;
  const calls = { getAuth: 0, refresh: 0 };
  const refreshArgs: (string | undefined)[] = [];
  return {
    calls,
    refreshArgs,
    getAuth: async () => { calls.getAuth++; return tokens[Math.min(i, tokens.length - 1)] ?? null; },
    refresh: async (staleToken?: string) => {
      calls.refresh++;
      refreshArgs.push(staleToken);
      i++;
      return tokens[Math.min(i, tokens.length - 1)] ?? null;
    },
  };
}

function fetchSeq(responses: Array<{ status: number; body?: unknown; expectToken?: string }>): { f: typeof fetch; seen: Request[] } {
  const seen: Request[] = [];
  let n = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req);
    const r = responses[Math.min(n++, responses.length - 1)]!;
    if (r.expectToken !== undefined && req.headers.get("authorization") !== r.expectToken) {
      return new Response("bad token", { status: 401 });
    }
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, seen };
}

test("get sends token and Glovo headers", async () => {
  const p = provider([auth("tok1")]);
  const { f, seen } = fetchSeq([{ status: 200, body: { ok: true } }]);
  const api = new GlovoApi(p, f);
  expect(await api.get<unknown>("/v3/me")).toEqual({ ok: true });
  const h = seen[0]!.headers;
  expect(h.get("authorization")).toBe("tok1");
  for (const [k, v] of Object.entries(GLOVO_HEADERS)) expect(h.get(k)).toBe(v);
  expect(seen[0]!.url).toBe("https://api.glovoapp.com/v3/me");
});

test("sends the Glovo API headers with their exact values", async () => {
  const p = provider([auth("tok1")]);
  const { f, seen } = fetchSeq([{ status: 200, body: {} }]);
  await new GlovoApi(p, f).get<unknown>("/v3/me");
  const h = seen[0]!.headers;
  expect(h.get("glovo-app-platform")).toBe("web");
  expect(h.get("glovo-api-version")).toBe("14");
  expect(h.get("glovo-location-city-code")).toBe("TBI");
  expect(h.get("glovo-language-code")).toBe("en");
});

test("on 401 refreshes once and retries with the new token", async () => {
  const p = provider([auth("stale"), auth("fresh")]);
  const { f, seen } = fetchSeq([{ status: 401 }, { status: 200, body: { id: 7 }, expectToken: "fresh" }]);
  const api = new GlovoApi(p, f);
  expect(await api.get<unknown>("/v3/me")).toEqual({ id: 7 });
  expect(p.calls.refresh).toBe(1);
  expect(seen.length).toBe(2);
  expect(seen[1]!.headers.get("authorization")).toBe("fresh");
});

test("on 401 passes the rejected token to refresh", async () => {
  const p = provider([auth("stale"), auth("fresh")]);
  const { f } = fetchSeq([{ status: 401 }, { status: 200, body: {} }]);
  await new GlovoApi(p, f).get<unknown>("/v3/me");
  expect(p.refreshArgs).toStrictEqual(["stale"]);
});

test("second 401 raises needs_login", async () => {
  const p = provider([auth("a"), auth("b")]);
  const { f, seen } = fetchSeq([{ status: 401 }, { status: 401 }]);
  const api = new GlovoApi(p, f);
  const err = await api.get("/v3/me").catch((e) => e);
  expect(err).toBeInstanceOf(GlovoApiError);
  expect((err as GlovoApiError).kind).toBe("needs_login");
  expect(p.calls.refresh).toBe(1);
  expect(seen.length).toBe(2);
});

test("401 followed by a failed refresh raises needs_login without retrying", async () => {
  const p = provider([auth("stale"), null]);
  const { f, seen } = fetchSeq([{ status: 401 }, { status: 200, body: { id: 7 } }]);
  const err = await new GlovoApi(p, f).get("/v3/me").catch((e) => e);
  expect(err).toBeInstanceOf(GlovoApiError);
  expect((err as GlovoApiError).kind).toBe("needs_login");
  expect(p.calls.refresh).toBe(1);
  expect(seen.length).toBe(1);
});

test("missing auth triggers one refresh with no stale token, then sends the refreshed token", async () => {
  const p = provider([null, auth("fresh")]);
  const { f, seen } = fetchSeq([{ status: 200, body: { ok: true }, expectToken: "fresh" }]);
  expect(await new GlovoApi(p, f).get<unknown>("/v3/me")).toEqual({ ok: true });
  expect(p.refreshArgs).toStrictEqual([undefined]);
  expect(seen.length).toBe(1);
  expect(seen[0]!.headers.get("authorization")).toBe("fresh");
});

test("no auth at all raises needs_login without calling fetch", async () => {
  const p = provider([null]);
  const { f, seen } = fetchSeq([{ status: 200 }]);
  const err = await new GlovoApi(p, f).get("/v3/me").catch((e) => e);
  expect((err as GlovoApiError).kind).toBe("needs_login");
  expect(p.refreshArgs).toStrictEqual([undefined]);
  expect(seen.length).toBe(0);
});

test("an already-expired token is refreshed, passing that token, before the first send", async () => {
  const p = provider([auth("expired", nowSec() - 5), auth("fresh")]);
  const { f, seen } = fetchSeq([{ status: 200, body: { ok: true }, expectToken: "fresh" }]);
  expect(await new GlovoApi(p, f).get<unknown>("/v3/me")).toEqual({ ok: true });
  expect(p.refreshArgs).toStrictEqual(["expired"]);
  expect(seen.length).toBe(1);
  expect(seen[0]!.headers.get("authorization")).toBe("fresh");
});

test("a token with 30s left is sent as-is without a pre-flight refresh", async () => {
  const p = provider([auth("nearly", nowSec() + 30)]);
  const { f, seen } = fetchSeq([{ status: 200, body: {} }]);
  await new GlovoApi(p, f).get<unknown>("/v3/me");
  expect(p.calls.refresh).toBe(0);
  expect(seen[0]!.headers.get("authorization")).toBe("nearly");
});

test("after a pre-flight refresh, a 401 raises needs_login without a second refresh", async () => {
  const p = provider([null, auth("fresh"), auth("fresher")]);
  const { f, seen } = fetchSeq([{ status: 401 }, { status: 200, body: {} }]);
  const err = await new GlovoApi(p, f).get("/v3/me").catch((e) => e);
  expect((err as GlovoApiError).kind).toBe("needs_login");
  expect(p.calls.refresh).toBe(1);
  expect(seen.length).toBe(1);
});

test("token provider failures raise kind browser", async () => {
  const { f, seen } = fetchSeq([{ status: 401 }]);
  const getAuthThrows = { getAuth: async () => { throw new Error("Target page, context or browser has been closed"); }, refresh: async () => null };
  const err = await new GlovoApi(getAuthThrows, f).get("/v3/me").catch((e) => e);
  expect(err).toBeInstanceOf(GlovoApiError);
  expect((err as GlovoApiError).kind).toBe("browser");
  expect((err as GlovoApiError).status).toBe(0);
  expect(seen.length).toBe(0);

  const refreshThrows = { getAuth: async () => auth("a"), refresh: async () => { throw new Error("Timeout 20000ms exceeded"); } };
  const err2 = await new GlovoApi(refreshThrows, f).get("/v3/me").catch((e) => e);
  expect((err2 as GlovoApiError).kind).toBe("browser");
});

test("non-401 HTTP errors raise kind http with status", async () => {
  const p = provider([auth("a")]);
  const { f } = fetchSeq([{ status: 404 }]);
  const err = await new GlovoApi(p, f).get("/v3/nope").catch((e) => e);
  expect((err as GlovoApiError).kind).toBe("http");
  expect((err as GlovoApiError).status).toBe(404);
});

test("fetch failure raises kind network with status 0", async () => {
  const f = (async () => { throw new TypeError("Unable to connect"); }) as unknown as typeof fetch;
  const err = await new GlovoApi(provider([auth("a")]), f).get("/v3/me").catch((e) => e);
  expect((err as GlovoApiError).kind).toBe("network");
  expect((err as GlovoApiError).status).toBe(0);
});

test("me() maps the profile fields", async () => {
  const p = provider([auth("a")]);
  const { f } = fetchSeq([{ status: 200, body: { id: 1, name: "A", deliveredOrdersCount: 33, preferredCityCode: "TBI", extra: 1 } }]);
  expect(await new GlovoApi(p, f).me()).toEqual({ id: 1, name: "A", deliveredOrdersCount: 33, preferredCityCode: "TBI" });
});
