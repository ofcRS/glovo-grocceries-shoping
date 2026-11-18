# Glovo web API, as observed on 2026-09-25

Source: two recorded sessions of the Glovo web app (`bun run discover` and a scripted walk
of the same checklist), Tbilisi, English UI, one Agrohub store. Every claim below points at a
redacted fixture in `tests/fixtures/glovo/`. Values marked `[REDACTED]` were personal and are
not in the fixtures. Nothing here was placed as an order: the walk stopped at the checkout page.

## Base, headers, auth

- Base URL `https://api.glovoapp.com`.
- Headers the web app sends on every call (fixture `search.json`, `requestHeaders`):

  | header | value |
  |---|---|
  | `authorization` | the access token, no `Bearer` prefix |
  | `glovo-api-version` | `14` |
  | `glovo-app-platform` | `web` |
  | `glovo-app-type` | `customer` |
  | `glovo-app-context` | `web` |
  | `glovo-language-code` | `en` |
  | `glovo-location-city-code` | `TBI` |
  | `glovo-location-country-code` | `GE` |
  | `accept` | `application/json, text/plain, */*` |

  `glovo-device-urn`, `glovo-dynamic-session-id` and the `glovo-perseus-*` headers are
  per-browser identifiers. `/v3/me` answers without them, but the catalog endpoints
  (`/v3/stores/.../search`, `/v1/web/store_wall/...`) answer `503 no available server` to a
  plain `fetch` from Bun until the request carries the browser's full header set: the
  `glovo-*` headers above plus `glovo-app-version`, `glovo-client-info`, `user-agent`, the
  `sec-ch-ua*` / `sec-fetch-*` client hints and the device, dynamic-session and perseus ids.
  With that set (and freshly generated ids) Bun's `fetch` got `200`, and Playwright's
  request context did too. A bisect for the minimal set was inconclusive because the API
  started refusing everything mid-loop, see rate limits below. The profile keeps the real
  ids: cookies `glv_perseus_client` and `glv_perseus_session`, local storage `glv_device`
  and `glv_uuid`; Plan 2 should read and reuse them rather than invent ids.
- Replaying captured browser headers through Playwright's request context (observed
  2026-11): forwarding `accept-encoding` got `zstd` bodies that the context could not decode,
  so JSON came back empty. Drop `accept-encoding`, the HTTP/2 `:` pseudo-headers, `host`,
  `content-length` and `cookie` before replaying. The context sends the profile's cookies
  itself. The store-view endpoints also answered `429` to bursts; one call every 1.2 s held.
- Rate limits: about thirty search requests within a minute, each with a different
  device id, produced `429` on every catalog call afterwards. Cache search results, send one
  stable identity, and space requests out.
- The access token is a JWT that lives about 20 minutes (`expiresIn: 1198`). The web app
  renews it with `POST /oauth/refresh`, body `{"refreshToken": ...}`, response
  `{accessToken, expiresIn, refreshToken, tokenType}` (fixture `oauth-refresh.json`). The
  refresh token rotates on every call. Where the web app keeps the refresh token between page
  loads is not confirmed yet: it is not in the `glovo_auth_info` cookie's `accessToken`
  field and injecting the profile's cookies into a fresh browser did not carry the session,
  so it most likely sits in local storage or IndexedDB of the persistent profile.
  Consequence for Plan 2: keep renewing through the real browser profile (page load
  triggers the refresh), as `GlovoSession.refresh()` already does.

## Identity

- `GET /v3/me` (fixture `me.json`): `id` (customer id, used in basket paths),
  `preferredCityCode: "TBI"`, `deliveredOrdersCount`, `paymentMethod: "CREDIT_CARD"`.
  Name, email and phone are personal and redacted.

## Orders

- `GET /v3/customer/orders-list?offset=0&limit=12` (fixture `orders-list.json`).
  `orders[]` are display cards: `orderId`, `content.title` (store name),
  `content.body[0].data` is one text blob, one line per product in the form
  `"1 x <product name>"`, `layoutType: "INACTIVE_ORDER"` for delivered orders.
  `pagination.next.offset` is a cursor (an order id), not a row count. Only page one was
  recorded, so cursor paging is unverified.
- `GET /v3/customer/orders/{orderId}` (fixture `order-detail.json`): `storeId`,
  `storeAddressId`, `storeName`, `storeSlug` (`agrohubtbi`), `currentStatus.type`
  (`DeliveredStatus`) and `currentStatus.creationTime` (epoch ms), `boughtProducts[]` with
  `name`, `quantity` as a string (`"1x"`), `price` as a display string (`"9,90₾"`),
  `pricingBreakdown.lines[]` (`type`, `description`, `amount` string), and
  `paymentMethodsBreakdown[]`. Order history carries **no barcodes and no product ids**;
  linking past purchases to catalog products goes through names or through the basket at
  order time.

## Stores and catalog

- Groceries is category `4` (web path `/categories/groceries_4`, and `storeCategoryId: 4`
  in every basket call).
- `POST /v1/web/store_wall/category/{categoryId}?moduleId=StoreFeeds&offset=0&limit=50&handlingType=DELIVERY`
  with body `{"filters": [], "previousStoreIds": []}` lists stores (fixture
  `store-wall-category.json`, recorded for category 22 "Shops", page two). Each entry has
  `id` (string), `title`, `slug`, `eta`, `distance`, `deliveryFee`, `availability`. The
  Agrohub identifiers observed everywhere: `storeId 169869`, `storeAddressId 595140`,
  slug `agrohubtbi`. Category 4 page one (fixture `store-wall-groceries.json`, 328 stores in
  total) gives the grocery stores that Dazoge also tracks. Glovo titles are English, so the
  Georgian-name `storeSlug()` helper does not apply; this table is the mapping:

  | Glovo title | Glovo `id` | Glovo slug | delivery fee | Dazoge `StoreSlug` |
  |---|---|---|---|---|
  | Agrohub | 169869 | `agrohubtbi` | 4,49₾ | `agrohub` |
  | Carrefour | 70098 | `1carrefour-tbi` | 1,49₾ | `carrefour` |
  | Nikora Supermarket | 37350 | `nikora-test-tbi` | 2,99₾ | (not on Dazoge) |
  | Europroduct | 95869 | `europroduct-c-tbi` | 3,99₾ | `europroduct` |
  | SPAR | 26609 | `spar-tbi` | 1,99₾ | `spar` |
  | Goodwill | 96349 | `goodwill-1-tbi` | 1,49₾ | `goodwill` |
  | Magniti | 251808 | `magniti-tbi` | 3,99₾ | `magniti` |
  | Gvirila market | 541982 | `gvirila-market-tbi` | 5,99₾ | `gvirila` |
  | Supta Sakhli | 45203 | `clean-house-tbi` | 1,99₾ | `suftasaxli` |
  | Fresco | 168002 | `fresco-tbi` | 2,99₾ | (not on Dazoge) |

  Each store also needs its `storeAddressId` for catalog and basket calls; only Agrohub's
  (595140) is known. It comes from the store page load (`content/main` URL) or the order
  detail, and Plan 2 should record it per store on first use. `2nabiji`, `psp`, `organika`,
  `alubali`, `tursa` and `zghapari` were not on page one.
- `GET /v1/stores/{storeId}/addresses/{storeAddressId}/node/store_fees` (fixture
  `store-fees.json`): `data.ranges[]` with `upperBound` (minimum basket, 55 GEL at Agrohub)
  and `surchargeInfo.amount` (small-basket surcharge, 3.99 GEL). The delivery fee itself
  showed as `4,49₾` on the store card and as `deliveryFeeValue: 4.49` in the checkout
  template analytics.
- `GET /v4/stores/{storeId}/addresses/{storeAddressId}/content/main?nodeType=DEEP_LINK&link=<group-slug>%2F<collection-slug>`
  (fixture `content-main.json`) returns a `GRID_VIEW_LAYOUT`: `data.body[]` sections of
  `type: "GRID"` whose `data.elements[]` are `PRODUCT_TILE`s. Sections load lazily via
  `GET .../content/partial?component=section&id=<sectionId>` (fixture `content-partial.json`).
  The store root (no `link`) was not recorded.
- Product tile (`content-main.json`, `elements[0].data`): `id` (int64), `externalId`,
  `storeProductId`, `name` (Georgian, with brand and size in the name), `price` (GEL as a
  decimal number), `priceInfo.displayText` (`"1,40₾"`), `promotions[]`, `outOfStock`,
  `tracking.isWeightedProduct`.
- `GET /v3/stores/{storeId}/addresses/{storeAddressId}/search?query=<text>&searchId=<uuid v4>`
  (fixture `search.json`): `totalProducts` and `results[0].products[]` with the same
  product fields plus `description` and an optional `promotion { price, priceInfo, title }`.
  Latin `milk` matched Georgian names, so the search is not script-bound.
- `POST /v4/stores/{storeId}/addresses/{storeAddressId}/products/{productId}/view?productExternalId=<externalId>`
  with body `{"editingMode": false, "origin": "OTHER"}` (fixture `product-view.json`) is
  the product sheet; `metadata.product` has the tile fields. It is only needed for detail
  text, not for adding to the basket.

### Product ids and barcodes

- `externalId` at Agrohub is the string `AGH` + the EAN without its leading zero:
  `AGH8076809502443` is EAN `08076809502443`, `AGH4860051001298` is EAN `4860051001298`
  (the Dazoge fixture product). Other stores will use their own prefix; treat the prefix as
  per-store configuration.
- The basket confirms the barcode explicitly: each basket product has `eans: ["..."]`
  (fixture `basket-get.json`). Search and catalog tiles do not carry `eans`.
- The numeric `id` is an int64 above 2^53. `JSON.parse` rounds it
  (`4611686018469291378` becomes `4611686018469291000`). Always use the string forms:
  `ids.id` in basket payloads, or `externalId`. Never send a numeric `id` back.

## Basket

> **Update, observed 2026-11-05 to 2026-11-16 (live use, no new fixtures).**
>
> - Replaying the create call below (`POST /v1/authenticated/customers/{customerId}/baskets`)
>   from Playwright's request context answered `403 Forbidden`. That held with the
>   browser's full header set, a fresh `glovo-request-id`, and `origin`/`referer` added.
>   The same call from inside the page (`fetch` in the page) failed on CORS.
> - The web app's own cart writes now go to `PUT /v2/baskets/{basketId}`, which answered
>   `201`. Its request body has not been recorded yet. Record it, with the recorder attached,
>   before implementing cart writes.
> - The v1 `PUT .../products` and `PATCH .../products/quantity` calls below were not retried.
>   Treat them as unverified.
> - Until the v2 body is recorded, fill carts by driving the store page:
>   1. Search for the product.
>   2. Click the last button on the product tile to add one.
>   3. To lower the quantity, click `Decrease quantity`. At quantity 1 that button is
>      `Remove item` instead.
>   4. Re-read the basket with the `GET` below after every click, so a re-run sets a target
>      quantity instead of adding again.
> - The basket `GET` still works as documented.
> - **Totals.** `basketPrice.total` is the price before promotions; `basketPrice.final` is
>   what checkout charges. Line `price.final` is the discounted line price. Example from a
>   Carrefour basket on 2026-11-16: `total` 134,85 GEL, `final` 123,74 GEL. Show and compare
>   `final`.

Paths use the customer id from `/v3/me`. A basket id looks like
`<customerId>_<storeId>_<uuid>`. Every write returns the full basket and a new
`basketVersion` (uuid), which the next write must send back: it is optimistic concurrency.

- `GET /v1/authenticated/customers/{customerId}/baskets` lists baskets (`[]` when none).
- `GET /v1/authenticated/customers/{customerId}/baskets/stores/{storeId}` returns `204` with
  no body when empty (fixture `basket-get-empty.json`) or the basket (fixture
  `basket-get.json`): `basketId`, `basketVersion`, `products[]` with
  `ids { basketProductId, id, externalId, storeProductId }`, `quantity.items`, `price`
  (`unitaryBasePrice.minor` is tetri), `name`, `eans`, `weight { value, unit }`,
  `availability`, `basketPrice.total.minor` (tetri, before promotions) and
  `basketPrice.final.minor` (tetri, after promotions).
- Create, when the store has no basket yet:
  `POST /v1/authenticated/customers/{customerId}/baskets` (fixture `basket-create.json`)
  body:
  ```json
  {"products":[{"customizations":[],"ids":{"id":"4611686018469291378","externalId":"AGH8076809502443","legacyId":"4611686018469291378","storeProductId":"AGH8076809502443"},"quantity":{"increments":1}}],
   "storeId":169869,"storeAddressId":595140,"storeCategoryId":4,"handlingStrategy":"DELIVERY"}
  ```
- Add a product to an existing basket:
  `PUT /v1/authenticated/customers/{customerId}/baskets/{basketId}/products` (fixture
  `basket-add-existing.json`). The web app sends the whole basket back: `handlingStrategy`,
  `storeId`, `storeAddressId`, `storeCategoryId`, `basketId`, `basketVersion`, `customerId`
  as a string, and `products[]` containing every existing product (with its
  `basketProductId` and price block echoed) plus the new one with `quantity.increments`.
- Change quantity, including removal:
  `PATCH /v1/authenticated/customers/{customerId}/baskets/{basketId}/products/quantity`
  body `{"handlingStrategy":"DELIVERY","basketVersion":"<current>","products":[{"basketProductId":"<id>","quantity":2}]}`
  (fixture `basket-set-quantity.json`). `quantity: 0` removes the line (fixture
  `basket-remove.json`); removing the last line answers `204` and the basket is gone.
- `PATCH .../migrate_baskets?sourceCustomerId=` moves a guest basket after login; not needed.

## Checkout

- `GET /v4/payment_methods?storeAddressId=595140&clientSupports=GooglePay&clientReady=GooglePay&context=checkout`
  (fixture `payment-methods.json`): `data.paymentMethods[]` with `paymentInstrumentId`,
  `type: "CREDIT_CARD"`, `displayAttributes.displayName`, `metadata.lastFourDigits`
  (redacted) and `selected`.
- `POST /v3/checkouts/order/1/template` (fixture `checkout-template.json`) builds the
  checkout page. Request: `checkout.orderDetails` (`categoryId`, `cityCode`,
  `handlingStrategy.type: "DELIVERY"`, `origin: "CHECKOUT"`, `orderType: "STORES"`,
  `storeAddressId`, `storeId`, `basketId`), `checkout.components` (`productList`,
  `deliveryAddress { label, details, latitude, longitude }`, all redacted, and
  `paymentMethod { paymentInstrumentId, type: "CreditCard", creditCard.token }`),
  `sourceScreen: "CART"`. Response: `orderDetails` with `checkoutSessionId`,
  `purchaseTotalCents` (tetri) and `basketVersion`; `components[]`; and
  `analytics.templateReceived` with `deliveryFeeValue`, `minimumBasketSurchargeValue`,
  `totalOrderValue` and `eta`.
- **The order placement call was not recorded.** The checklist stops before "Pay to order",
  and there is no dry-run flag on the real button. Plan 2 must capture it during the first
  genuinely wanted order, with the recorder attached, and only then implement `place_order`.

## Money and text formats

- Catalog and search: `price` is a decimal GEL number (`6.3`) and `priceInfo.displayText`
  the display string (`"6,30₾"`, comma decimal, lari sign after).
- Basket and checkout: `minor` fields are integer tetri; `purchaseTotalCents` is tetri.
- Order history: display strings only (`"9,90₾"`). `parseGel` must accept the comma decimal
  and the `₾` sign.
- Product names are Georgian with brand between slashes and size at the end
  (`რძე 2.5% /სანტე/ 1 ლ`), which is what `normalizeName` was built for.

## Noise to ignore

`/features/query`, `/v1/help_center/chat/*`, `/ratings/v2/*`, `/seo-content/*`,
`/customers/{id}/subscription/status`, `/v3/whats_up`, `/v3/countries/phone_settings`,
`/v3/customers/cities`, `/v3/addresslookup/coordinates`,
`/customer_profile/api/v1/address_book/me/addresses` (personal, never fixture it).

## Session survival after idle

Checked on 2026-09-25: browser closed for 25 minutes, then `GlovoSession.launch` headless.
The `glovo_auth_info` cookie was still in the profile with a token expired by about 10
minutes, one `refresh()` (page load of the home page) produced a fresh 20-minute token, and
`GET /v3/me` answered, all within 2.5 seconds. So the ruling "no refresh attempt when the
cookie is absent" stands: Chromium keeps the cookie across idle, and an absent cookie really
does mean a logged-out profile.
