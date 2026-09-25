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
  per-browser identifiers; the API answered our probe in Task 3 without them.
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
  slug `agrohubtbi`. The mapping of other grocery stores to `StoreSlug` is still to be
  taken from a category 4 page one call.
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

Paths use the customer id from `/v3/me`. A basket id looks like
`<customerId>_<storeId>_<uuid>`. Every write returns the full basket and a new
`basketVersion` (uuid), which the next write must send back: it is optimistic concurrency.

- `GET /v1/authenticated/customers/{customerId}/baskets` lists baskets (`[]` when none).
- `GET /v1/authenticated/customers/{customerId}/baskets/stores/{storeId}` returns `204` with
  no body when empty (fixture `basket-get-empty.json`) or the basket (fixture
  `basket-get.json`): `basketId`, `basketVersion`, `products[]` with
  `ids { basketProductId, id, externalId, storeProductId }`, `quantity.items`, `price`
  (`unitaryBasePrice.minor` is tetri), `name`, `eans`, `weight { value, unit }`,
  `availability`, and `basketPrice.total.minor` (tetri).
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

See the "Idle check" note at the end of this file once step 11 has run.
