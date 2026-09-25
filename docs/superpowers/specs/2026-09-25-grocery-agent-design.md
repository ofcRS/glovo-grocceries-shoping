# Grocery Agent: Glovo bridge + Dazoge pricing + meal planner

Date: 2026-09-25
Status: approved in conversation, awaiting written review

## 1. Purpose

Reduce the mental load of grocery shopping for one person in Tbilisi who orders
through Glovo. The agent proposes meals, turns them into ingredient lists, prices
them across stores, builds Glovo carts, and places the orders after one explicit
confirmation. Agrohub stays the source for raw meat and fruit because of quality;
everything else goes wherever it is cheapest among stores Glovo delivers from.

Success looks like: twice a week the user says "plan the next delivery", answers
one or two questions, says yes to a total, and food arrives. No browsing, no
price hunting, no forgetting what is in the fridge.

## 2. Confirmed requirements

From the user:

- Agent places orders fully, using the saved card, after an explicit yes in chat.
  One confirmation is enough; no per-order spending cap.
- Split a shop across two stores when savings justify a second delivery fee.
- Surface is Claude Code, in the terminal and through the existing Telegram
  channel. No standalone bot.
- Glovo auth via a Playwright-driven dedicated browser profile.
- Two deliveries a week, each covering 3 to 4 days.
- One person, three meals a day. High protein, meat every day. Dairy fine.
  Low or no sugar. Processed food acceptable occasionally. No hard restrictions.
- 45 to 60 minutes of cooking per day is realistic; user enjoys cooking.

Assumptions:

- Runs on the user's Mac. Nothing runs while Claude Code is closed, except a
  later optional scheduled routine.
- Single delivery address, already saved in Glovo.
- Prices in GEL.

## 3. Facts established by probing

- Glovo access tokens live 20 minutes. The browser stays logged in for months
  because it holds a long-lived refresh token and re-mints access tokens on page
  load. A persistent browser profile inherits this behaviour.
- `GET https://api.glovoapp.com/v3/me` works with the access token plus headers
  `glovo-app-platform: web`, `glovo-api-version: 14`,
  `glovo-location-city-code: TBI`, `glovo-language-code: en`.
- Order history, catalog, search, cart and checkout endpoints are not yet
  known. Guessing returned 404. They must be captured from the real web app.
- The price app is spelled Dazoge (dazoge.info). It exposes
  `GET https://www.dazoge.info/api/product/{barcode}.json` returning
  `{name, image_url, volume, href, prices:[{store_name, store_logo, price,
  old_price}]}` with prices in tetri (399 = 3.99 GEL) and Georgian store names.
  Stores seen: Goodwill, Gvirila, Agrohub, Europroduct, Carrefour, Magniti,
  Zghapari, Spar, Fresco, 2 Nabiji, Nikora and others. Search is a
  server-rendered page at `/search?q=`.

## 4. Architecture

```
Claude Code (terminal / Telegram)
        |  MCP over stdio
        v
grocery-mcp  (Bun + TypeScript)
  src/glovo/      Playwright persistent profile, token extraction, API client,
                  page drivers for cart and checkout
  src/dazoge/     product-by-barcode client, search page parser
  src/matching/   Glovo product <-> Dazoge product resolver with cached matches
  src/planner/    pantry, meals, deliveries on SQLite (bun:sqlite)
  src/pricing/    basket costing and store-split decision
  src/tools.ts    MCP tool registrations
  src/server.ts   entry point
data/
  browser-profile/   git-ignored, holds the Glovo login
  grocery.db         git-ignored
  preferences.md     diet rules, protected categories, split margin, dislikes,
                     favourites; read by Claude before every plan
tests/
  fixtures/glovo/    recorded API responses from Phase 0
  fixtures/dazoge/   recorded JSON and HTML
```

Meal-planning intelligence lives in Claude. The server exposes data and actions
only. Each module has one job and a plain TypeScript interface so it can be
tested alone.

## 5. Glovo bridge

### 5.1 Session

- `glovo_login` launches Chromium headed on `data/browser-profile` via
  `chromium.launchPersistentContext`. The user signs in with Google once.
- All other runs use the same profile headless.
- The API client reads the access token from the `glovo_auth_info` cookie in
  the context. On 401 it loads one Glovo page to trigger a refresh, re-reads the
  cookie, and retries once. A second failure returns `needs_login`.
- Requests use the profile's own user agent and modest pacing (at most a few
  requests per second, no parallel bursts).

### 5.2 Reads (API)

Tools, each returning typed JSON:

- `glovo_session_status` -> `{loggedIn, userName, deliveredOrders}`
- `glovo_order_history({limit})` -> orders with store, date, total and line items
- `glovo_stores()` -> grocery stores delivering to the saved address, with
  delivery fee and minimum order
- `glovo_search({storeId, query})` -> products with id, name, price, unit,
  barcode if present, availability
- `glovo_product({storeId, productId})` -> full product detail

### 5.3 Writes (page-driven)

- `glovo_cart_build({storeId, items:[{productId, qty}]})` drives the store page,
  adds items, and returns `{cartId, lines, unavailable, substitutes, deliveryFee,
  total, confirmationCode, expiresAt}`. The confirmation code is random, single
  use, and valid 10 minutes. `unavailable` lists items the store could not add;
  `substitutes` proposes same-store alternatives for each.
- `glovo_checkout({cartId, confirmationCode})` proceeds to payment with the
  saved card. Claude calls it only after the user has said yes to the total.
  With `GROCERY_DRY_RUN=1` it stops one step before the pay action and returns
  what it would have done.
- Every checkout attempt is written to `checkout_log` with cart summary,
  outcome, Glovo order id if any, and screenshot path.
- Any unexpected page state (card confirmation, captcha, address prompt, price
  change dialog) returns `{status:"needs_human", screenshot, reason}` and
  re-launches the profile headed so the user can finish by hand.

### 5.4 Phase 0 discovery

Before any bridge code, a recorded Playwright session on the logged-in profile
captures the requests the web app makes for history, store list, catalog,
search, add-to-cart and checkout up to the pay step. Outputs:

- endpoint list with headers and example responses saved as fixtures
- answer to: do catalog products carry a barcode or EAN?
- list of Glovo grocery stores for the address, mapped to Dazoge store names
- whether Dazoge has a JSON search endpoint

## 6. Dazoge and matching

- `dazoge_prices({barcode})` wraps the product JSON endpoint and converts tetri
  to GEL.
- `dazoge_search({query})` parses the search page HTML into candidates
  `{barcode, name, volume}`. Replaced by JSON if Phase 0 finds one.
- Resolver `match(glovoProduct)`:
  1. If the Glovo product has a barcode, look it up directly.
  2. Otherwise normalise brand, volume and name tokens across Georgian, English
     and Russian, search Dazoge, and score candidates.
  3. Score above the high threshold: accept. Between thresholds: return the
     top candidates for Claude to confirm with the user once. Below: no match.
  4. Cache every accepted match in `product_match` with confidence and date.
- Dazoge decides where to look; Glovo decides how much. The final cart always
  uses the Glovo catalog price in the chosen store. Reports show both numbers.
- Store name mapping Dazoge <-> Glovo lives in a small table seeded in Phase 0.

## 7. Pricing and split rule

Input: ingredient list with quantities, tagged by category.

- Protected categories (default: raw meat, fish, fruit) always go to Agrohub.
- For the remaining items, cost the basket at Agrohub and at each alternative
  store Glovo delivers from, using Glovo prices where matched and Dazoge prices
  as a hint when a Glovo lookup is still pending.
- Choose the single best alternative store. Split only if
  `agrohubCost - altCost > altDeliveryFee + margin`, margin default 10 GEL,
  set in `preferences.md`. Both orders must meet their store minimum.
- Never more than two orders per shop. Items unavailable at the alternative
  store fall back to Agrohub.
- Output: one or two proposed carts with line items, fees, totals, and the
  savings versus Agrohub-only.

## 8. Planner, pantry and meals

### 8.1 Data (SQLite)

- `product(id, store_id, glovo_id, name, barcode, unit, last_price, last_seen)`
- `product_match(product_id, dazoge_barcode, confidence, confirmed_at)`
- `delivery(id, glovo_order_id, store_id, placed_at, total, status)`
- `delivery_item(delivery_id, product_id, qty, price)`
- `meal(id, date, slot, title, notes, status)` slot in breakfast, lunch,
  dinner; status in planned, cooked, skipped
- `meal_ingredient(meal_id, ingredient, qty, unit, product_id nullable)`
- `pantry(ingredient, qty, unit, updated_at)`
- `note(id, created_at, text)` free-form feedback such as "chicken was bad"
- `checkout_log(id, created_at, cart_json, outcome, glovo_order_id, screenshot)`

### 8.2 Tools

- `pantry_list`, `pantry_set({ingredient, qty, unit})`, `pantry_adjust`
- `meals_recent({days})`, `meals_plan_save({meals[]})`,
  `meal_mark({id, status})`
- `delivery_record({glovoOrderId, storeId, items})` also increments pantry
- `note_add({text})`, `notes_recent`
- `preferences_read` returns `data/preferences.md`

### 8.3 Plan loop

1. User: "plan the next delivery".
2. Claude reads preferences, pantry, meals from the last 14 days, notes, and
   recent Glovo history.
3. Claude proposes a 3 to 4 day menu, three meals a day, respecting diet rules
   and variety. User tweaks.
4. Claude derives the ingredient list, subtracts pantry, tags categories.
5. Pricing produces one or two carts. Claude shows totals, savings and any
   unavailable items with substitutes.
6. User says yes. Claude calls checkout for each cart, records deliveries,
   saves the meal plan.
7. During the week: "cooked X", "skipped X", "we are out of eggs" update
   state. Weekly the agent asks a short pantry sanity check.

### 8.4 Reminders (later phase)

A scheduled Claude Code routine on planning days posts "time to plan" to
Telegram. Not part of the first build.

## 9. Error handling

- Expired or missing session: tools return `needs_login`; Claude tells the user
  to run login.
- Unavailable product: cart build reports it with same-store substitutes.
- Dazoge unreachable: pricing uses Glovo prices only and says so in the report.
- Checkout anomaly: `needs_human` with screenshot; visible window opened.
- Store minimum not met: pricing reports it and suggests topping up or
  collapsing to one store.
- Playwright crash or timeout: tool returns a structured error with the step
  name; no retries on write actions, one retry on reads.

## 10. Testing

- Glovo bridge: unit tests against Phase 0 fixtures. No test hits live Glovo.
- Dazoge: tests against recorded JSON and HTML.
- Matching: a labelled set of about 30 real products from order history with
  expected barcodes; assert precision on accepts and that ambiguous cases are
  surfaced rather than guessed.
- Pricing: table-driven tests for the split rule, minimums, and fallbacks.
- Planner: in-memory SQLite, tests for pantry arithmetic and delivery recording.
- Checkout: manual run with `GROCERY_DRY_RUN=1` before the first real order.

## 11. Build phases

0. Discovery spike: capture endpoints and fixtures, answer barcode question,
   map stores. Output is documentation and fixtures, not product code.
1. Glovo reads and Dazoge comparison: session, history, stores, search,
   prices, matching, pricing report. Usable as a "what should I buy where"
   advisor.
2. Planner: database, pantry, meals, preferences, the plan loop without
   ordering.
3. Cart and checkout: page drivers, confirmation flow, dry run, first real
   order.
4. Reminder routine on Telegram.

## 12. Out of scope

- Multiple users or households.
- Stores not on Glovo.
- Recipe database in code; recipes are Claude's job, guided by preferences.
- Nutrition tracking beyond the high-protein rule.
