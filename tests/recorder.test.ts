import { test, expect } from "bun:test";
import { shouldRecord, redact, redactUrl, fixtureName } from "../src/glovo/recorder";

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
