import { test, expect } from "bun:test";
import { shouldRecord, redact, redactUrl, redactHeaders, redactBody, fixtureName, endpointTemplate } from "../src/glovo/recorder";

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
    product: { id: 7, name: "Milk 1L", price: 3.2 },
    address: { text: "Some Street 9", details: "door 1234", latitude: 41.7, longitude: 44.7, cityCode: "TBI" },
    products: [{ id: 1, name: "Eggs", price: 5.5, description: "Call +995 599 12 34 56 for info" }],
  };
  const out = redact(input);
  expect(out.authorization).toBe("[REDACTED]");
  expect(out.email).toBe("[REDACTED]");
  expect<unknown>(out.phoneNumber).toBe("[REDACTED]"); // typed as the input shape; value is replaced
  expect(out.product.name).toBe("Milk 1L");
  expect(out.address.text).toBe("[REDACTED]");
  expect(out.address.details).toBe("[REDACTED]");
  expect<unknown>(out.address.latitude).toBe("[REDACTED]");
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

test("redact scrubs real phone numbers but leaves dates, ids, barcodes, urls and price ranges intact", () => {
  const input = {
    createdAt: "2026-09-25T10:15:00.000Z",
    updatedAt: "2026-09-25 10:15:00",
    deliveredOn: "25.09.2026",
    ean: "4860001234567",
    image: "https://res.cloudinary.com/glovoapp/w_300/v1612345678/abc.jpg",
    uuid: "123e4567-e89b-12d3-a456-426614174000",
    promo: "Now 12.50 - 15.00 GEL",
    note: "call 599 12 34 56 or 599123456, office +995-322-12-34-56",
  };
  expect(redact(input)).toEqual({ ...input, note: "call [PHONE] or [PHONE], office [PHONE]" });
});

test("redact matches sensitive keys regardless of case or separators and never mutates nested input", () => {
  const input = {
    user: { access_token: "eyJ", Phone_Number: "x", "First-Name": "Nino", EMAIL: "a@b.c", id: 7 },
    items: [{ email: "e" }],
  };
  const before = structuredClone(input);
  expect(redact(input)).toEqual({
    user: { access_token: "[REDACTED]", Phone_Number: "[REDACTED]", "First-Name": "[REDACTED]", EMAIL: "[REDACTED]", id: 7 },
    items: [{ email: "[REDACTED]" }],
  });
  expect(input).toEqual(before);
});

test("redact hides a person's names when the object also carries contact fields", () => {
  const out = redact({
    id: 42, name: "Nino Beridze", username: "nino88", email: "x@y", phoneNumber: { number: "+995599123456" },
    lastOrder: { name: "Milk 1L", price: 3.2 },
  });
  expect(out.name).toBe("[REDACTED]");
  expect(out.username).toBe("[REDACTED]");
  expect(out.id).toBe(42);
  expect(out.lastOrder.name).toBe("Milk 1L"); // nested product has no contact siblings
});

test("text and details redact strings and numbers but keep walking into nested data", () => {
  const out = redact({
    product: { details: { barcode: "4860051001298", description: "Fresh milk 3.2%" }, text: ["Promo", 5] },
    address: { details: "door 1234", cityCode: "TBI" },
  });
  expect(out.product.details).toEqual({ barcode: "4860051001298", description: "Fresh milk 3.2%" });
  expect<unknown>(out.product.text).toEqual(["[REDACTED]", "[REDACTED]"]);
  expect(out.address.details).toBe("[REDACTED]");
  expect(out.address.cityCode).toBe("TBI");
});

test("redact matches sensitive key fragments and bare Georgian mobile numbers, but keeps barcodes and ids", () => {
  const out = redact({
    addressLine1: "Rustaveli Ave 12", streetName: "Rustaveli", postalCode: "0108", courierName: "Giorgi",
    emailAddress: "a@b.c", password: "hunter2", sessionToken: "abc", contactPhone: { number: "599123456" },
    contact: { number: "599123456", intl: "995599123456" },
    item: { id: "1234567890", barcode: "4860051001298", name: "Yogurt", number: 3 },
  });
  expect(out).toEqual({
    addressLine1: "[REDACTED]", streetName: "[REDACTED]", postalCode: "[REDACTED]", courierName: "[REDACTED]",
    emailAddress: "[REDACTED]", password: "[REDACTED]", sessionToken: "[REDACTED]", contactPhone: "[REDACTED]",
    contact: { number: "[PHONE]", intl: "[PHONE]" },
    item: { id: "1234567890", barcode: "4860051001298", name: "Yogurt", number: 3 },
  } as unknown as typeof out);
});

test("redactUrl scrubs sensitive query values and leaves the rest of the url alone", () => {
  expect(redactUrl("https://api.glovoapp.com/v3/feeds?latitude=41.7&longitude=44.7&limit=10"))
    .toBe("https://api.glovoapp.com/v3/feeds?latitude=REDACTED&longitude=REDACTED&limit=10");
  expect(redactUrl("https://api.glovoapp.com/v3/stores/45/content?offset=0")).toBe("https://api.glovoapp.com/v3/stores/45/content?offset=0");
  expect(redactUrl("not a url")).toBe("not a url");
});

// A syntactically JWT-shaped fake: {"alg":"none"}.{"sub":"test"}.fakesignature — never a real token.
const FAKE_JWT = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.fakesignature123";

test("redactHeaders redacts authorization and cookie and keeps glovo-api-version", () => {
  expect(redactHeaders({ authorization: `Bearer ${FAKE_JWT}`, cookie: "glovo_auth_info=abc", "glovo-api-version": "14" }))
    .toEqual({ authorization: "[REDACTED]", cookie: "[REDACTED]", "glovo-api-version": "14" });
});

test("redactHeaders hides session, device, location and token headers but keeps the Glovo protocol headers", () => {
  const out = redactHeaders({
    "glovo-location-city-code": "TBI", "glovo-language-code": "en", "glovo-app-platform": "web",
    "accept-language": "en-US,en;q=0.9", "content-type": "application/json",
    "glovo-dynamic-session-id": "s-1", "glovo-device-urn": "glv:device:1", "glovo-delivery-location-latitude": "41.7",
    "glovo-delivery-location-longitude": "44.8", "x-csrf-token": "t", "x-api-secret": "s", "glovo-perseus-client-id": "c-1",
    "x-debug": FAKE_JWT,
  });
  expect(out).toEqual({
    "glovo-location-city-code": "TBI", "glovo-language-code": "en", "glovo-app-platform": "web",
    "accept-language": "en-US,en;q=0.9", "content-type": "application/json",
    "glovo-dynamic-session-id": "[REDACTED]", "glovo-device-urn": "[REDACTED]", "glovo-delivery-location-latitude": "[REDACTED]",
    "glovo-delivery-location-longitude": "[REDACTED]", "x-csrf-token": "[REDACTED]", "x-api-secret": "[REDACTED]", "glovo-perseus-client-id": "[REDACTED]",
    "x-debug": "[JWT]",
  });
});

test("an object with only a phone is a store, not a person: its name survives while the phone is redacted", () => {
  const out = redact({ name: "Agrohub", phoneNumber: { number: "+995322000000" } });
  expect(out.name).toBe("Agrohub");
  expect<unknown>(out.phoneNumber).toBe("[REDACTED]");
});

test("email, password or a first/last/full name key marks a person, so the name is redacted", () => {
  expect(redact({ name: "Nino", email: "x@y" })).toEqual({ name: "[REDACTED]", email: "[REDACTED]" });
  expect(redact({ name: "Nino", password: "p" })).toEqual({ name: "[REDACTED]", password: "[REDACTED]" });
  expect(redact({ name: "Nino B", lastName: "B" })).toEqual({ name: "[REDACTED]", lastName: "[REDACTED]" });
  expect(redact({ username: "nino88", customerFullName: "Nino B" })).toEqual({ username: "[REDACTED]", customerFullName: "[REDACTED]" });
});

test("courier redaction is limited to courier, courierName and courierPhone, so courier fees survive", () => {
  const out = redact({
    courierFee: 300, courierTip: 100, fees: { courierFeeTetri: 250 },
    courier: { name: "Giorgi", photo: "x.jpg" }, courierName: "Giorgi", courierPhone: "599123456",
  });
  expect(out).toEqual({
    courierFee: 300, courierTip: 100, fees: { courierFeeTetri: 250 },
    courier: "[REDACTED]", courierName: "[REDACTED]", courierPhone: "[REDACTED]",
  } as unknown as typeof out);
});

test("session, device, location and coordinate keys are redacted without catching words that merely contain 'lat'", () => {
  const out = redact({
    sessionId: "s", deviceId: "d", userLocation: { x: 1 }, coordinates: [41.7, 44.8], geoLatitude: 41.7,
    userLat: 41.7, pickup_lng: 44.8, latLng: "41.7,44.8", LNG: 44.8,
    platformFee: 50, relatedProducts: [1], translations: { en: "Milk" }, templateId: 3, chocolate: "dark",
  });
  expect(out).toEqual({
    sessionId: "[REDACTED]", deviceId: "[REDACTED]", userLocation: "[REDACTED]", coordinates: "[REDACTED]", geoLatitude: "[REDACTED]",
    userLat: "[REDACTED]", pickup_lng: "[REDACTED]", latLng: "[REDACTED]", LNG: "[REDACTED]",
    platformFee: 50, relatedProducts: [1], translations: { en: "Milk" }, templateId: 3, chocolate: "dark",
  } as unknown as typeof out);
});

test("payment fields are redacted by exact key, last4/expiry/cvv/iban also by fragment", () => {
  const out = redact({
    paymentMethod: {
      id: 11, type: "CARD", card: { brand: "VISA" }, cardNumber: "4111111111111111", holderName: "NINO B", cardHolder: "NINO B",
      card_holder_name: "NINO B", cardToken: "t", cardLast4: "1111", lastFourDigits: "1111", maskedPan: "411111******1111", cvc: "123",
      expirationDate: "12/30", expiry_date: "12/30", expiration: "12/30",
      last4: "1111", lastFour: "1111", expirationMonth: 12, expiryYear: 2030, cvv: "123", iban: "GE00TB0000000000000000",
      bin: "411111", pan: "4111111111111111",
    },
    binary: "keep", panel: "keep", company: "keep", placeholder: "Search", cardType: "PRODUCT",
  });
  expect(out).toEqual({
    paymentMethod: {
      id: 11, type: "CARD", card: { brand: "VISA" }, cardNumber: "[REDACTED]", holderName: "[REDACTED]", cardHolder: "[REDACTED]",
      card_holder_name: "[REDACTED]", cardToken: "[REDACTED]", cardLast4: "[REDACTED]", lastFourDigits: "[REDACTED]", maskedPan: "[REDACTED]", cvc: "[REDACTED]",
      expirationDate: "[REDACTED]", expiry_date: "[REDACTED]", expiration: "[REDACTED]",
      last4: "[REDACTED]", lastFour: "[REDACTED]", expirationMonth: "[REDACTED]", expiryYear: "[REDACTED]", cvv: "[REDACTED]", iban: "[REDACTED]",
      bin: "[REDACTED]", pan: "[REDACTED]",
    },
    binary: "keep", panel: "keep", company: "keep", placeholder: "Search", cardType: "PRODUCT",
  } as unknown as typeof out);
});

test("JWT-shaped strings are scrubbed anywhere, including under harmless keys and inside longer strings", () => {
  const out = redact({ blob: FAKE_JWT, redirect: `https://glovoapp.com/cb?state=${FAKE_JWT}`, items: [FAKE_JWT], short: "eyJ.not.long" });
  expect(out).toEqual({ blob: "[JWT]", redirect: "https://glovoapp.com/cb?state=[JWT]", items: ["[JWT]"], short: "eyJ.not.long" });
});

test("redactUrl scrubs JWTs in query values under harmless parameter names", () => {
  expect(redactUrl(`https://api.glovoapp.com/v3/cb?state=${FAKE_JWT}&limit=10`))
    .toBe("https://api.glovoapp.com/v3/cb?state=%5BJWT%5D&limit=10");
});

test("redactBody redacts JSON bodies by key and form-encoded bodies per parameter", () => {
  expect(redactBody(JSON.stringify({ email: "a@b.c", query: "milk" }), "application/json")).toEqual({ email: "[REDACTED]", query: "milk" });
  expect(redactBody("phone=599123456&q=milk&access_token=abc&note=call+599+12+34+56", "application/x-www-form-urlencoded; charset=UTF-8"))
    .toBe("phone=REDACTED&q=milk&access_token=REDACTED&note=call+%5BPHONE%5D");
});

test("redactBody replaces any other non-JSON body and passes empty bodies through as null", () => {
  expect(redactBody("<order><phone>599123456</phone></order>", "text/xml")).toBe("[NON-JSON BODY REDACTED]");
  expect(redactBody("free text with a street", "")).toBe("[NON-JSON BODY REDACTED]");
  expect(redactBody(null, "application/json")).toBeNull();
  expect(redactBody("", "application/json")).toBeNull();
});

test("address-like objects redact every string and number leaf except city, country, type, label and id", () => {
  const out = redact({
    deliveryAddress: {
      id: 9, cityCode: "TBI", countryCode: "GE", cityName: "Tbilisi", city: "Tbilisi", country: "Georgia", type: "HOME", label: "Home",
      line1: "Rustaveli Ave 12", line2: "apt 4", entrance: 2, floor: 3, doorCode: "1234", coordinates: { lat: 41.7, lng: 44.8 },
      components: [{ name: "Vake", kind: "district" }], isDefault: true,
    },
    pickupAddress: { id: 3, description: "Agrohub Vake", number: 12 },
    location: { cityCode: "TBI", description: "near the park", position: { x: 41.7 } },
    address: { line1: "Chavchavadze 5", cityCode: "TBI" },
    addressId: 77,
    store: { id: 5, name: "Agrohub" },
  });
  expect(out).toEqual({
    deliveryAddress: {
      id: 9, cityCode: "TBI", countryCode: "GE", cityName: "Tbilisi", city: "Tbilisi", country: "Georgia", type: "HOME", label: "Home",
      line1: "[REDACTED]", line2: "[REDACTED]", entrance: "[REDACTED]", floor: "[REDACTED]", doorCode: "[REDACTED]", coordinates: "[REDACTED]",
      components: [{ name: "[REDACTED]", kind: "[REDACTED]" }], isDefault: true,
    },
    pickupAddress: { id: 3, description: "[REDACTED]", number: "[REDACTED]" },
    location: { cityCode: "TBI", description: "[REDACTED]", position: { x: "[REDACTED]" } },
    address: { line1: "[REDACTED]", cityCode: "TBI" },
    addressId: "[REDACTED]",
    store: { id: 5, name: "Agrohub" },
  } as unknown as typeof out);
});

test("a numeric phone value under a phone key is redacted whole", () => {
  expect(redact({ contactPhone: { number: 599123456 } })).toEqual({ contactPhone: "[REDACTED]" } as never);
});

test("endpointTemplate replaces numeric path segments only", () => {
  expect(endpointTemplate("https://api.glovoapp.com/v3/me")).toBe("/v3/me");
  expect(endpointTemplate("https://api.glovoapp.com/v3/stores/45/addresses/1234/content?offset=0")).toBe("/v3/stores/{id}/addresses/{id}/content");
  expect(endpointTemplate("https://api.glovoapp.com/v4/customers/orders/987")).toBe("/v4/customers/orders/{id}");
});

test("catalog keys containing 'card' survive while exact payment keys are redacted", () => {
  const out = redact({ cards: [{ type: "PRODUCT_CARD", cardId: 5, name: "Milk" }], paymentMethod: { cardNumber: "4111", holderName: "N", last4: "1111" } });
  expect(out).toEqual({
    cards: [{ type: "PRODUCT_CARD", cardId: 5, name: "Milk" }],
    paymentMethod: { cardNumber: "[REDACTED]", holderName: "[REDACTED]", last4: "[REDACTED]" },
  });
});

test("redactHeaders drops HTTP/2 pseudo-headers and redacts the query string of referer and origin", () => {
  const referer = "https://glovoapp.com/ge/en/tbilisi/?lat=41.7123&lng=44.7811&email=a%40b.c&page=2";
  const out = redactHeaders({
    ":method": "GET", ":path": "/v3/feeds?latitude=41.7123&longitude=44.7811", ":authority": "api.glovoapp.com",
    referer, origin: "https://glovoapp.com", "glovo-api-version": "14",
  });
  expect(Object.keys(out).sort()).toEqual(["glovo-api-version", "origin", "referer"]);
  expect(out.referer).toBe(redactUrl(referer));
  expect(out.referer).not.toContain("41.7123");
  expect(out.referer).not.toContain("44.7811");
  expect(out.referer).not.toContain("a%40b.c");
  expect(out.referer).toContain("page=2");
  expect(out.origin).toBe("https://glovoapp.com");
});
