# Grocery Agent, Plan 1: Foundation and Discovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `grocery-mcp` server with a working Dazoge price client, a durable Glovo browser session, the pricing and matching engines, the planner database, and a discovery recorder that captures Glovo's real endpoints so Plan 2 can build history, cart and checkout on facts.

**Architecture:** One Bun + TypeScript MCP server over stdio. Pure modules (pricing, matching, auth parsing, redaction) are tested with plain unit tests. I/O modules (Dazoge HTTP, Glovo API) take an injected `fetch` and are tested against recorded fixtures. Playwright owns a dedicated persistent browser profile that holds the Glovo login. SQLite via `bun:sqlite` holds planner state. Money is always an integer number of tetri inside the code; GEL formatting happens only at tool output.

**Tech Stack:** Bun 1.3.14, TypeScript 5 strict ESM, `@modelcontextprotocol/sdk` ^1.30, `zod` ^4, `playwright` ^1.63 (Chromium), `bun:sqlite`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-25-grocery-agent-design.md`

## Global Constraints

- Runtime is Bun 1.3.14. Scripts run with `bun run`, tests with `bun test`. Never `node`.
- TypeScript `strict: true`, ESM only, no default exports except where a framework requires one.
- Secrets and personal data never enter git: `data/browser-profile/`, `data/*.db`, `data/discovery/` are ignored. Fixtures committed under `tests/fixtures/` must pass through `redact()` (Task 4) first.
- No test hits live Glovo. Dazoge tests use fixtures; the only live Dazoge calls are in manual scripts.
- Prices are integer tetri (`type Tetri = number`, 1 GEL = 100 tetri) everywhere except formatted tool output.
- Glovo API headers, verbatim from the spec: `glovo-app-platform: web`, `glovo-api-version: 14`, `glovo-location-city-code: TBI`, `glovo-language-code: en`.
- Dazoge endpoints, verbatim: `GET https://www.dazoge.info/api/product/{id}.json` and `GET https://www.dazoge.info/api/search.json?q={query}&page={n}`. Response prices are tetri. Store names are Georgian.
- Split rule from the spec: protected categories default to raw meat, fish, fruit; anchor store is Agrohub; split only when savings after both delivery fees exceed a margin defaulting to 1000 tetri (10 GEL); never more than two carts; both carts must meet their store minimum.
- Write actions on Glovo are out of scope for this plan. Nothing here adds to a cart or checks out.

## Effort per task (for the orchestrator dispatching Opus subagents)

| Task | Effort | Why |
|------|--------|-----|
| 1 Scaffold | low | Boilerplate with a known SDK |
| 2 Dazoge client | medium | Fixture-driven parsing, store map |
| 3 Glovo session and API | high | Playwright profile, token refresh, failure paths |
| 4 Discovery recorder | medium | Redaction correctness matters, logic is small |
| 5 Pricing engine | high | Core money logic, many branches |
| 6 Matching | high | Fuzzy logic across scripts, threshold behaviour |
| 7 Database and planner repos | medium | Schema plus arithmetic |
| 8 MCP tool wiring | medium | Glue, integration test through the SDK client |
| 9 Discovery run | orchestrator + user | Human at keyboard, orchestrator analyses output |

## Review Focus

1. A Dazoge product whose `prices` list lacks the anchor store or the chosen alternative store. Expected: the item is reported as unpriced for that store and excluded from that store's total, never priced at zero. Test pinned in Task 5.
2. The `glovo_auth_info` cookie is absent, not URL-encoded JSON, or holds an expired JWT. Expected: `getAuth()` returns null or an expiring auth, `GlovoApi.get` throws `GlovoApiError` with kind `needs_login`, no uncaught exception. Tests pinned in Task 3.
3. A Dazoge search with Georgian letters or an empty query. Expected: the query is percent-encoded once, an empty result page returns `items: []` with `hasMore: false`, no throw. Tests pinned in Task 2.
4. The alternative cart would fall below that store's minimum order. Expected: no split, the reason says which minimum failed. Test pinned in Task 5.
5. Pantry adjustments in a different unit than the stored row (grams versus kilograms). Expected: known mass and volume units are converted, unknown pairs throw a `UnitMismatchError` rather than silently adding numbers. Test pinned in Task 7.

---

## File structure

```
package.json, tsconfig.json, .mcp.json, README.md
src/
  config.ts              paths and env flags (DATA_DIR, PROFILE_DIR, DB_PATH, DRY_RUN)
  server.ts              stdio entry point
  tools.ts               createServer(): registers every MCP tool
  money.ts               Tetri type, formatGel(), parseGel()
  dazoge/types.ts        DazogeProduct, DazogeSearchPage, ...
  dazoge/stores.ts       Georgian store name -> StoreSlug
  dazoge/client.ts       DazogeClient (getProduct, search) with injected fetch
  glovo/auth.ts          parseAuthCookie(), isExpiring()
  glovo/session.ts       GlovoSession over a persistent Chromium profile
  glovo/api.ts           GlovoApi (get, me), GlovoApiError, GLOVO_HEADERS
  glovo/recorder.ts      shouldRecord(), redact(), fixtureName()
  pricing/types.ts       BasketItem, ItemQuote, StoreInfo, SplitDecision, ...
  pricing/split.ts       decideSplit()
  matching/normalize.ts  normalizeName(), unit and brand alias tables
  matching/score.ts      scoreCandidate(), thresholds
  matching/resolver.ts   resolve() using DazogeClient + MatchCache
  db/schema.ts           SQL migrations
  db/index.ts            openDb()
  planner/units.ts       convertQty(), UnitMismatchError
  planner/pantry.ts      PantryRepo
  planner/meals.ts       MealsRepo
  planner/deliveries.ts  DeliveriesRepo
  planner/notes.ts       NotesRepo
  planner/matchCache.ts  SqliteMatchCache implements MatchCache
scripts/
  login.ts               one-time headed Google login into the profile
  discover.ts            headed recording session + endpoint report
data/
  preferences.md         committed template, user edits in place
  browser-profile/       ignored
  discovery/             ignored, raw recordings
tests/
  helpers/mcp.ts         connectedClient()
  fixtures/dazoge/*.json already present
  <module>.test.ts       one per src module
docs/
  glovo-discovery.md     the click-through checklist for Task 9
```

---

### Task 1: Project scaffold and MCP skeleton

**Effort:** low

**Files:**
- Create: `package.json`, `tsconfig.json`, `.mcp.json`, `src/config.ts`, `src/money.ts`, `src/server.ts`, `src/tools.ts`, `tests/helpers/mcp.ts`
- Test: `tests/tools.test.ts`, `tests/money.test.ts`

**Interfaces:**
- Produces: `createServer(): McpServer` in `src/tools.ts`; `connectedClient(): Promise<Client>` in `tests/helpers/mcp.ts`; `type Tetri = number`, `formatGel(t: Tetri): string`, `parseGel(s: string): Tetri` in `src/money.ts`; `config` object in `src/config.ts` with `dataDir`, `profileDir`, `dbPath`, `dryRun: boolean`.

- [ ] **Step 1: Write package.json and tsconfig.json**

```json
{
  "name": "grocery-mcp",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "bun run src/server.ts",
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit",
    "login": "bun run scripts/login.ts",
    "discover": "bun run scripts/discover.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.1",
    "playwright": "^1.63.0",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["bun"],
    "noEmit": true
  },
  "include": ["src", "scripts", "tests"]
}
```

Run: `bun install && bunx playwright install chromium`
Expected: lockfile created, Chromium downloaded.

- [ ] **Step 2: Write the failing money test**

`tests/money.test.ts`:
```ts
import { test, expect } from "bun:test";
import { formatGel, parseGel } from "../src/money";

test("formatGel renders tetri as GEL with two decimals", () => {
  expect(formatGel(399)).toBe("3.99 GEL");
  expect(formatGel(1000)).toBe("10.00 GEL");
  expect(formatGel(5)).toBe("0.05 GEL");
});

test("parseGel reads decimal strings into integer tetri without float drift", () => {
  expect(parseGel("4.99")).toBe(499);
  expect(parseGel("4.99₾")).toBe(499);
  expect(parseGel("10")).toBe(1000);
  expect(parseGel(" 0.1 ")).toBe(10);
});

test("parseGel rejects garbage", () => {
  expect(() => parseGel("abc")).toThrow();
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test tests/money.test.ts`
Expected: FAIL, cannot find module `../src/money`.

- [ ] **Step 4: Implement money.ts and config.ts**

`src/money.ts`:
```ts
/** Integer number of tetri. 1 GEL = 100 tetri. */
export type Tetri = number;

export function formatGel(t: Tetri): string {
  const sign = t < 0 ? "-" : "";
  const abs = Math.abs(Math.round(t));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} GEL`;
}

export function parseGel(s: string): Tetri {
  const m = s.trim().match(/^(\d+)(?:[.,](\d{1,2}))?\s*(?:₾|GEL)?$/i);
  if (!m) throw new Error(`Not a GEL amount: ${JSON.stringify(s)}`);
  const whole = Number(m[1]);
  const frac = (m[2] ?? "").padEnd(2, "0");
  return whole * 100 + Number(frac);
}
```

`src/config.ts`:
```ts
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
```

- [ ] **Step 5: Run money tests, verify pass**

Run: `bun test tests/money.test.ts`
Expected: 3 pass.

- [ ] **Step 6: Write the failing MCP skeleton test**

`tests/helpers/mcp.ts`:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/tools";

export async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

export function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  if (!first || first.type !== "text" || first.text === undefined) throw new Error("no text content");
  return first.text;
}
```

`tests/tools.test.ts`:
```ts
import { test, expect } from "bun:test";
import { connectedClient, textOf } from "./helpers/mcp";

test("server lists ping and answers pong", async () => {
  const client = await connectedClient();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("ping");
  const res = await client.callTool({ name: "ping", arguments: {} });
  expect(textOf(res)).toBe("pong");
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun test tests/tools.test.ts`
Expected: FAIL, cannot find module `../../src/tools`.

- [ ] **Step 8: Implement tools.ts and server.ts**

`src/tools.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "grocery-mcp", version: "0.1.0" });

  server.registerTool(
    "ping",
    { description: "Health check for the grocery MCP server.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  return server;
}
```

`src/server.ts`:
```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./tools";

const server = createServer();
await server.connect(new StdioServerTransport());
```

`.mcp.json` (project root, picked up by Claude Code):
```json
{
  "mcpServers": {
    "grocery": { "command": "bun", "args": ["run", "src/server.ts"] }
  }
}
```

- [ ] **Step 9: Run all tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: all pass, no type errors.

- [ ] **Step 10: Commit**

```bash
git add package.json bun.lock tsconfig.json .mcp.json src tests
git commit -m "feat: scaffold grocery-mcp with ping tool and money helpers"
```

---

### Task 2: Dazoge client

**Effort:** medium

**Files:**
- Create: `src/dazoge/types.ts`, `src/dazoge/stores.ts`, `src/dazoge/client.ts`
- Test: `tests/dazoge.test.ts`
- Uses fixtures: `tests/fixtures/dazoge/product-4860051001298.json`, `search-milk.json`, `search-rdze.json`

**Interfaces:**
- Consumes: `Tetri` from `src/money.ts`.
- Produces:
  ```ts
  type StoreSlug = "agrohub"|"goodwill"|"carrefour"|"spar"|"europroduct"|"gvirila"|"magniti"|"zghapari"|"2nabiji"|"psp"|"organika"|"alubali"|"suftasaxli"|"tursa";
  function storeSlug(georgianName: string): StoreSlug | null;
  interface DazogeStorePrice { store: string; storeSlug: StoreSlug | null; price: Tetri; oldPrice: Tetri | null }
  interface DazogeProduct { id: string; name: string; volume: string; imageUrl: string; prices: DazogeStorePrice[] }
  interface DazogeSearchItem { id: string; name: string; volume: string; price: Tetri; oldPrice: Tetri | null; store: string; storeSlug: StoreSlug | null }
  interface DazogeSearchPage { query: string; page: number; items: DazogeSearchItem[]; hasMore: boolean }
  class DazogeClient {
    constructor(fetchImpl?: typeof fetch, baseUrl?: string);
    getProduct(id: string): Promise<DazogeProduct | null>;   // null on 404
    search(query: string, page?: number): Promise<DazogeSearchPage>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`tests/dazoge.test.ts`:
```ts
import { test, expect } from "bun:test";
import { DazogeClient } from "../src/dazoge/client";
import { storeSlug } from "../src/dazoge/stores";

const fixture = (name: string) => Bun.file(`tests/fixtures/dazoge/${name}`).text();

function fakeFetch(routes: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const hit = routes[url];
    if (!hit) return new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(hit.body, { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("storeSlug maps known Georgian names and returns null for unknown", () => {
  expect(storeSlug("აგროჰაბი")).toBe("agrohub");
  expect(storeSlug("გუდვილი")).toBe("goodwill");
  expect(storeSlug("კარფური")).toBe("carrefour");
  expect(storeSlug("სპარი")).toBe("spar");
  expect(storeSlug(" ორი ნაბიჯი ")).toBe("2nabiji");
  expect(storeSlug("unknown shop")).toBeNull();
});

test("getProduct parses prices in tetri and tags store slugs", async () => {
  const body = await fixture("product-4860051001298.json");
  const client = new DazogeClient(
    fakeFetch({ "https://www.dazoge.info/api/product/4860051001298.json": { status: 200, body } }),
  );
  const p = await client.getProduct("4860051001298");
  expect(p).not.toBeNull();
  expect(p!.id).toBe("4860051001298");
  expect(p!.name).toBe("სანტე-რძე 2.5% 1ლ");
  const goodwill = p!.prices.find((x) => x.storeSlug === "goodwill");
  expect(goodwill).toEqual({ store: "გუდვილი", storeSlug: "goodwill", price: 399, oldPrice: 695 });
  const carrefour = p!.prices.find((x) => x.storeSlug === "carrefour");
  expect(carrefour!.oldPrice).toBeNull(); // old_price 0 means no old price
});

test("getProduct returns null on 404", async () => {
  const client = new DazogeClient(fakeFetch({}));
  expect(await client.getProduct("0000000000000")).toBeNull();
});

test("search encodes Georgian queries once and extracts ids from href", async () => {
  const body = await fixture("search-rdze.json");
  const seen: string[] = [];
  const f: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new DazogeClient(f);
  const page = await client.search("რძე");
  expect(seen[0]).toBe("https://www.dazoge.info/api/search.json?q=%E1%83%A0%E1%83%AB%E1%83%94&page=1");
  expect(page.query).toBe("რძე");
  expect(page.page).toBe(1);
  expect(page.hasMore).toBe(true);
  expect(page.items[0]).toEqual({
    id: "4860051003018",
    name: "სანტე-რძე 3.2% 1ლ",
    volume: "1 ლ",
    price: 499,
    oldPrice: 595,
    store: "სპარი",
    storeSlug: "spar",
  });
});

test("search with empty results yields empty items and hasMore false", async () => {
  const client = new DazogeClient(
    fakeFetch({
      "https://www.dazoge.info/api/search.json?q=zzzz&page=1": {
        status: 200,
        body: JSON.stringify({ q: "zzzz", page: 1, items: [], hasMore: false }),
      },
    }),
  );
  const page = await client.search("zzzz");
  expect(page.items).toEqual([]);
  expect(page.hasMore).toBe(false);
});

test("search passes page number through", async () => {
  const seen: string[] = [];
  const f: typeof fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ q: "milk", page: 2, items: [], hasMore: false }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await new DazogeClient(f).search("milk", 2);
  expect(seen[0]).toContain("&page=2");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/dazoge.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement types.ts, stores.ts, client.ts**

`src/dazoge/types.ts`:
```ts
import type { Tetri } from "../money";
import type { StoreSlug } from "./stores";

export interface DazogeStorePrice { store: string; storeSlug: StoreSlug | null; price: Tetri; oldPrice: Tetri | null }
export interface DazogeProduct { id: string; name: string; volume: string; imageUrl: string; prices: DazogeStorePrice[] }
export interface DazogeSearchItem {
  id: string; name: string; volume: string; price: Tetri; oldPrice: Tetri | null; store: string; storeSlug: StoreSlug | null;
}
export interface DazogeSearchPage { query: string; page: number; items: DazogeSearchItem[]; hasMore: boolean }
```

`src/dazoge/stores.ts`:
```ts
export type StoreSlug =
  | "agrohub" | "goodwill" | "carrefour" | "spar" | "europroduct" | "gvirila" | "magniti"
  | "zghapari" | "2nabiji" | "psp" | "organika" | "alubali" | "suftasaxli" | "tursa";

const GEORGIAN_TO_SLUG: Record<string, StoreSlug> = {
  "აგროჰაბი": "agrohub",
  "გუდვილი": "goodwill",
  "კარფური": "carrefour",
  "სპარი": "spar",
  "ევროპროდუქტი": "europroduct",
  "გვირილა": "gvirila",
  "მაგნიტი": "magniti",
  "ზღაპარი": "zghapari",
  "ორი ნაბიჯი": "2nabiji",
  "პსპ": "psp",
  "ორგანიკა": "organika",
  "ალუბალი": "alubali",
  "სუფთა სახლი": "suftasaxli",
  "თურსა": "tursa",
};

export function storeSlug(georgianName: string): StoreSlug | null {
  return GEORGIAN_TO_SLUG[georgianName.trim()] ?? null;
}
```

`src/dazoge/client.ts`:
```ts
import { storeSlug } from "./stores";
import type { DazogeProduct, DazogeSearchItem, DazogeSearchPage } from "./types";

interface RawPrice { store_name: string; price: number; old_price: number | null }
interface RawProduct { name: string; image_url: string; volume: string; href: string; prices: RawPrice[] }
interface RawSearchItem {
  name: string; image_url: string; volume: string; price: number; old_price: number | null;
  store: { name: string; logo_url: string }; href: string;
}
interface RawSearch { q: string; page: number; items: RawSearchItem[]; hasMore: boolean }

/** href looks like "/product/4860051001298/some-slug"; the second segment is the id. */
export function idFromHref(href: string): string {
  const m = href.match(/^\/product\/([^/]+)/);
  if (!m || !m[1]) throw new Error(`Unexpected Dazoge href: ${href}`);
  return m[1];
}

const oldPrice = (v: number | null | undefined): number | null => (v && v > 0 ? v : null);

export class DazogeClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://www.dazoge.info",
  ) {}

  async getProduct(id: string): Promise<DazogeProduct | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/product/${encodeURIComponent(id)}.json`, {
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Dazoge product ${id}: HTTP ${res.status}`);
    const raw = (await res.json()) as RawProduct;
    return {
      id: idFromHref(raw.href),
      name: raw.name,
      volume: raw.volume ?? "",
      imageUrl: raw.image_url,
      prices: raw.prices.map((p) => ({
        store: p.store_name,
        storeSlug: storeSlug(p.store_name),
        price: p.price,
        oldPrice: oldPrice(p.old_price),
      })),
    };
  }

  async search(query: string, page = 1): Promise<DazogeSearchPage> {
    const url = `${this.baseUrl}/api/search.json?q=${encodeURIComponent(query)}&page=${page}`;
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Dazoge search ${JSON.stringify(query)}: HTTP ${res.status}`);
    const raw = (await res.json()) as RawSearch;
    const items: DazogeSearchItem[] = (raw.items ?? []).map((it) => ({
      id: idFromHref(it.href),
      name: it.name,
      volume: it.volume ?? "",
      price: it.price,
      oldPrice: oldPrice(it.old_price),
      store: it.store.name,
      storeSlug: storeSlug(it.store.name),
    }));
    return { query, page: raw.page ?? page, items, hasMore: Boolean(raw.hasMore) };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test tests/dazoge.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/dazoge tests/dazoge.test.ts tests/fixtures/dazoge
git commit -m "feat: Dazoge client with product prices, search and store slugs"
```

---

### Task 3: Glovo session and API client

**Effort:** high

**Files:**
- Create: `src/glovo/auth.ts`, `src/glovo/session.ts`, `src/glovo/api.ts`, `scripts/login.ts`
- Test: `tests/glovo-auth.test.ts`, `tests/glovo-api.test.ts`

**Interfaces:**
- Consumes: `config` from `src/config.ts`.
- Produces:
  ```ts
  interface GlovoAuth { accessToken: string; expiresAt: number; userId: number | null }  // expiresAt epoch seconds
  function parseAuthCookie(cookieValue: string): GlovoAuth | null;
  function isExpiring(auth: GlovoAuth, nowSec: number, skewSec?: number): boolean;
  interface TokenProvider { getAuth(): Promise<GlovoAuth | null>; refresh(): Promise<GlovoAuth | null> }
  class GlovoApiError extends Error { status: number; kind: "needs_login" | "http" | "network" }
  const GLOVO_HEADERS: Record<string, string>;
  interface GlovoMe { id: number; name: string; deliveredOrdersCount: number; preferredCityCode: string }
  class GlovoApi { constructor(tokens: TokenProvider, fetchImpl?: typeof fetch, base?: string); get<T>(path: string): Promise<T>; me(): Promise<GlovoMe> }
  class GlovoSession implements TokenProvider {
    static launch(opts: { profileDir: string; headed?: boolean }): Promise<GlovoSession>;
    getAuth(): Promise<GlovoAuth | null>; refresh(): Promise<GlovoAuth | null>;
    newPage(): Promise<import("playwright").Page>; close(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing auth tests**

`tests/glovo-auth.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseAuthCookie, isExpiring } from "../src/glovo/auth";

function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS512", kid: "old" })}.${b64(payload)}.signature`;
}

test("parses URL-encoded JSON cookie and reads exp and userId from the JWT", () => {
  const token = jwtWith({ iat: 1700000000, exp: 1700001200, payload: JSON.stringify({ userId: 123456 }) });
  const cookie = encodeURIComponent(JSON.stringify({ accessToken: token }));
  const auth = parseAuthCookie(cookie);
  expect(auth).toEqual({ accessToken: token, expiresAt: 1700001200, userId: 123456 });
});

test("parses a plain (not encoded) JSON cookie too", () => {
  const token = jwtWith({ exp: 100 });
  const auth = parseAuthCookie(JSON.stringify({ accessToken: token }));
  expect(auth?.expiresAt).toBe(100);
  expect(auth?.userId).toBeNull();
});

test("returns null for empty, garbage, or missing accessToken", () => {
  expect(parseAuthCookie("")).toBeNull();
  expect(parseAuthCookie("not json")).toBeNull();
  expect(parseAuthCookie(JSON.stringify({ refreshToken: "x" }))).toBeNull();
  expect(parseAuthCookie(JSON.stringify({ accessToken: "not.a.jwt" }))).toBeNull();
});

test("isExpiring honours skew", () => {
  const auth = { accessToken: "t", expiresAt: 1000, userId: null };
  expect(isExpiring(auth, 900)).toBe(false);     // 100s left, default skew 60
  expect(isExpiring(auth, 950)).toBe(true);      // 50s left
  expect(isExpiring(auth, 1001)).toBe(true);
  expect(isExpiring(auth, 900, 200)).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/glovo-auth.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement auth.ts**

`src/glovo/auth.ts`:
```ts
export interface GlovoAuth {
  accessToken: string;
  /** epoch seconds */
  expiresAt: number;
  userId: number | null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The glovo_auth_info cookie holds JSON, usually URL-encoded: {"accessToken":"<jwt>"} */
export function parseAuthCookie(cookieValue: string): GlovoAuth | null {
  if (!cookieValue) return null;
  let text = cookieValue;
  try { text = decodeURIComponent(cookieValue); } catch { /* keep raw */ }
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const accessToken = (obj as { accessToken?: unknown }).accessToken;
  if (typeof accessToken !== "string") return null;
  const claims = decodeJwtPayload(accessToken);
  if (!claims || typeof claims.exp !== "number") return null;

  let userId: number | null = null;
  if (typeof claims.payload === "string") {
    try {
      const inner = JSON.parse(claims.payload) as { userId?: unknown };
      if (typeof inner.userId === "number") userId = inner.userId;
    } catch { /* ignore */ }
  }
  return { accessToken, expiresAt: claims.exp, userId };
}

export function isExpiring(auth: GlovoAuth, nowSec: number, skewSec = 60): boolean {
  return auth.expiresAt - nowSec <= skewSec;
}
```

- [ ] **Step 4: Run auth tests, verify pass**

Run: `bun test tests/glovo-auth.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Write the failing API tests**

`tests/glovo-api.test.ts`:
```ts
import { test, expect } from "bun:test";
import { GlovoApi, GlovoApiError, GLOVO_HEADERS } from "../src/glovo/api";
import type { GlovoAuth } from "../src/glovo/auth";

const auth = (token: string): GlovoAuth => ({ accessToken: token, expiresAt: 4102444800, userId: 1 });

function provider(tokens: (GlovoAuth | null)[]) {
  let i = 0;
  const calls = { getAuth: 0, refresh: 0 };
  return {
    calls,
    getAuth: async () => { calls.getAuth++; return tokens[Math.min(i, tokens.length - 1)] ?? null; },
    refresh: async () => { calls.refresh++; i++; return tokens[Math.min(i, tokens.length - 1)] ?? null; },
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
  expect(await api.get("/v3/me")).toEqual({ ok: true });
  const h = seen[0]!.headers;
  expect(h.get("authorization")).toBe("tok1");
  for (const [k, v] of Object.entries(GLOVO_HEADERS)) expect(h.get(k)).toBe(v);
  expect(seen[0]!.url).toBe("https://api.glovoapp.com/v3/me");
});

test("on 401 refreshes once and retries with the new token", async () => {
  const p = provider([auth("stale"), auth("fresh")]);
  const { f, seen } = fetchSeq([{ status: 401 }, { status: 200, body: { id: 7 }, expectToken: "fresh" }]);
  const api = new GlovoApi(p, f);
  expect(await api.get("/v3/me")).toEqual({ id: 7 });
  expect(p.calls.refresh).toBe(1);
  expect(seen.length).toBe(2);
  expect(seen[1]!.headers.get("authorization")).toBe("fresh");
});

test("second 401 raises needs_login", async () => {
  const p = provider([auth("a"), auth("b")]);
  const { f } = fetchSeq([{ status: 401 }, { status: 401 }]);
  const api = new GlovoApi(p, f);
  const err = await api.get("/v3/me").catch((e) => e);
  expect(err).toBeInstanceOf(GlovoApiError);
  expect((err as GlovoApiError).kind).toBe("needs_login");
});

test("no auth at all raises needs_login without calling fetch", async () => {
  const p = provider([null]);
  const { f, seen } = fetchSeq([{ status: 200 }]);
  const err = await new GlovoApi(p, f).get("/v3/me").catch((e) => e);
  expect((err as GlovoApiError).kind).toBe("needs_login");
  expect(seen.length).toBe(0);
});

test("non-401 HTTP errors raise kind http with status", async () => {
  const p = provider([auth("a")]);
  const { f } = fetchSeq([{ status: 404 }]);
  const err = await new GlovoApi(p, f).get("/v3/nope").catch((e) => e);
  expect((err as GlovoApiError).kind).toBe("http");
  expect((err as GlovoApiError).status).toBe(404);
});

test("me() maps the profile fields", async () => {
  const p = provider([auth("a")]);
  const { f } = fetchSeq([{ status: 200, body: { id: 1, name: "A", deliveredOrdersCount: 33, preferredCityCode: "TBI", extra: 1 } }]);
  expect(await new GlovoApi(p, f).me()).toEqual({ id: 1, name: "A", deliveredOrdersCount: 33, preferredCityCode: "TBI" });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `bun test tests/glovo-api.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement api.ts**

`src/glovo/api.ts`:
```ts
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
```

- [ ] **Step 8: Run API tests, verify pass**

Run: `bun test tests/glovo-api.test.ts`
Expected: 6 pass.

- [ ] **Step 9: Implement session.ts (no unit test; exercised by scripts/login.ts and Task 9)**

`src/glovo/session.ts`:
```ts
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
```

- [ ] **Step 10: Write scripts/login.ts**

```ts
import { config } from "../src/config";
import { GlovoSession } from "../src/glovo/session";
import { GlovoApi } from "../src/glovo/api";
import { mkdirSync } from "node:fs";

mkdirSync(config.profileDir, { recursive: true });
const session = await GlovoSession.launch({ profileDir: config.profileDir, headed: true });
const page = await session.newPage();
await page.goto("https://glovoapp.com/en/ge/tbilisi/", { waitUntil: "domcontentloaded" });

console.log("A browser window is open. Log in to Glovo with Google in that window.");
console.log("Waiting up to 5 minutes for the session cookie...");

const deadline = Date.now() + 5 * 60_000;
let auth = null;
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
```

- [ ] **Step 11: Typecheck and run all tests**

Run: `bun run typecheck && bun test`
Expected: pass. Do not run `bun run login` in this task; the user does that in Task 9.

- [ ] **Step 12: Commit**

```bash
git add src/glovo scripts/login.ts tests/glovo-auth.test.ts tests/glovo-api.test.ts
git commit -m "feat: Glovo persistent browser session, auth cookie parsing, API client with refresh"
```

---

### Task 4: Discovery recorder

**Effort:** medium

**Files:**
- Create: `src/glovo/recorder.ts`, `scripts/discover.ts`, `docs/glovo-discovery.md`
- Test: `tests/recorder.test.ts`

**Interfaces:**
- Consumes: `GlovoSession` from Task 3, `config` from Task 1.
- Produces:
  ```ts
  function shouldRecord(url: string): boolean;
  function redact<T>(value: T): T;                       // deep copy with sensitive fields replaced
  function fixtureName(seq: number, method: string, url: string): string;
  interface Recording { seq: number; method: string; url: string; status: number; requestBody: unknown; responseBody: unknown; contentType: string }
  ```

- [ ] **Step 1: Write the failing tests**

`tests/recorder.test.ts`:
```ts
import { test, expect } from "bun:test";
import { shouldRecord, redact, fixtureName } from "../src/glovo/recorder";

test("shouldRecord keeps api.glovoapp.com and drops analytics, images and other hosts", () => {
  expect(shouldRecord("https://api.glovoapp.com/v3/me")).toBe(true);
  expect(shouldRecord("https://api.glovoapp.com/v3/stores/123/content?x=1")).toBe(true);
  expect(shouldRecord("https://glovoapp.com/en/ge/tbilisi/")).toBe(false);
  expect(shouldRecord("https://res.cloudinary.com/glovoapp/image/x.png")).toBe(false);
  expect(shouldRecord("https://api.glovoapp.com/v3/events/track")).toBe(false);
  expect(shouldRecord("https://rum.browser-intake-datadoghq.com/api/v2/rum")).toBe(false);
});

test("redact removes tokens, contact and address details but keeps product data", () => {
  const input = {
    authorization: "eyJ.secret",
    email: "a@b.com",
    phoneNumber: { number: "+995500000000" },
    name: "Milk 1L",
    address: { text: "Some Street 9", details: "door 1234", latitude: 41.7, longitude: 44.7, cityCode: "TBI" },
    products: [{ id: 1, name: "Eggs", price: 5.5, description: "Call +995 599 12 34 56 for info" }],
  };
  const out = redact(input);
  expect(out.authorization).toBe("[REDACTED]");
  expect(out.email).toBe("[REDACTED]");
  expect(out.phoneNumber).toBe("[REDACTED]");
  expect(out.name).toBe("Milk 1L");
  expect(out.address.text).toBe("[REDACTED]");
  expect(out.address.details).toBe("[REDACTED]");
  expect(out.address.latitude).toBe("[REDACTED]");
  expect(out.address.cityCode).toBe("TBI");
  expect(out.products[0]!.name).toBe("Eggs");
  expect(out.products[0]!.price).toBe(5.5);
  expect(out.products[0]!.description).toBe("Call [PHONE] for info");
  expect(input.authorization).toBe("eyJ.secret"); // input untouched
});

test("redact handles primitives, null and arrays at the root", () => {
  expect(redact(null)).toBeNull();
  expect(redact(5)).toBe(5);
  expect(redact([{ email: "x" }])).toEqual([{ email: "[REDACTED]" }]);
});

test("fixtureName is filesystem safe and ordered", () => {
  expect(fixtureName(3, "GET", "https://api.glovoapp.com/v3/customers/orders?limit=10&offset=0"))
    .toBe("003-GET-v3-customers-orders.json");
  expect(fixtureName(12, "POST", "https://api.glovoapp.com/v3/stores/45/cart"))
    .toBe("012-POST-v3-stores-45-cart.json");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/recorder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement recorder.ts**

`src/glovo/recorder.ts`:
```ts
export interface Recording {
  seq: number; method: string; url: string; status: number;
  requestBody: unknown; responseBody: unknown; contentType: string;
}

const SKIP_PATH = /\/(events|track|analytics|metrics|logs?)(\/|$|\?)/i;

export function shouldRecord(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.hostname !== "api.glovoapp.com") return false;
  if (SKIP_PATH.test(u.pathname)) return false;
  return true;
}

const REDACT_KEYS = new Set([
  "authorization", "cookie", "set-cookie", "accesstoken", "refreshtoken", "token",
  "email", "phone", "phonenumber", "mobile",
  "text", "details", "latitude", "longitude", "lat", "lng", "placeid", "formattedaddress", "addressline", "street",
  "firstname", "lastname", "fullname", "customername", "courier",
]);
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

export function redact<T>(value: T): T {
  return walk(value, null) as T;
}

function walk(v: unknown, key: string | null): unknown {
  if (key && REDACT_KEYS.has(key.toLowerCase())) return "[REDACTED]";
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return v.replace(PHONE_RE, "[PHONE]");
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => walk(x, null));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, k);
  return out;
}

export function fixtureName(seq: number, method: string, url: string): string {
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
  return `${String(seq).padStart(3, "0")}-${method.toUpperCase()}-${path}.json`;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test tests/recorder.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Write scripts/discover.ts**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../src/config";
import { GlovoSession } from "../src/glovo/session";
import { shouldRecord, redact, fixtureName, type Recording } from "../src/glovo/recorder";

const outDir = resolve(config.discoveryDir, new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });

const session = await GlovoSession.launch({ profileDir: config.profileDir, headed: true });
const page = await session.newPage();
const recordings: Recording[] = [];
let seq = 0;

page.on("response", async (res) => {
  const req = res.request();
  if (!shouldRecord(req.url())) return;
  const ct = res.headers()["content-type"] ?? "";
  let body: unknown = null;
  if (ct.includes("json")) { try { body = await res.json(); } catch { body = null; } }
  let reqBody: unknown = null;
  const post = req.postData();
  if (post) { try { reqBody = JSON.parse(post); } catch { reqBody = post; } }
  const rec: Recording = {
    seq: ++seq, method: req.method(), url: req.url(), status: res.status(),
    requestBody: redact(reqBody), responseBody: redact(body), contentType: ct,
  };
  recordings.push(rec);
  writeFileSync(resolve(outDir, fixtureName(rec.seq, rec.method, rec.url)), JSON.stringify(rec, null, 2));
  console.log(`[${String(rec.seq).padStart(3, "0")}] ${rec.method} ${rec.status} ${new URL(rec.url).pathname}`);
});

await page.goto("https://glovoapp.com/en/ge/tbilisi/", { waitUntil: "domcontentloaded" });
console.log(`\nRecording to ${outDir}\nFollow docs/glovo-discovery.md in the browser window, then press Enter here to finish.\n`);
for await (const _ of console) break;

const summary = new Map<string, { count: number; statuses: Set<number>; keys: Set<string> }>();
for (const r of recordings) {
  const path = new URL(r.url).pathname.replace(/\d+/g, "{id}");
  const k = `${r.method} ${path}`;
  const s = summary.get(k) ?? { count: 0, statuses: new Set(), keys: new Set() };
  s.count++; s.statuses.add(r.status);
  collectKeys(r.responseBody, s.keys, 0);
  summary.set(k, s);
}
const lines = [...summary.entries()].map(([k, s]) => {
  const flags = [...s.keys].filter((x) => /barcode|ean|gtin|sku/i.test(x));
  return `${k}  x${s.count}  status=${[...s.statuses].join(",")}${flags.length ? `  ID-KEYS: ${flags.join(",")}` : ""}`;
});
writeFileSync(resolve(outDir, "SUMMARY.txt"), lines.join("\n"));
console.log("\n" + lines.join("\n"));
console.log(`\nSummary written to ${resolve(outDir, "SUMMARY.txt")}`);
await session.close();

function collectKeys(v: unknown, into: Set<string>, depth: number): void {
  if (depth > 6 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 3)) collectKeys(x, into, depth + 1); return; }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) { into.add(k); collectKeys(val, into, depth + 1); }
}
```

- [ ] **Step 6: Write docs/glovo-discovery.md**

```markdown
# Glovo discovery session

Run `bun run discover`. A browser window opens on your logged-in profile and the
terminal logs every Glovo API call. Do these in the window, in order, slowly:

1. Open your profile menu and go to **Orders**. Scroll to load older orders.
2. Open one **past grocery order** so its line items load.
3. Go back home, open the **Groceries** category, and note which stores are listed.
4. Open **Agrohub**. Browse two categories (for example Meat and Fruit).
5. Use the in-store **search** for "milk" and for "რძე".
6. Open one **product detail**.
7. **Add** that product to the cart, then change its quantity to 2.
8. Open the **cart** and press **Checkout**. Stop on the checkout page. Do not pay.
9. Remove the item from the cart so nothing is left behind.
10. Return to the terminal and press Enter.

The recorder writes redacted JSON per request into `data/discovery/<timestamp>/`
and a `SUMMARY.txt` listing each endpoint. Lines flagged `ID-KEYS` contain
barcode-like fields; that answers whether matching can be exact.
```

- [ ] **Step 7: Typecheck, run all tests**

Run: `bun run typecheck && bun test`
Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/glovo/recorder.ts scripts/discover.ts docs/glovo-discovery.md tests/recorder.test.ts
git commit -m "feat: discovery recorder for Glovo endpoints with redaction"
```

---

### Task 5: Pricing engine and split rule

**Effort:** high

**Files:**
- Create: `src/pricing/types.ts`, `src/pricing/split.ts`
- Test: `tests/pricing.test.ts`

**Interfaces:**
- Consumes: `Tetri` from `src/money.ts`.
- Produces:
  ```ts
  type Category = "meat" | "fish" | "fruit" | "vegetable" | "dairy" | "bakery" | "grain" | "pantry" | "drink" | "household" | "other";
  interface BasketItem { key: string; name: string; qty: number; category: Category }
  interface StoreInfo { store: string; deliveryFee: Tetri; minOrder: Tetri }
  interface ItemQuote { itemKey: string; store: string; unitPrice: Tetri; source: "glovo" | "dazoge" }
  interface SplitConfig { anchorStore: string; protectedCategories: Category[]; marginTetri: Tetri }
  const DEFAULT_SPLIT_CONFIG: SplitConfig;   // agrohub, [meat, fish, fruit], 1000
  interface CartLine { itemKey: string; name: string; qty: number; unitPrice: Tetri; lineTotal: Tetri; source: "glovo" | "dazoge" }
  interface ProposedCart { store: string; lines: CartLine[]; subtotal: Tetri; deliveryFee: Tetri; total: Tetri; meetsMinimum: boolean }
  interface SplitDecision { carts: ProposedCart[]; anchorOnlyTotal: Tetri; savings: Tetri; unpriced: string[]; reason: string }
  function decideSplit(basket: BasketItem[], quotes: ItemQuote[], stores: StoreInfo[], config?: SplitConfig): SplitDecision;
  ```

Semantics: `savings` is anchor-only total minus split total, both including delivery fees. Because fees are inside both totals, the spec's rule "savings exceed the extra fee plus margin" reduces to `savings > marginTetri`. Items with no quote at the anchor are listed in `unpriced` and excluded from every total. Non-protected items with no quote at the alternative store fall back to the anchor cart. `reason` is a one-sentence explanation suitable for showing the user.

- [ ] **Step 1: Write the failing tests**

`tests/pricing.test.ts`:
```ts
import { test, expect } from "bun:test";
import { decideSplit, DEFAULT_SPLIT_CONFIG } from "../src/pricing/split";
import type { BasketItem, ItemQuote, StoreInfo } from "../src/pricing/types";

const stores: StoreInfo[] = [
  { store: "agrohub", deliveryFee: 500, minOrder: 2000 },
  { store: "goodwill", deliveryFee: 400, minOrder: 1500 },
  { store: "carrefour", deliveryFee: 300, minOrder: 1500 },
];

const basket: BasketItem[] = [
  { key: "chicken", name: "Chicken thighs 1kg", qty: 1, category: "meat" },
  { key: "apples", name: "Apples 1kg", qty: 1, category: "fruit" },
  { key: "milk", name: "Milk 1L", qty: 3, category: "dairy" },
  { key: "rice", name: "Rice 1kg", qty: 1, category: "grain" },
  { key: "eggs", name: "Eggs 10", qty: 1, category: "other" },
];

const q = (itemKey: string, store: string, unitPrice: number, source: "glovo" | "dazoge" = "glovo"): ItemQuote =>
  ({ itemKey, store, unitPrice, source });

test("splits when the alternative store saves more than fee plus margin", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 400), q("rice", "goodwill", 300), q("eggs", "goodwill", 500),
    q("milk", "carrefour", 450), q("rice", "carrefour", 600), q("eggs", "carrefour", 900),
  ];
  const d = decideSplit(basket, quotes, stores);
  // anchor only: 2500+900+1500+800+1200 = 6900 + fee 500 = 7400
  expect(d.anchorOnlyTotal).toBe(7400);
  expect(d.carts.map((c) => c.store)).toEqual(["agrohub", "goodwill"]);
  const [ag, gw] = d.carts;
  expect(ag!.lines.map((l) => l.itemKey)).toEqual(["chicken", "apples"]);
  expect(ag!.subtotal).toBe(3400); expect(ag!.total).toBe(3900);
  expect(gw!.lines.map((l) => l.itemKey)).toEqual(["milk", "rice", "eggs"]);
  expect(gw!.subtotal).toBe(1200 + 300 + 500); expect(gw!.total).toBe(2400);
  expect(d.savings).toBe(7400 - 3900 - 2400); // 1100 > margin 1000
  expect(d.unpriced).toEqual([]);
});

test("does not split when savings are within the margin", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 450), q("rice", "goodwill", 700), q("eggs", "goodwill", 1100),
  ];
  const d = decideSplit(basket, quotes, stores);
  expect(d.carts.length).toBe(1);
  expect(d.carts[0]!.store).toBe("agrohub");
  expect(d.carts[0]!.total).toBe(7400);
  expect(d.savings).toBe(0);
  expect(d.reason).toMatch(/margin/i);
});

test("protected categories never leave the anchor even when cheaper elsewhere", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("chicken", "goodwill", 100), q("apples", "goodwill", 100),
    q("milk", "goodwill", 100), q("rice", "goodwill", 100), q("eggs", "goodwill", 100),
  ];
  const d = decideSplit(basket, quotes, stores);
  const ag = d.carts.find((c) => c.store === "agrohub")!;
  expect(ag.lines.map((l) => l.itemKey).sort()).toEqual(["apples", "chicken"]);
});

test("no split when the alternative cart would miss the store minimum (Review Focus 4)", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 100), q("rice", "goodwill", 100), q("eggs", "goodwill", 100), // subtotal 500 < 1500
  ];
  const d = decideSplit(basket, quotes, stores);
  expect(d.carts.length).toBe(1);
  expect(d.reason).toMatch(/minimum/i);
  expect(d.reason).toMatch(/goodwill/);
});

test("items unquoted at the alternative store fall back to the anchor cart", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 100), q("rice", "goodwill", 100), // no eggs at goodwill
  ];
  const d = decideSplit(basket, quotes, stores);
  if (d.carts.length === 2) {
    const ag = d.carts.find((c) => c.store === "agrohub")!;
    expect(ag.lines.map((l) => l.itemKey)).toContain("eggs");
  } else {
    expect(d.carts[0]!.lines.map((l) => l.itemKey)).toContain("eggs");
  }
});

test("items with no anchor quote are reported unpriced and excluded from totals (Review Focus 1)", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), // eggs missing everywhere
  ];
  const d = decideSplit(basket, quotes, stores);
  expect(d.unpriced).toEqual(["eggs"]);
  expect(d.anchorOnlyTotal).toBe(2500 + 900 + 1500 + 800 + 500);
  for (const c of d.carts) expect(c.lines.find((l) => l.itemKey === "eggs")).toBeUndefined();
});

test("prefers glovo quotes over dazoge quotes for the same item and store", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 999, "dazoge"), q("milk", "agrohub", 500, "glovo"),
    q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
  ];
  const d = decideSplit(basket, quotes, stores);
  const milk = d.carts[0]!.lines.find((l) => l.itemKey === "milk")!;
  expect(milk.unitPrice).toBe(500);
  expect(milk.source).toBe("glovo");
});

test("anchor-only cart below anchor minimum is flagged", () => {
  const small: BasketItem[] = [{ key: "milk", name: "Milk", qty: 1, category: "dairy" }];
  const d = decideSplit(small, [q("milk", "agrohub", 500)], stores);
  expect(d.carts[0]!.meetsMinimum).toBe(false);
  expect(d.reason).toMatch(/minimum/i);
});

test("default config matches the spec", () => {
  expect(DEFAULT_SPLIT_CONFIG).toEqual({ anchorStore: "agrohub", protectedCategories: ["meat", "fish", "fruit"], marginTetri: 1000 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/pricing.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement types.ts and split.ts**

`src/pricing/types.ts`:
```ts
import type { Tetri } from "../money";

export type Category =
  | "meat" | "fish" | "fruit" | "vegetable" | "dairy" | "bakery" | "grain" | "pantry" | "drink" | "household" | "other";

export interface BasketItem { key: string; name: string; qty: number; category: Category }
export interface StoreInfo { store: string; deliveryFee: Tetri; minOrder: Tetri }
export interface ItemQuote { itemKey: string; store: string; unitPrice: Tetri; source: "glovo" | "dazoge" }
export interface SplitConfig { anchorStore: string; protectedCategories: Category[]; marginTetri: Tetri }
export interface CartLine { itemKey: string; name: string; qty: number; unitPrice: Tetri; lineTotal: Tetri; source: "glovo" | "dazoge" }
export interface ProposedCart { store: string; lines: CartLine[]; subtotal: Tetri; deliveryFee: Tetri; total: Tetri; meetsMinimum: boolean }
export interface SplitDecision { carts: ProposedCart[]; anchorOnlyTotal: Tetri; savings: Tetri; unpriced: string[]; reason: string }
```

`src/pricing/split.ts`:
```ts
import type { BasketItem, CartLine, ItemQuote, ProposedCart, SplitConfig, SplitDecision, StoreInfo } from "./types";

export const DEFAULT_SPLIT_CONFIG: SplitConfig = {
  anchorStore: "agrohub",
  protectedCategories: ["meat", "fish", "fruit"],
  marginTetri: 1000,
};

type QuoteIndex = Map<string, Map<string, ItemQuote>>; // itemKey -> store -> best quote

function indexQuotes(quotes: ItemQuote[]): QuoteIndex {
  const idx: QuoteIndex = new Map();
  for (const q of quotes) {
    const byStore = idx.get(q.itemKey) ?? new Map<string, ItemQuote>();
    const existing = byStore.get(q.store);
    // glovo beats dazoge; otherwise keep the first seen
    if (!existing || (existing.source === "dazoge" && q.source === "glovo")) byStore.set(q.store, q);
    idx.set(q.itemKey, byStore);
  }
  return idx;
}

function buildCart(store: string, items: BasketItem[], idx: QuoteIndex, stores: StoreInfo[]): ProposedCart {
  const info = stores.find((s) => s.store === store);
  if (!info) throw new Error(`Unknown store ${store}`);
  const lines: CartLine[] = [];
  for (const it of items) {
    const qt = idx.get(it.key)?.get(store);
    if (!qt) continue;
    lines.push({ itemKey: it.key, name: it.name, qty: it.qty, unitPrice: qt.unitPrice, lineTotal: qt.unitPrice * it.qty, source: qt.source });
  }
  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  return { store, lines, subtotal, deliveryFee: info.deliveryFee, total: subtotal + info.deliveryFee, meetsMinimum: subtotal >= info.minOrder };
}

export function decideSplit(
  basket: BasketItem[],
  quotes: ItemQuote[],
  stores: StoreInfo[],
  config: SplitConfig = DEFAULT_SPLIT_CONFIG,
): SplitDecision {
  const idx = indexQuotes(quotes);
  const anchor = config.anchorStore;
  const anchorInfo = stores.find((s) => s.store === anchor);
  if (!anchorInfo) throw new Error(`Anchor store ${anchor} not in stores list`);

  const unpriced = basket.filter((it) => !idx.get(it.key)?.get(anchor)).map((it) => it.key);
  const priced = basket.filter((it) => !unpriced.includes(it.key));
  const isProtected = (it: BasketItem) => config.protectedCategories.includes(it.category);

  const anchorOnly = buildCart(anchor, priced, idx, stores);

  let best: { carts: ProposedCart[]; savings: number } | null = null;
  const rejections: string[] = [];

  for (const alt of stores) {
    if (alt.store === anchor) continue;
    const movable = priced.filter((it) => !isProtected(it) && idx.get(it.key)?.get(alt.store));
    if (movable.length === 0) continue;
    const staying = priced.filter((it) => !movable.includes(it));
    const altCart = buildCart(alt.store, movable, idx, stores);
    const anchorCart = buildCart(anchor, staying, idx, stores);
    const savings = anchorOnly.total - (altCart.total + anchorCart.total);
    if (!altCart.meetsMinimum) { rejections.push(`${alt.store} cart ${altCart.subtotal} is under its minimum ${alt.minOrder}`); continue; }
    if (anchorCart.lines.length > 0 && !anchorCart.meetsMinimum) { rejections.push(`${anchor} remainder ${anchorCart.subtotal} is under its minimum ${anchorInfo.minOrder}`); continue; }
    if (!best || savings > best.savings) best = { carts: anchorCart.lines.length ? [anchorCart, altCart] : [altCart], savings };
  }

  if (best && best.savings > config.marginTetri) {
    return {
      carts: best.carts,
      anchorOnlyTotal: anchorOnly.total,
      savings: best.savings,
      unpriced,
      reason: `Splitting saves ${best.savings} tetri after both delivery fees, above the ${config.marginTetri} tetri margin.`,
    };
  }

  const why = best
    ? `Best split would save only ${best.savings} tetri, within the ${config.marginTetri} tetri margin.`
    : rejections.length
      ? `No split: ${rejections.join("; ")}.`
      : "No alternative store had quotes for the non-protected items.";
  const minNote = anchorOnly.meetsMinimum ? "" : ` Note: the ${anchor} cart is under its minimum order.`;
  return { carts: [anchorOnly], anchorOnlyTotal: anchorOnly.total, savings: 0, unpriced, reason: why + minNote };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test tests/pricing.test.ts`
Expected: 9 pass. If the "minimum" test fails because the reason string lacks the word, check that the rejection message flows into `reason` when no split is possible.

- [ ] **Step 5: Commit**

```bash
git add src/pricing tests/pricing.test.ts
git commit -m "feat: pricing engine with protected categories and store split rule"
```

---

### Task 6: Product matching

**Effort:** high

**Files:**
- Create: `src/matching/normalize.ts`, `src/matching/score.ts`, `src/matching/resolver.ts`
- Test: `tests/matching.test.ts`

**Interfaces:**
- Consumes: `DazogeClient` (`search`, `getProduct`) from Task 2.
- Produces:
  ```ts
  interface NormalizedName { tokens: string[]; volumeMl: number | null; weightG: number | null; percent: number | null }
  function normalizeName(raw: string): NormalizedName;
  function scoreCandidate(a: NormalizedName, b: NormalizedName): number;   // 0..1
  const THRESHOLDS: { accept: number; consider: number };                  // 0.75, 0.4
  interface CachedMatch { glovoKey: string; dazogeId: string; confidence: number; confirmedAt: string }
  interface MatchCache { get(glovoKey: string): CachedMatch | null; put(m: CachedMatch): void }
  interface GlovoProductLike { key: string; name: string; barcode?: string | null }
  type MatchResult =
    | { status: "matched"; dazogeId: string; confidence: number; via: "cache" | "barcode" | "name" }
    | { status: "ambiguous"; candidates: Array<{ dazogeId: string; name: string; score: number }> }
    | { status: "none" };
  function resolve(p: GlovoProductLike, deps: { dazoge: Pick<DazogeClient, "search" | "getProduct">; cache: MatchCache }): Promise<MatchResult>;
  class MemoryMatchCache implements MatchCache
  ```

- [ ] **Step 1: Write the failing tests**

`tests/matching.test.ts`:
```ts
import { test, expect } from "bun:test";
import { normalizeName } from "../src/matching/normalize";
import { scoreCandidate, THRESHOLDS } from "../src/matching/score";
import { resolve, MemoryMatchCache } from "../src/matching/resolver";
import type { DazogeProduct, DazogeSearchPage } from "../src/dazoge/types";

test("normalizeName extracts volume, weight, percent and lowercased tokens across scripts", () => {
  expect(normalizeName("სანტე-რძე 2.5% 1ლ")).toEqual({ tokens: ["სანტე", "რძე"], volumeMl: 1000, weightG: null, percent: 2.5 });
  expect(normalizeName("Sante Milk 2,5% 1 L")).toEqual({ tokens: ["სანტე", "რძე"], volumeMl: 1000, weightG: null, percent: 2.5 });
  expect(normalizeName("ყველი ბრი /Milky Lux / 1კგ")).toEqual({ tokens: ["ყველი", "ბრი", "milky", "lux"], volumeMl: null, weightG: 1000, percent: null });
  expect(normalizeName("PALMOLIVE Milk&Olive 90 გრ.")).toEqual({ tokens: ["palmolive", "რძე", "olive"], volumeMl: null, weightG: 90, percent: null });
  expect(normalizeName("Eggs 10 pcs 500ml")).toEqual({ tokens: ["კვერცხი", "pcs"], volumeMl: 500, weightG: null, percent: null });
});

test("scoreCandidate rewards token overlap and matching quantities", () => {
  const a = normalizeName("Sante Milk 2.5% 1L");
  const same = normalizeName("სანტე-რძე 2.5% 1ლ");
  const otherFat = normalizeName("სანტე-რძე 3.2% 1ლ");
  const unrelated = normalizeName("PALMOLIVE Milk&Olive 90 გრ.");
  expect(scoreCandidate(a, same)).toBeGreaterThanOrEqual(THRESHOLDS.accept);
  expect(scoreCandidate(a, otherFat)).toBeLessThan(scoreCandidate(a, same));
  expect(scoreCandidate(a, otherFat)).toBeGreaterThanOrEqual(THRESHOLDS.consider);
  expect(scoreCandidate(a, unrelated)).toBeLessThan(THRESHOLDS.consider);
});

const product = (id: string, name: string): DazogeProduct => ({ id, name, volume: "", imageUrl: "", prices: [] });
const page = (items: Array<{ id: string; name: string }>): DazogeSearchPage => ({
  query: "", page: 1, hasMore: false,
  items: items.map((i) => ({ ...i, volume: "", price: 1, oldPrice: null, store: "x", storeSlug: null })),
});

test("resolve uses the cache first", async () => {
  const cache = new MemoryMatchCache();
  cache.put({ glovoKey: "g1", dazogeId: "d1", confidence: 1, confirmedAt: "2026-01-01" });
  const dazoge = { search: async () => { throw new Error("should not search"); }, getProduct: async () => null };
  expect(await resolve({ key: "g1", name: "anything" }, { dazoge, cache })).toEqual({ status: "matched", dazogeId: "d1", confidence: 1, via: "cache" });
});

test("resolve matches by barcode when Dazoge knows it, and caches", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = { search: async () => page([]), getProduct: async (id: string) => (id === "4860051001298" ? product(id, "სანტე-რძე 2.5% 1ლ") : null) };
  const r = await resolve({ key: "g2", name: "Sante milk", barcode: "4860051001298" }, { dazoge, cache });
  expect(r).toEqual({ status: "matched", dazogeId: "4860051001298", confidence: 1, via: "barcode" });
  expect(cache.get("g2")?.dazogeId).toBe("4860051001298");
});

test("resolve falls back to name search when barcode is unknown to Dazoge", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = {
    getProduct: async () => null,
    search: async () => page([{ id: "4860051001298", name: "სანტე-რძე 2.5% 1ლ" }, { id: "4860051003018", name: "სანტე-რძე 3.2% 1ლ" }]),
  };
  const r = await resolve({ key: "g3", name: "Sante Milk 2.5% 1L", barcode: "999" }, { dazoge, cache });
  expect(r.status).toBe("matched");
  if (r.status === "matched") { expect(r.dazogeId).toBe("4860051001298"); expect(r.via).toBe("name"); }
});

test("resolve returns ambiguous candidates and does not cache them", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = {
    getProduct: async () => null,
    search: async () => page([{ id: "a", name: "სანტე-რძე 3.2% 1ლ" }, { id: "b", name: "სანტე-რძე 1.5% 1ლ" }]),
  };
  const r = await resolve({ key: "g4", name: "Sante Milk 1L" }, { dazoge, cache });
  expect(r.status).toBe("ambiguous");
  if (r.status === "ambiguous") expect(r.candidates.length).toBe(2);
  expect(cache.get("g4")).toBeNull();
});

test("resolve returns none when nothing scores above consider", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = { getProduct: async () => null, search: async () => page([{ id: "z", name: "PALMOLIVE Milk&Olive 90 გრ." }]) };
  expect(await resolve({ key: "g5", name: "Sante Milk 2.5% 1L" }, { dazoge, cache })).toEqual({ status: "none" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/matching.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement normalize.ts**

`src/matching/normalize.ts`:
```ts
export interface NormalizedName { tokens: string[]; volumeMl: number | null; weightG: number | null; percent: number | null }

/**
 * Latin spellings seen on Glovo mapped to the Georgian spelling Dazoge uses.
 * Brands first, then generic food words. Extend as mismatches appear; every
 * entry maps a Latin token to a single canonical Georgian token.
 */
const ALIASES: Record<string, string> = {
  // brands
  sante: "სანტე",
  natakhtari: "ნატახტარი",
  sopeli: "სოფელი",
  nikora: "ნიკორა",
  koda: "კოდა",
  barambo: "ბარამბო",
  zedazeni: "ზედაზენი",
  // generic words
  milk: "რძე", молоко: "რძე",
  cheese: "ყველი", сыр: "ყველი",
  eggs: "კვერცხი", egg: "კვერცხი", яйца: "კვერცხი",
  chicken: "ქათამი", курица: "ქათამი",
  beef: "საქონლის", говядина: "საქონლის",
  pork: "ღორის", свинина: "ღორის",
  butter: "კარაქი", масло: "კარაქი",
  yogurt: "იოგურტი", yoghurt: "იოგურტი", йогурт: "იოგურტი",
  rice: "ბრინჯი", рис: "ბრინჯი",
  bread: "პური", хлеб: "პური",
  water: "წყალი", вода: "წყალი",
};

const STOP = new Set(["და", "the", "and", "with", "of", "ml", "l", "g", "kg", "gr", "ლ", "მლ", "გ", "გრ", "კგ", "ც", "x"]);

// `\b` is ASCII-only in JS, so Georgian units need an explicit "not followed by a letter" guard.
const NUM = "(\\d+(?:[.,]\\d+)?)";
const VOLUME_RE = new RegExp(`${NUM}\\s*(მლ|ml|ლ|l|lt|litre|liter)(?!\\p{L})`, "iu");
const WEIGHT_RE = new RegExp(`${NUM}\\s*(კგ|kg|გრ|გ|g|gr)(?!\\p{L})`, "iu");
const PERCENT_RE = new RegExp(`${NUM}\\s*%`, "u");

const num = (s: string) => Number(s.replace(",", "."));

export function normalizeName(raw: string): NormalizedName {
  let s = raw.toLowerCase();

  let percent: number | null = null;
  const pm = s.match(PERCENT_RE);
  if (pm && pm[1]) { percent = num(pm[1]); s = s.replace(pm[0], " "); }

  let volumeMl: number | null = null;
  const vm = s.match(VOLUME_RE);
  if (vm && vm[1] && vm[2]) {
    const n = num(vm[1]);
    volumeMl = /^(მლ|ml)$/i.test(vm[2]) ? Math.round(n) : Math.round(n * 1000);
    s = s.replace(vm[0], " ");
  }

  let weightG: number | null = null;
  const wm = s.match(WEIGHT_RE);
  if (wm && wm[1] && wm[2]) {
    const n = num(wm[1]);
    weightG = /^(კგ|kg)$/i.test(wm[2]) ? Math.round(n * 1000) : Math.round(n);
    s = s.replace(wm[0], " ");
  }

  const tokens = s
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOP.has(t))
    .map((t) => ALIASES[t] ?? t);

  return { tokens, volumeMl, weightG, percent };
}
```

- [ ] **Step 4: Implement score.ts**

`src/matching/score.ts`:
```ts
import type { NormalizedName } from "./normalize";

export const THRESHOLDS = { accept: 0.75, consider: 0.4 } as const;

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Compares two quantities: 1 when equal, 0 when one side is missing or they differ. */
function qty(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null; // not applicable
  if (a === null || b === null) return 0;
  return Math.abs(a - b) / Math.max(a, b) <= 0.05 ? 1 : 0;
}

/**
 * Weighted blend: tokens 0.6, quantity (volume or weight) 0.25, percent 0.15.
 * Components that do not apply to either side are dropped and weights renormalised.
 */
export function scoreCandidate(a: NormalizedName, b: NormalizedName): number {
  const parts: Array<[number, number]> = [[jaccard(a.tokens, b.tokens), 0.6]];
  const q = qty(a.volumeMl ?? a.weightG, b.volumeMl ?? b.weightG);
  if (q !== null) parts.push([q, 0.25]);
  const p = qty(a.percent, b.percent);
  if (p !== null) parts.push([p, 0.15]);
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  return parts.reduce((s, [v, w]) => s + v * w, 0) / wsum;
}
```

- [ ] **Step 5: Implement resolver.ts**

`src/matching/resolver.ts`:
```ts
import type { DazogeClient } from "../dazoge/client";
import { normalizeName } from "./normalize";
import { scoreCandidate, THRESHOLDS } from "./score";

export interface CachedMatch { glovoKey: string; dazogeId: string; confidence: number; confirmedAt: string }
export interface MatchCache { get(glovoKey: string): CachedMatch | null; put(m: CachedMatch): void }
export interface GlovoProductLike { key: string; name: string; barcode?: string | null }

export type MatchResult =
  | { status: "matched"; dazogeId: string; confidence: number; via: "cache" | "barcode" | "name" }
  | { status: "ambiguous"; candidates: Array<{ dazogeId: string; name: string; score: number }> }
  | { status: "none" };

export class MemoryMatchCache implements MatchCache {
  private m = new Map<string, CachedMatch>();
  get(k: string) { return this.m.get(k) ?? null; }
  put(x: CachedMatch) { this.m.set(x.glovoKey, x); }
}

/** Query Dazoge with the most distinctive tokens: brand alias first, then the rest, max 3. */
function searchQuery(name: string): string {
  const n = normalizeName(name);
  return n.tokens.slice(0, 3).join(" ") || name;
}

export async function resolve(
  p: GlovoProductLike,
  deps: { dazoge: Pick<DazogeClient, "search" | "getProduct">; cache: MatchCache },
): Promise<MatchResult> {
  const cached = deps.cache.get(p.key);
  if (cached) return { status: "matched", dazogeId: cached.dazogeId, confidence: cached.confidence, via: "cache" };

  if (p.barcode) {
    const hit = await deps.dazoge.getProduct(p.barcode);
    if (hit) {
      deps.cache.put({ glovoKey: p.key, dazogeId: hit.id, confidence: 1, confirmedAt: new Date().toISOString() });
      return { status: "matched", dazogeId: hit.id, confidence: 1, via: "barcode" };
    }
  }

  const target = normalizeName(p.name);
  const page = await deps.dazoge.search(searchQuery(p.name));
  const scored = page.items
    .map((it) => ({ dazogeId: it.id, name: it.name, score: scoreCandidate(target, normalizeName(it.name)) }))
    .filter((c) => c.score >= THRESHOLDS.consider)
    .sort((a, b) => b.score - a.score);

  // De-duplicate by id (search returns one row per store).
  const seen = new Set<string>();
  const unique = scored.filter((c) => (seen.has(c.dazogeId) ? false : (seen.add(c.dazogeId), true)));

  if (unique.length === 0) return { status: "none" };
  const top = unique[0]!;
  const runnerUp = unique[1];
  const clearWinner = top.score >= THRESHOLDS.accept && (!runnerUp || top.score - runnerUp.score >= 0.1);
  if (clearWinner) {
    deps.cache.put({ glovoKey: p.key, dazogeId: top.dazogeId, confidence: top.score, confirmedAt: new Date().toISOString() });
    return { status: "matched", dazogeId: top.dazogeId, confidence: top.score, via: "name" };
  }
  return { status: "ambiguous", candidates: unique.slice(0, 5) };
}
```

- [ ] **Step 6: Run tests, verify pass**

Run: `bun test tests/matching.test.ts`
Expected: 7 pass. If the "ambiguous" test resolves to matched, the two candidates scored too far apart; the intent is that "Sante Milk 1L" with no percent cannot pick between 3.2% and 1.5%, so confirm `qty(null, 3.2)` returns 0 (missing on one side counts against) and both candidates land in the consider band.

- [ ] **Step 7: Commit**

```bash
git add src/matching tests/matching.test.ts
git commit -m "feat: Glovo to Dazoge product matching with barcode, name scoring and cache"
```

---

### Task 7: Database and planner repositories

**Effort:** medium

**Files:**
- Create: `src/db/schema.ts`, `src/db/index.ts`, `src/planner/units.ts`, `src/planner/pantry.ts`, `src/planner/meals.ts`, `src/planner/deliveries.ts`, `src/planner/notes.ts`, `src/planner/matchCache.ts`
- Test: `tests/planner.test.ts`

**Interfaces:**
- Consumes: `MatchCache`, `CachedMatch` from Task 6.
- Produces:
  ```ts
  function openDb(path: string): Database;   // ":memory:" allowed; runs migrations
  class UnitMismatchError extends Error
  function convertQty(qty: number, from: string, to: string): number;   // g<->kg, ml<->l, same unit identity
  interface PantryRow { ingredient: string; qty: number; unit: string; updatedAt: string }
  class PantryRepo { constructor(db); list(): PantryRow[]; set(ingredient, qty, unit): void; adjust(ingredient, delta, unit): PantryRow; }
  interface Meal { id: number; date: string; slot: "breakfast"|"lunch"|"dinner"; title: string; notes: string | null; status: "planned"|"cooked"|"skipped"; ingredients: Array<{ ingredient: string; qty: number; unit: string }> }
  type NewMeal = Omit<Meal, "id" | "status">;
  class MealsRepo { constructor(db); recent(days: number, today?: string): Meal[]; savePlan(meals: NewMeal[]): number[]; mark(id: number, status: Meal["status"]): Meal; }
  interface DeliveryItem { productName: string; qty: number; unit: string; priceTetri: number; ingredient?: string }
  class DeliveriesRepo { constructor(db, pantry: PantryRepo); record(input: { glovoOrderId: string; store: string; placedAt?: string; items: DeliveryItem[] }): { id: number; total: number }; recent(limit: number): Array<{ id: number; glovoOrderId: string; store: string; placedAt: string; total: number; status: string }>; }
  class NotesRepo { constructor(db); add(text: string): number; recent(limit: number): Array<{ id: number; createdAt: string; text: string }>; }
  class SqliteMatchCache implements MatchCache
  ```

- [ ] **Step 1: Write the failing tests**

`tests/planner.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { openDb } from "../src/db/index";
import { convertQty, UnitMismatchError } from "../src/planner/units";
import { PantryRepo } from "../src/planner/pantry";
import { MealsRepo } from "../src/planner/meals";
import { DeliveriesRepo } from "../src/planner/deliveries";
import { NotesRepo } from "../src/planner/notes";
import { SqliteMatchCache } from "../src/planner/matchCache";

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(":memory:"); });

test("openDb is idempotent and creates the tables", () => {
  openDb(":memory:");
  const names = db.query("select name from sqlite_master where type='table' order by name").all() as { name: string }[];
  const set = new Set(names.map((n) => n.name));
  for (const t of ["product", "product_match", "delivery", "delivery_item", "meal", "meal_ingredient", "pantry", "note", "checkout_log"]) expect(set.has(t)).toBe(true);
});

test("convertQty handles mass, volume and identity; throws on mismatch (Review Focus 5)", () => {
  expect(convertQty(500, "g", "kg")).toBe(0.5);
  expect(convertQty(1.5, "kg", "g")).toBe(1500);
  expect(convertQty(250, "ml", "l")).toBe(0.25);
  expect(convertQty(3, "pcs", "pcs")).toBe(3);
  expect(() => convertQty(1, "kg", "l")).toThrow(UnitMismatchError);
  expect(() => convertQty(1, "pcs", "g")).toThrow(UnitMismatchError);
});

test("pantry set, adjust with unit conversion, never negative", () => {
  const p = new PantryRepo(db);
  p.set("rice", 1, "kg");
  expect(p.adjust("rice", -300, "g").qty).toBeCloseTo(0.7);
  expect(p.adjust("rice", -5, "kg").qty).toBe(0);
  expect(() => p.adjust("rice", 1, "l")).toThrow(UnitMismatchError);
  p.adjust("eggs", 10, "pcs"); // adjust on a missing row creates it
  expect(p.list().map((r) => r.ingredient).sort()).toEqual(["eggs", "rice"]);
});

test("meals savePlan, recent window, mark cooked decrements pantry", () => {
  const p = new PantryRepo(db);
  p.set("chicken", 1, "kg");
  const m = new MealsRepo(db, p);
  const ids = m.savePlan([
    { date: "2026-09-25", slot: "dinner", title: "Roast chicken", notes: null, ingredients: [{ ingredient: "chicken", qty: 600, unit: "g" }] },
    { date: "2026-09-10", slot: "lunch", title: "Old meal", notes: null, ingredients: [] },
  ]);
  expect(ids.length).toBe(2);
  const recent = m.recent(14, "2026-09-25");
  expect(recent.map((x) => x.title)).toEqual(["Roast chicken"]);
  expect(recent[0]!.ingredients).toEqual([{ ingredient: "chicken", qty: 600, unit: "g" }]);
  const cooked = m.mark(ids[0]!, "cooked");
  expect(cooked.status).toBe("cooked");
  expect(p.list().find((r) => r.ingredient === "chicken")!.qty).toBeCloseTo(0.4);
  // marking cooked twice must not decrement twice
  m.mark(ids[0]!, "cooked");
  expect(p.list().find((r) => r.ingredient === "chicken")!.qty).toBeCloseTo(0.4);
});

test("delivery record stores items, computes total, increments pantry by ingredient", () => {
  const p = new PantryRepo(db);
  p.set("milk", 1, "l");
  const d = new DeliveriesRepo(db, p);
  const r = d.record({
    glovoOrderId: "G-1", store: "goodwill",
    items: [
      { productName: "Sante milk 1L", qty: 3, unit: "l", priceTetri: 399, ingredient: "milk" },
      { productName: "Eggs 10", qty: 1, unit: "pcs", priceTetri: 550 },
    ],
  });
  expect(r.total).toBe(3 * 399 + 550);
  expect(p.list().find((x) => x.ingredient === "milk")!.qty).toBe(4);
  expect(p.list().find((x) => x.ingredient === "Eggs 10")!.qty).toBe(1);
  expect(d.recent(5)[0]).toMatchObject({ glovoOrderId: "G-1", store: "goodwill", total: r.total, status: "placed" });
});

test("notes add and recent newest first", () => {
  const n = new NotesRepo(db);
  n.add("chicken was bad");
  n.add("loved the salmon");
  expect(n.recent(10).map((x) => x.text)).toEqual(["loved the salmon", "chicken was bad"]);
});

test("SqliteMatchCache round trips and overwrites", () => {
  const c = new SqliteMatchCache(db);
  expect(c.get("k")).toBeNull();
  c.put({ glovoKey: "k", dazogeId: "d1", confidence: 0.9, confirmedAt: "2026-09-25T00:00:00Z" });
  c.put({ glovoKey: "k", dazogeId: "d2", confidence: 1, confirmedAt: "2026-09-26T00:00:00Z" });
  expect(c.get("k")).toEqual({ glovoKey: "k", dazogeId: "d2", confidence: 1, confirmedAt: "2026-09-26T00:00:00Z" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/planner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement schema.ts and index.ts**

`src/db/schema.ts`:
```ts
export const MIGRATIONS: string[] = [
  `
  create table if not exists product (
    id integer primary key,
    store text not null,
    glovo_id text not null,
    name text not null,
    barcode text,
    unit text,
    last_price integer,
    last_seen text not null,
    unique(store, glovo_id)
  );
  create table if not exists product_match (
    glovo_key text primary key,
    dazoge_id text not null,
    confidence real not null,
    confirmed_at text not null
  );
  create table if not exists delivery (
    id integer primary key,
    glovo_order_id text not null unique,
    store text not null,
    placed_at text not null,
    total integer not null,
    status text not null default 'placed'
  );
  create table if not exists delivery_item (
    id integer primary key,
    delivery_id integer not null references delivery(id),
    product_name text not null,
    ingredient text,
    qty real not null,
    unit text not null,
    price integer not null
  );
  create table if not exists meal (
    id integer primary key,
    date text not null,
    slot text not null check (slot in ('breakfast','lunch','dinner')),
    title text not null,
    notes text,
    status text not null default 'planned' check (status in ('planned','cooked','skipped'))
  );
  create table if not exists meal_ingredient (
    id integer primary key,
    meal_id integer not null references meal(id),
    ingredient text not null,
    qty real not null,
    unit text not null
  );
  create table if not exists pantry (
    ingredient text primary key,
    qty real not null,
    unit text not null,
    updated_at text not null
  );
  create table if not exists note (
    id integer primary key,
    created_at text not null,
    text text not null
  );
  create table if not exists checkout_log (
    id integer primary key,
    created_at text not null,
    cart_json text not null,
    outcome text not null,
    glovo_order_id text,
    screenshot text
  );
  `,
];
```

`src/db/index.ts`:
```ts
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./schema";

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("pragma journal_mode = WAL; pragma foreign_keys = on;");
  db.exec("create table if not exists schema_version (version integer not null)");
  const row = db.query("select max(version) as v from schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]!);
    db.query("insert into schema_version(version) values (?)").run(i + 1);
  }
  return db;
}

export type { Database };
```

- [ ] **Step 4: Implement units.ts and pantry.ts**

`src/planner/units.ts`:
```ts
export class UnitMismatchError extends Error {
  constructor(from: string, to: string) { super(`Cannot convert ${from} to ${to}`); this.name = "UnitMismatchError"; }
}

const FACTORS: Record<string, { dim: "mass" | "volume"; toBase: number }> = {
  g: { dim: "mass", toBase: 1 }, kg: { dim: "mass", toBase: 1000 },
  ml: { dim: "volume", toBase: 1 }, l: { dim: "volume", toBase: 1000 },
};

export function convertQty(qty: number, from: string, to: string): number {
  const f = from.trim().toLowerCase(), t = to.trim().toLowerCase();
  if (f === t) return qty;
  const a = FACTORS[f], b = FACTORS[t];
  if (!a || !b || a.dim !== b.dim) throw new UnitMismatchError(from, to);
  return (qty * a.toBase) / b.toBase;
}
```

`src/planner/pantry.ts`:
```ts
import type { Database } from "bun:sqlite";
import { convertQty } from "./units";

export interface PantryRow { ingredient: string; qty: number; unit: string; updatedAt: string }

export class PantryRepo {
  constructor(private readonly db: Database) {}

  list(): PantryRow[] {
    return (this.db.query("select ingredient, qty, unit, updated_at as updatedAt from pantry order by ingredient").all() as PantryRow[]);
  }

  get(ingredient: string): PantryRow | null {
    return (this.db.query("select ingredient, qty, unit, updated_at as updatedAt from pantry where ingredient = ?").get(ingredient) as PantryRow | null) ?? null;
  }

  set(ingredient: string, qty: number, unit: string): void {
    this.db.query(
      "insert into pantry(ingredient, qty, unit, updated_at) values (?, ?, ?, ?) on conflict(ingredient) do update set qty = excluded.qty, unit = excluded.unit, updated_at = excluded.updated_at",
    ).run(ingredient, Math.max(0, qty), unit, new Date().toISOString());
  }

  /** Adds delta (may be negative) converting into the stored unit. Creates the row if missing. Floors at zero. */
  adjust(ingredient: string, delta: number, unit: string): PantryRow {
    const row = this.get(ingredient);
    if (!row) { this.set(ingredient, delta, unit); return this.get(ingredient)!; }
    const converted = convertQty(delta, unit, row.unit);
    this.set(ingredient, row.qty + converted, row.unit);
    return this.get(ingredient)!;
  }
}
```

- [ ] **Step 5: Implement meals.ts, deliveries.ts, notes.ts, matchCache.ts**

`src/planner/meals.ts`:
```ts
import type { Database } from "bun:sqlite";
import type { PantryRepo } from "./pantry";

export type Slot = "breakfast" | "lunch" | "dinner";
export type MealStatus = "planned" | "cooked" | "skipped";
export interface MealIngredient { ingredient: string; qty: number; unit: string }
export interface Meal { id: number; date: string; slot: Slot; title: string; notes: string | null; status: MealStatus; ingredients: MealIngredient[] }
export type NewMeal = Omit<Meal, "id" | "status">;

export class MealsRepo {
  constructor(private readonly db: Database, private readonly pantry: PantryRepo) {}

  savePlan(meals: NewMeal[]): number[] {
    const insMeal = this.db.query("insert into meal(date, slot, title, notes) values (?, ?, ?, ?)");
    const insIng = this.db.query("insert into meal_ingredient(meal_id, ingredient, qty, unit) values (?, ?, ?, ?)");
    const ids: number[] = [];
    const tx = this.db.transaction(() => {
      for (const m of meals) {
        const id = Number(insMeal.run(m.date, m.slot, m.title, m.notes).lastInsertRowid);
        for (const i of m.ingredients) insIng.run(id, i.ingredient, i.qty, i.unit);
        ids.push(id);
      }
    });
    tx();
    return ids;
  }

  private load(where: string, ...params: unknown[]): Meal[] {
    const rows = this.db.query(`select id, date, slot, title, notes, status from meal ${where} order by date, case slot when 'breakfast' then 0 when 'lunch' then 1 else 2 end`).all(...(params as never[])) as Omit<Meal, "ingredients">[];
    const ing = this.db.query("select ingredient, qty, unit from meal_ingredient where meal_id = ?");
    return rows.map((r) => ({ ...r, ingredients: ing.all(r.id) as MealIngredient[] }));
  }

  recent(days: number, today = new Date().toISOString().slice(0, 10)): Meal[] {
    const from = new Date(new Date(today).getTime() - days * 86_400_000).toISOString().slice(0, 10);
    return this.load("where date >= ? and date <= ?", from, today);
  }

  byId(id: number): Meal | null {
    return this.load("where id = ?", id)[0] ?? null;
  }

  /** Marks status. The first transition to cooked decrements pantry by the meal's ingredients; later marks do not. */
  mark(id: number, status: MealStatus): Meal {
    const before = this.byId(id);
    if (!before) throw new Error(`No meal ${id}`);
    const tx = this.db.transaction(() => {
      this.db.query("update meal set status = ? where id = ?").run(status, id);
      if (status === "cooked" && before.status !== "cooked") {
        for (const i of before.ingredients) this.pantry.adjust(i.ingredient, -i.qty, i.unit);
      }
    });
    tx();
    return this.byId(id)!;
  }
}
```

`src/planner/deliveries.ts`:
```ts
import type { Database } from "bun:sqlite";
import type { PantryRepo } from "./pantry";

export interface DeliveryItem { productName: string; qty: number; unit: string; priceTetri: number; ingredient?: string }
export interface DeliveryRow { id: number; glovoOrderId: string; store: string; placedAt: string; total: number; status: string }

export class DeliveriesRepo {
  constructor(private readonly db: Database, private readonly pantry: PantryRepo) {}

  record(input: { glovoOrderId: string; store: string; placedAt?: string; items: DeliveryItem[] }): { id: number; total: number } {
    const total = input.items.reduce((s, i) => s + Math.round(i.priceTetri * i.qty), 0);
    const placedAt = input.placedAt ?? new Date().toISOString();
    let id = 0;
    const tx = this.db.transaction(() => {
      id = Number(this.db.query("insert into delivery(glovo_order_id, store, placed_at, total) values (?, ?, ?, ?)").run(input.glovoOrderId, input.store, placedAt, total).lastInsertRowid);
      const ins = this.db.query("insert into delivery_item(delivery_id, product_name, ingredient, qty, unit, price) values (?, ?, ?, ?, ?, ?)");
      for (const i of input.items) {
        ins.run(id, i.productName, i.ingredient ?? null, i.qty, i.unit, i.priceTetri);
        this.pantry.adjust(i.ingredient ?? i.productName, i.qty, i.unit);
      }
    });
    tx();
    return { id, total };
  }

  recent(limit: number): DeliveryRow[] {
    return this.db.query("select id, glovo_order_id as glovoOrderId, store, placed_at as placedAt, total, status from delivery order by placed_at desc limit ?").all(limit) as DeliveryRow[];
  }
}
```

`src/planner/notes.ts`:
```ts
import type { Database } from "bun:sqlite";

export class NotesRepo {
  constructor(private readonly db: Database) {}
  add(text: string): number {
    return Number(this.db.query("insert into note(created_at, text) values (?, ?)").run(new Date().toISOString(), text).lastInsertRowid);
  }
  recent(limit: number): Array<{ id: number; createdAt: string; text: string }> {
    return this.db.query("select id, created_at as createdAt, text from note order by id desc limit ?").all(limit) as Array<{ id: number; createdAt: string; text: string }>;
  }
}
```

`src/planner/matchCache.ts`:
```ts
import type { Database } from "bun:sqlite";
import type { CachedMatch, MatchCache } from "../matching/resolver";

export class SqliteMatchCache implements MatchCache {
  constructor(private readonly db: Database) {}
  get(glovoKey: string): CachedMatch | null {
    return (this.db.query("select glovo_key as glovoKey, dazoge_id as dazogeId, confidence, confirmed_at as confirmedAt from product_match where glovo_key = ?").get(glovoKey) as CachedMatch | null) ?? null;
  }
  put(m: CachedMatch): void {
    this.db.query(
      "insert into product_match(glovo_key, dazoge_id, confidence, confirmed_at) values (?, ?, ?, ?) on conflict(glovo_key) do update set dazoge_id = excluded.dazoge_id, confidence = excluded.confidence, confirmed_at = excluded.confirmed_at",
    ).run(m.glovoKey, m.dazogeId, m.confidence, m.confirmedAt);
  }
}
```

Note: the test constructs `new MealsRepo(db, p)`; the interface block above lists `MealsRepo(db)` for brevity, the real signature takes the pantry repo as the second argument.

- [ ] **Step 6: Run tests, verify pass**

Run: `bun test tests/planner.test.ts`
Expected: 7 pass.

- [ ] **Step 7: Commit**

```bash
git add src/db src/planner tests/planner.test.ts
git commit -m "feat: SQLite schema and planner repositories for pantry, meals, deliveries, notes"
```

---

### Task 8: MCP tool wiring, preferences template, README

**Effort:** medium

**Files:**
- Modify: `src/tools.ts`
- Create: `data/preferences.md`, `README.md`
- Test: `tests/tools.test.ts` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: `createServer(deps?: Partial<ServerDeps>): McpServer` where
  ```ts
  interface ServerDeps { db: Database; dazoge: DazogeClient; glovoSession: () => Promise<TokenProvider & { close(): Promise<void> }>; preferencesPath: string }
  ```
  Tools registered: `ping`, `preferences_read`, `dazoge_prices`, `dazoge_search`, `glovo_session_status`, `pantry_list`, `pantry_set`, `pantry_adjust`, `meals_recent`, `meals_plan_save`, `meal_mark`, `delivery_record`, `deliveries_recent`, `note_add`, `notes_recent`, `price_basket`.

- [ ] **Step 1: Extend the failing tools test**

Rewrite `tests/tools.test.ts` (replace the Task 1 ping test with the version below so no test opens `data/grocery.db`) and change `connectedClient` in the helper to accept deps:

`tests/helpers/mcp.ts` becomes:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerDeps } from "../../src/tools";

export async function connectedClient(deps?: Partial<ServerDeps>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(deps);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

export function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  if (!first || first.type !== "text" || first.text === undefined) throw new Error("no text content");
  return first.text;
}
```

New tests:
```ts
import { openDb } from "../src/db/index";
import { DazogeClient } from "../src/dazoge/client";

const fixture = (name: string) => Bun.file(`tests/fixtures/dazoge/${name}`).text();

function testDeps() {
  const db = openDb(":memory:");
  const dazoge = new DazogeClient((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/product/4860051001298.json")) return new Response(await fixture("product-4860051001298.json"), { status: 200 });
    if (url.includes("/api/search.json")) return new Response(await fixture("search-rdze.json"), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch);
  const glovoSession = async () => ({ getAuth: async () => null, refresh: async () => null, close: async () => {} });
  return { db, dazoge, glovoSession, preferencesPath: "data/preferences.md" };
}

test("server lists ping and answers pong (rewrite of the Task 1 test so it never opens the real database)", async () => {
  const client = await connectedClient(testDeps());
  expect((await client.listTools()).tools.map((t) => t.name)).toContain("ping");
  expect(textOf(await client.callTool({ name: "ping", arguments: {} }))).toBe("pong");
});

test("registers the full tool set", async () => {
  const client = await connectedClient(testDeps());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  for (const n of ["dazoge_prices", "dazoge_search", "glovo_session_status", "pantry_list", "pantry_set", "pantry_adjust",
    "meals_recent", "meals_plan_save", "meal_mark", "delivery_record", "deliveries_recent", "note_add", "notes_recent", "preferences_read", "price_basket"]) {
    expect(names).toContain(n);
  }
});

test("dazoge_prices returns GEL-formatted prices per store as JSON", async () => {
  const client = await connectedClient(testDeps());
  const res = await client.callTool({ name: "dazoge_prices", arguments: { id: "4860051001298" } });
  const body = JSON.parse(textOf(res));
  expect(body.name).toBe("სანტე-რძე 2.5% 1ლ");
  const gw = body.prices.find((p: { storeSlug: string }) => p.storeSlug === "goodwill");
  expect(gw.price).toBe("3.99 GEL");
  expect(gw.priceTetri).toBe(399);
});

test("glovo_session_status reports loggedIn false without a session", async () => {
  const client = await connectedClient(testDeps());
  const body = JSON.parse(textOf(await client.callTool({ name: "glovo_session_status", arguments: {} })));
  expect(body).toEqual({ loggedIn: false, hint: "Run `bun run login` in the project folder." });
});

test("pantry and meal tools round trip through the server", async () => {
  const client = await connectedClient(testDeps());
  await client.callTool({ name: "pantry_set", arguments: { ingredient: "rice", qty: 1, unit: "kg" } });
  const ids = JSON.parse(textOf(await client.callTool({ name: "meals_plan_save", arguments: { meals: [
    { date: "2026-09-25", slot: "dinner", title: "Rice bowl", notes: null, ingredients: [{ ingredient: "rice", qty: 200, unit: "g" }] },
  ] } }))).ids as number[];
  await client.callTool({ name: "meal_mark", arguments: { id: ids[0], status: "cooked" } });
  const pantry = JSON.parse(textOf(await client.callTool({ name: "pantry_list", arguments: {} })));
  expect(pantry[0].qty).toBeCloseTo(0.8);
});

test("pantry_adjust with a mismatched unit returns an error result instead of crashing", async () => {
  const client = await connectedClient(testDeps());
  await client.callTool({ name: "pantry_set", arguments: { ingredient: "rice", qty: 1, unit: "kg" } });
  const res = await client.callTool({ name: "pantry_adjust", arguments: { ingredient: "rice", delta: 1, unit: "l" } });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toMatch(/Cannot convert/);
});

test("price_basket applies the split rule and formats totals", async () => {
  const client = await connectedClient(testDeps());
  const res = await client.callTool({ name: "price_basket", arguments: {
    basket: [
      { key: "chicken", name: "Chicken", qty: 1, category: "meat" },
      { key: "milk", name: "Milk", qty: 3, category: "dairy" },
    ],
    quotes: [
      { itemKey: "chicken", store: "agrohub", unitPrice: 2500, source: "glovo" },
      { itemKey: "milk", store: "agrohub", unitPrice: 500, source: "glovo" },
      { itemKey: "milk", store: "goodwill", unitPrice: 100, source: "dazoge" },
    ],
    stores: [
      { store: "agrohub", deliveryFee: 500, minOrder: 1000 },
      { store: "goodwill", deliveryFee: 100, minOrder: 100 },
    ],
  } });
  const body = JSON.parse(textOf(res));
  expect(body.carts.length).toBe(2);
  expect(body.anchorOnlyTotal).toBe("45.00 GEL");
  expect(body.savings).toBe("11.00 GEL");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/tools.test.ts`
Expected: FAIL, `createServer` ignores deps and tools are missing.

- [ ] **Step 3: Rewrite src/tools.ts**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { config } from "./config";
import { formatGel } from "./money";
import { openDb } from "./db/index";
import { DazogeClient } from "./dazoge/client";
import { GlovoApi, GlovoApiError, type TokenProvider } from "./glovo/api";
import { PantryRepo } from "./planner/pantry";
import { MealsRepo } from "./planner/meals";
import { DeliveriesRepo } from "./planner/deliveries";
import { NotesRepo } from "./planner/notes";
import { decideSplit, DEFAULT_SPLIT_CONFIG } from "./pricing/split";
import type { Category, ProposedCart } from "./pricing/types";

export interface ServerDeps {
  db: Database;
  dazoge: DazogeClient;
  glovoSession: () => Promise<TokenProvider & { close(): Promise<void> }>;
  preferencesPath: string;
}

async function defaultGlovoSession() {
  const { GlovoSession } = await import("./glovo/session");
  return GlovoSession.launch({ profileDir: config.profileDir });
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

function guarded<A>(fn: (args: A) => Promise<unknown> | unknown) {
  return async (args: A) => {
    try { return ok(await fn(args)); }
    catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  };
}

const CATEGORY = z.enum(["meat", "fish", "fruit", "vegetable", "dairy", "bakery", "grain", "pantry", "drink", "household", "other"]);
const SLOT = z.enum(["breakfast", "lunch", "dinner"]);

const fmtCart = (c: ProposedCart) => ({
  store: c.store,
  lines: c.lines.map((l) => ({ ...l, unitPrice: formatGel(l.unitPrice), lineTotal: formatGel(l.lineTotal) })),
  subtotal: formatGel(c.subtotal), deliveryFee: formatGel(c.deliveryFee), total: formatGel(c.total), meetsMinimum: c.meetsMinimum,
});

export function createServer(overrides: Partial<ServerDeps> = {}): McpServer {
  const deps: ServerDeps = {
    db: overrides.db ?? openDb(config.dbPath),
    dazoge: overrides.dazoge ?? new DazogeClient(),
    glovoSession: overrides.glovoSession ?? defaultGlovoSession,
    preferencesPath: overrides.preferencesPath ?? config.preferencesPath,
  };
  const pantry = new PantryRepo(deps.db);
  const meals = new MealsRepo(deps.db, pantry);
  const deliveries = new DeliveriesRepo(deps.db, pantry);
  const notes = new NotesRepo(deps.db);

  const server = new McpServer({ name: "grocery-mcp", version: "0.1.0" });

  server.registerTool("ping", { description: "Health check.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "pong" }] }));

  server.registerTool("preferences_read", {
    description: "Read the user's grocery and diet preferences markdown. Call before planning meals.",
    inputSchema: {},
  }, guarded(async () => ({ markdown: await Bun.file(deps.preferencesPath).text() })));

  server.registerTool("dazoge_prices", {
    description: "Prices for one product across Georgian stores from Dazoge, by Dazoge product id (usually the EAN barcode).",
    inputSchema: { id: z.string().min(1) },
  }, guarded(async ({ id }) => {
    const p = await deps.dazoge.getProduct(id);
    if (!p) return { found: false, id };
    return { found: true, id: p.id, name: p.name, volume: p.volume, prices: p.prices.map((x) => ({ ...x, priceTetri: x.price, price: formatGel(x.price), oldPrice: x.oldPrice === null ? null : formatGel(x.oldPrice) })) };
  }));

  server.registerTool("dazoge_search", {
    description: "Search Dazoge for products by name (Georgian or Latin). Returns one row per product per store.",
    inputSchema: { query: z.string().min(1), page: z.number().int().min(1).default(1) },
  }, guarded(async ({ query, page }) => {
    const r = await deps.dazoge.search(query, page);
    return { ...r, items: r.items.map((x) => ({ ...x, priceTetri: x.price, price: formatGel(x.price), oldPrice: x.oldPrice === null ? null : formatGel(x.oldPrice) })) };
  }));

  server.registerTool("glovo_session_status", {
    description: "Whether the Glovo browser profile is logged in, and the account name if so.",
    inputSchema: {},
  }, guarded(async () => {
    const session = await deps.glovoSession();
    try {
      const auth = await session.getAuth();
      if (!auth) return { loggedIn: false, hint: "Run `bun run login` in the project folder." };
      const me = await new GlovoApi(session).me();
      return { loggedIn: true, name: me.name, deliveredOrders: me.deliveredOrdersCount, city: me.preferredCityCode };
    } catch (e) {
      if (e instanceof GlovoApiError && e.kind === "needs_login") return { loggedIn: false, hint: "Run `bun run login` in the project folder." };
      throw e;
    } finally {
      await session.close();
    }
  }));

  server.registerTool("pantry_list", { description: "Everything believed to be in the kitchen.", inputSchema: {} }, guarded(() => pantry.list()));
  server.registerTool("pantry_set", {
    description: "Set the exact quantity of an ingredient.",
    inputSchema: { ingredient: z.string().min(1), qty: z.number().min(0), unit: z.string().min(1) },
  }, guarded(({ ingredient, qty, unit }) => { pantry.set(ingredient, qty, unit); return pantry.get(ingredient); }));
  server.registerTool("pantry_adjust", {
    description: "Add or subtract a quantity (negative delta subtracts). Units convert between g/kg and ml/l.",
    inputSchema: { ingredient: z.string().min(1), delta: z.number(), unit: z.string().min(1) },
  }, guarded(({ ingredient, delta, unit }) => pantry.adjust(ingredient, delta, unit)));

  server.registerTool("meals_recent", {
    description: "Meals planned or cooked in the last N days, for variety and pantry reasoning.",
    inputSchema: { days: z.number().int().min(1).max(60).default(14) },
  }, guarded(({ days }) => meals.recent(days)));
  server.registerTool("meals_plan_save", {
    description: "Save a set of planned meals with their ingredients.",
    inputSchema: { meals: z.array(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slot: SLOT, title: z.string().min(1), notes: z.string().nullable().default(null),
      ingredients: z.array(z.object({ ingredient: z.string().min(1), qty: z.number().positive(), unit: z.string().min(1) })),
    })).min(1) },
  }, guarded(({ meals: m }) => ({ ids: meals.savePlan(m) })));
  server.registerTool("meal_mark", {
    description: "Mark a meal cooked or skipped. Cooking decrements the pantry once.",
    inputSchema: { id: z.number().int(), status: z.enum(["planned", "cooked", "skipped"]) },
  }, guarded(({ id, status }) => meals.mark(id, status)));

  server.registerTool("delivery_record", {
    description: "Record a placed Glovo order and add its items to the pantry. priceTetri is the unit price in tetri.",
    inputSchema: { glovoOrderId: z.string().min(1), store: z.string().min(1), placedAt: z.string().optional(), items: z.array(z.object({
      productName: z.string().min(1), qty: z.number().positive(), unit: z.string().min(1), priceTetri: z.number().int().min(0), ingredient: z.string().optional(),
    })).min(1) },
  }, guarded((input) => { const r = deliveries.record(input); return { ...r, total: formatGel(r.total) }; }));
  server.registerTool("deliveries_recent", { description: "Recent recorded deliveries.", inputSchema: { limit: z.number().int().min(1).max(50).default(10) } },
    guarded(({ limit }) => deliveries.recent(limit).map((d) => ({ ...d, total: formatGel(d.total) }))));

  server.registerTool("note_add", { description: "Save a free-form observation, e.g. 'chicken was bad'.", inputSchema: { text: z.string().min(1) } },
    guarded(({ text }) => ({ id: notes.add(text) })));
  server.registerTool("notes_recent", { description: "Recent notes, newest first.", inputSchema: { limit: z.number().int().min(1).max(100).default(20) } },
    guarded(({ limit }) => notes.recent(limit)));

  server.registerTool("price_basket", {
    description: "Apply the store split rule to a basket given per-store quotes (tetri) and store fees. Returns one or two proposed carts.",
    inputSchema: {
      basket: z.array(z.object({ key: z.string(), name: z.string(), qty: z.number().positive(), category: CATEGORY })).min(1),
      quotes: z.array(z.object({ itemKey: z.string(), store: z.string(), unitPrice: z.number().int().min(0), source: z.enum(["glovo", "dazoge"]) })),
      stores: z.array(z.object({ store: z.string(), deliveryFee: z.number().int().min(0), minOrder: z.number().int().min(0) })).min(1),
      marginTetri: z.number().int().min(0).default(DEFAULT_SPLIT_CONFIG.marginTetri),
      protectedCategories: z.array(CATEGORY).default(DEFAULT_SPLIT_CONFIG.protectedCategories),
      anchorStore: z.string().default(DEFAULT_SPLIT_CONFIG.anchorStore),
    },
  }, guarded(({ basket, quotes, stores, marginTetri, protectedCategories, anchorStore }) => {
    const d = decideSplit(basket, quotes, stores, { marginTetri, protectedCategories: protectedCategories as Category[], anchorStore });
    return { carts: d.carts.map(fmtCart), anchorOnlyTotal: formatGel(d.anchorOnlyTotal), savings: formatGel(d.savings), unpriced: d.unpriced, reason: d.reason };
  }));

  return server;
}
```

- [ ] **Step 4: Write data/preferences.md**

```markdown
# Grocery preferences

## Household
- One person, Tbilisi. Three meals a day.

## Diet
- High protein, meat or fish every day.
- Dairy is fine.
- Low or no sugar. No sweets, juices or sugary snacks in the plan.
- Processed food is acceptable occasionally, not as a default.
- No allergies or hard restrictions.

## Cooking
- 45 to 60 minutes a day is fine. Multi-step recipes and variety welcome.
- Batch cooking is welcome when it reduces waste.

## Stores
- Anchor store: agrohub. Protected categories always bought there: meat, fish, fruit.
- Split into a second store only when savings after both delivery fees exceed 10 GEL.
- Never more than two orders per shop.

## Rhythm
- Two deliveries a week, each covering 3 to 4 days.

## Dislikes and notes
- (add items here as they come up)

## Favourite dishes
- (add dishes here as they come up)
```

- [ ] **Step 5: Write README.md**

```markdown
# grocery-mcp

MCP server that helps plan meals and shop on Glovo in Tbilisi, with Dazoge price comparison.

## Setup
1. `bun install && bunx playwright install chromium`
2. `bun run login` — a browser window opens; sign in to Glovo with Google once. The session is stored in `data/browser-profile/` (git-ignored).
3. Claude Code picks up `.mcp.json` from this folder automatically.

## Discovery (one-time, needed before Plan 2)
`bun run discover` and follow `docs/glovo-discovery.md`.

## Tests
`bun test` — never touches live Glovo. Dazoge calls use recorded fixtures.

## Environment
- `GROCERY_DRY_RUN=1` stops any future checkout one step before payment.
- `GROCERY_DATA_DIR`, `GROCERY_DB_PATH` override storage locations.
```

- [ ] **Step 6: Run everything**

Run: `bun run typecheck && bun test`
Expected: all pass. Then start the server manually once to confirm stdio boot: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' | timeout 5 bun run src/server.ts | head -c 400` and expect a JSON `result` with `serverInfo.name` = `grocery-mcp`.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts tests README.md data/preferences.md
git commit -m "feat: register planner, Dazoge, Glovo status and pricing tools; preferences template"
```

---

### Task 9: Discovery run (orchestrator with the user)

**Effort:** orchestrator + user, no subagent

**Files:**
- Create: `docs/glovo-api.md`
- Create (curated, redacted): `tests/fixtures/glovo/*.json`

- [ ] **Step 1: User logs in**

User runs in the project folder: `bun run login`. Expected console line: `Logged in as <name> (<n> delivered orders)`.

- [ ] **Step 2: User records**

User runs `bun run discover` and follows `docs/glovo-discovery.md`, then presses Enter. Expected: `SUMMARY.txt` in `data/discovery/<timestamp>/`.

- [ ] **Step 3: Orchestrator analyses**

Read `SUMMARY.txt` and the recordings. For each of history, order detail, store list, store catalog, search, product detail, add to cart, cart view, checkout page: identify the endpoint, method, required query parameters, and the response shape. Decide the barcode question from `ID-KEYS` flags and by inspecting a product payload.

- [ ] **Step 4: Curate fixtures**

Copy one representative recording per endpoint into `tests/fixtures/glovo/`, re-run `redact()` over it via `bun -e` to be safe, and read every file before committing to confirm no address, phone, email or token survives.

- [ ] **Step 5: Write docs/glovo-api.md**

Document each endpoint with: method, path template, parameters, headers beyond `GLOVO_HEADERS`, response shape (only the fields we use), the barcode answer, and the store list with Glovo store ids mapped to `StoreSlug`.

- [ ] **Step 6: Commit and hand off to Plan 2**

```bash
git add docs/glovo-api.md tests/fixtures/glovo
git commit -m "docs: Glovo API discovery results and curated fixtures"
```

Plan 2 (Glovo reads, cart, checkout) is written from `docs/glovo-api.md`.

---

## Self-review notes

- Spec coverage: sections 5.1, 5.2 partial (`me` only, the rest depends on discovery), 5.4, 6, 7, 8.1, 8.2, 9 partial, 10 are covered. 5.3 (writes), 8.3 loop (done by Claude at runtime with these tools), 8.4 reminders are deliberately deferred to Plan 2 and Plan 3.
- Type consistency: `MealsRepo` takes `(db, pantry)` everywhere it is constructed. `StoreSlug` is only used for Dazoge names; the pricing engine uses free-form `store` strings so Glovo store ids can be mapped later without a type change.
- Review Focus items 1 and 4 are pinned in Task 5, item 2 in Task 3, item 3 in Task 2, item 5 in Task 7 and surfaced through the server in Task 8.
