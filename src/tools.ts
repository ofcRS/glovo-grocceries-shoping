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
  /** fetch used for Glovo API calls; tests inject a fake so nothing reaches live Glovo */
  glovoFetch: typeof fetch;
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

const withGel = <T extends { price: number; oldPrice: number | null }>(x: T) => ({
  ...x, priceTetri: x.price, price: formatGel(x.price), oldPriceTetri: x.oldPrice, oldPrice: x.oldPrice === null ? null : formatGel(x.oldPrice),
});

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
    glovoFetch: overrides.glovoFetch ?? fetch,
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
    return { found: true, id: p.id, name: p.name, volume: p.volume, prices: p.prices.map(withGel) };
  }));

  server.registerTool("dazoge_search", {
    description: "Search Dazoge for products by name (Georgian or Latin). Returns one row per product per store.",
    inputSchema: { query: z.string().min(1), page: z.number().int().min(1).default(1) },
  }, guarded(async ({ query, page }) => {
    const r = await deps.dazoge.search(query, page);
    return { ...r, items: r.items.map(withGel) };
  }));

  server.registerTool("glovo_session_status", {
    description: "Whether the Glovo browser profile is logged in, and the account name if so.",
    inputSchema: {},
  }, guarded(async () => {
    const session = await deps.glovoSession();
    try {
      const auth = await session.getAuth();
      if (!auth) return { loggedIn: false, hint: "Run `bun run login` in the project folder." };
      const me = await new GlovoApi(session, deps.glovoFetch).me();
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
    description: "Add or subtract a quantity (negative delta subtracts). Units convert between g/kg and ml/l; other unit pairs error. " +
      "Quantities floor at zero. Subtracting from an ingredient that is not in the pantry stores nothing and returns stored: false.",
    inputSchema: { ingredient: z.string().min(1), delta: z.number(), unit: z.string().min(1) },
  }, guarded(({ ingredient, delta, unit }) => {
    const row = pantry.adjust(ingredient, delta, unit);
    // subtracting from an ingredient that is not in the pantry stores nothing; say so rather than imply a zero was saved
    return pantry.get(ingredient) ? row : { ...row, stored: false };
  }));

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
    description: "Record a placed Glovo order and add its items to the pantry. priceTetri is the unit price in tetri. " +
      "`ingredient` is the pantry key the item is stored under (use the same short name meals use, e.g. 'milk'); " +
      "when omitted the item is filed under productName and meal ingredients will not match it. " +
      "placedAt is an ISO 8601 datetime with Z or an offset; it defaults to now.",
    inputSchema: { glovoOrderId: z.string().min(1), store: z.string().min(1), placedAt: z.iso.datetime({ offset: true }).optional(), items: z.array(z.object({
      productName: z.string().min(1), qty: z.number().positive(), unit: z.string().min(1), priceTetri: z.number().int().min(0), ingredient: z.string().optional(),
    })).min(1) },
  }, guarded((input) => {
    // stored as UTC so deliveries_recent, which sorts placedAt as text, sorts chronologically
    const placedAt = input.placedAt === undefined ? undefined : new Date(input.placedAt).toISOString();
    const r = deliveries.record({ ...input, placedAt });
    return { ...r, total: formatGel(r.total) };
  }));
  server.registerTool("deliveries_recent", { description: "Recent recorded deliveries.", inputSchema: { limit: z.number().int().min(1).max(50).default(10) } },
    guarded(({ limit }) => deliveries.recent(limit).map((d) => ({ ...d, total: formatGel(d.total) }))));

  server.registerTool("note_add", { description: "Save a free-form observation, e.g. 'chicken was bad'.", inputSchema: { text: z.string().min(1) } },
    guarded(({ text }) => ({ id: notes.add(text) })));
  server.registerTool("notes_recent", { description: "Recent notes, newest first.", inputSchema: { limit: z.number().int().min(1).max(100).default(20) } },
    guarded(({ limit }) => notes.recent(limit)));

  server.registerTool("price_basket", {
    description: "Apply the store split rule to a basket. ALL money fields are integer tetri (1 GEL = 100 tetri): " +
      "quotes.unitPrice, stores.deliveryFee, stores.minOrder, marginTetri. " +
      "Returns one or two proposed carts with GEL-formatted totals and the savings versus buying everything at the anchor store.",
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
