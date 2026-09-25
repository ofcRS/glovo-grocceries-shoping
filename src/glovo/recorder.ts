export interface Recording {
  seq: number; method: string; url: string; status: number;
  /** Request headers after `redactHeaders`. Response headers are never recorded. */
  requestHeaders: Record<string, string>;
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

const REDACTED = "[REDACTED]";
/** Query strings and form bodies percent-encode brackets, so they use a bare marker. */
const QS_REDACTED = "REDACTED";
const NON_JSON_BODY = "[NON-JSON BODY REDACTED]";

/** Keys compare case- and separator-insensitively, so `access_token`, `Phone-Number` and `firstName` all match. */
const normKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The words of a key split on camelCase and separators: `pickup_lng` -> [pickup, lng], `userLat` -> [user, lat]. */
const keyWords = (k: string): string[] => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Exact keys whose whole value (object or array included) is replaced. */
const REDACT_KEYS = new Set([
  "authorization", "cookie", "set-cookie", "accesstoken", "refreshtoken", "token",
  "email", "phone", "phonenumber", "mobile", "placeid", "street",
  "customername", "courier", "couriername", "courierphone",
  "bin", "pan",
].map(normKey));
/** Any key containing one of these, or starting with one of the prefixes, is also replaced whole. */
const SENSITIVE_FRAGMENTS = [
  "email", "phone", "password", "token", "secret", "cookie", "authorization",
  "session", "device", "location", "latitude", "longitude", "coordinates",
  "card", "holder", "last4", "lastfour", "expiration", "expiry", "cvv", "iban",
  "firstname", "lastname", "fullname", "givenname", "familyname", "surname",
];
const SENSITIVE_PREFIXES = ["street", "postal"];
/**
 * `lat`/`lng` match as whole words only: as substrings they would hit `platform`, `translations`, `relatedProducts`
 * and the `glovo-app-platform` header.
 */
const COORD_WORDS = new Set(["lat", "lng", "lon", "latlng", "lnglat"]);
/** Header-only: a pseudonymous per-browser id (e.g. `glovo-perseus-client-id`), the same class as a device id. */
const HEADER_FRAGMENTS = ["clientid"];
/**
 * Generic keys (`text`, `details`): their strings and numbers are replaced, but objects and arrays are walked
 * with normal rules, so `product.details.barcode` survives while personal leaves are caught by their own keys.
 */
const PRIMITIVE_ONLY_KEYS = new Set(["text", "details"]);
/**
 * Address-like keys (`address…`, `…address`, `location`) open an address subtree: every string and number leaf below
 * is replaced except those under these keys, so `deliveryAddress.line1` goes and `deliveryAddress.cityCode` stays.
 */
const ADDRESS_KEEP_KEYS = new Set(["citycode", "countrycode", "cityname", "city", "country", "type", "label", "id"]);
/** City and country codes are never personal; this also keeps the `glovo-location-city-code` header. */
const isGeoCode = (k: string): boolean => k.endsWith("citycode") || k.endsWith("countrycode");
const isAddressKey = (k: string): boolean => k === "location" || k.startsWith("address") || k.endsWith("address");
/**
 * An object describes a person, and so has its `name`/`username` redacted, only when it carries an email, a password
 * or a first/last/full name key. A phone alone does not count: stores have phone numbers too.
 */
const PERSON_SIGNALS = ["email", "password", "firstname", "lastname", "fullname", "givenname", "familyname", "surname"];
const PERSON_NAME_KEYS = new Set(["name", "firstname", "lastname", "fullname", "username"]);
const isPersonSignal = (k: string): boolean => PERSON_SIGNALS.some((f) => k.includes(f));

/** `keep` marks a leaf on the address allow-list; `address` opens an address subtree. */
type Rule = "whole" | "primitive" | "address" | "keep" | null;

function keyRule(key: string): Rule {
  const k = normKey(key);
  if (isGeoCode(k)) return null;
  if (isAddressKey(k)) return "address";
  if (PRIMITIVE_ONLY_KEYS.has(k)) return "primitive";
  if (REDACT_KEYS.has(k)) return "whole";
  if (SENSITIVE_FRAGMENTS.some((f) => k.includes(f)) || SENSITIVE_PREFIXES.some((p) => k.startsWith(p))) return "whole";
  if (keyWords(key).some((w) => COORD_WORDS.has(w))) return "whole";
  return null;
}

/** The rule for a child key, given whether its object is a person and whether it sits inside an address subtree. */
function childRule(key: string, person: boolean, inAddress: boolean): Rule {
  const k = normKey(key);
  const rule: Rule = person && PERSON_NAME_KEYS.has(k) ? "whole" : keyRule(key);
  if (inAddress && rule !== "whole" && (ADDRESS_KEEP_KEYS.has(k) || isGeoCode(k))) return "keep";
  return rule;
}

/**
 * A phone candidate is a digit run with separators that is not glued to an identifier (URL segment, UUID,
 * slug, query value) and not followed by ":" (a time). It only counts as a phone with 9+ digits: dates
 * (8 digits), price ranges and weights stay intact. Redaction happens at record time and the raw body is
 * never kept, so over-redaction is unrecoverable; that is why this errs towards keeping structured values.
 */
const PHONE_RE = /(?<![\w/=][-.]?)\+?\d[\d\s().-]{7,}\d(?![\w/=:])/g;
const MIN_PHONE_DIGITS = 9;
/** A bare Georgian mobile number, with or without the 995 country code. */
const BARE_GE_MOBILE = /^(995)?5\d{8}$/;
/** Three base64url segments with a JSON-object header: a JWT wherever it appears. */
const JWT_RE = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g;

const scrubJwts = (s: string): string => s.replace(JWT_RE, "[JWT]");

function scrubPhones(s: string): string {
  // Digits-only values are ids or barcodes, except the unmistakable shape of a Georgian mobile.
  if (/^\d+$/.test(s)) return BARE_GE_MOBILE.test(s) ? "[PHONE]" : s;
  return s.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= MIN_PHONE_DIGITS ? "[PHONE]" : m));
}

const scrubString = (s: string): string => scrubPhones(scrubJwts(s));

export function redact<T>(value: T): T {
  return walk(value, null, false) as T;
}

function walk(v: unknown, rule: Rule, inAddress: boolean): unknown {
  if (rule === "whole") return REDACTED;
  const addr = inAddress || rule === "address";
  if (v === null || v === undefined) return v;
  const hideLeaf = rule === "primitive" || (addr && rule !== "keep");
  if (typeof v === "string") return hideLeaf ? REDACTED : scrubString(v);
  if (typeof v === "number") return hideLeaf ? REDACTED : v;
  if (typeof v !== "object") return v;
  // Array items are values of the same key, so they inherit its rule; object children use their own keys.
  if (Array.isArray(v)) return v.map((x) => walk(x, rule, addr));
  const entries = Object.entries(v as Record<string, unknown>);
  const person = entries.some(([k]) => isPersonSignal(normKey(k)));
  const out: Record<string, unknown> = {};
  for (const [k, val] of entries) out[k] = walk(val, childRule(k, person, addr), addr);
  return out;
}

/** Redacts parameters by the same key rules as `redact`; `scrub` cleans the values that are kept. */
function redactParams(params: [string, string][], scrub: (s: string) => string): [string, string][] {
  const person = params.some(([k]) => isPersonSignal(normKey(k)));
  return params.map(([k, val]) => [k, childRule(k, person, false) ? QS_REDACTED : scrub(val)]);
}

/** Replace the value of every query parameter whose name is sensitive by the same key rules as `redact`, and any JWT. */
export function redactUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const params = [...u.searchParams];
  // Query values are often ids, so only JWTs are scrubbed here, not phone-shaped digit runs.
  const redacted = redactParams(params, scrubJwts);
  if (redacted.every(([, val], i) => val === params[i]![1])) return url;
  u.search = new URLSearchParams(redacted).toString();
  return u.toString();
}

/**
 * Request headers by the same key rules as `redact` (so `authorization`, `cookie` and anything naming a token, secret,
 * session, device or location goes); the rest, such as `glovo-api-version`, is kept with JWTs and phones scrubbed.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const sensitive = keyRule(k) !== null || HEADER_FRAGMENTS.some((f) => normKey(k).includes(f));
    out[k] = sensitive ? REDACTED : scrubString(v);
  }
  return out;
}

/**
 * A request body as recorded: JSON is parsed and redacted, a form-encoded body is redacted per parameter and kept
 * as a string, anything else is replaced whole because its structure is unknown. Empty bodies become null.
 */
export function redactBody(body: string | null | undefined, contentType: string): unknown {
  if (body === null || body === undefined || body === "") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch {
    if (/application\/x-www-form-urlencoded/i.test(contentType)) {
      return new URLSearchParams(redactParams([...new URLSearchParams(body)], scrubString)).toString();
    }
    return NON_JSON_BODY;
  }
  return redact(parsed);
}

/** The endpoint path with numeric segments generalised: `/v3/stores/45/content` -> `/v3/stores/{id}/content`, `/v3/me` unchanged. */
export function endpointTemplate(url: string): string {
  return new URL(url).pathname.replace(/\/\d+(?=\/|$)/g, "/{id}");
}

export function fixtureName(seq: number, method: string, url: string): string {
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
  return `${String(seq).padStart(3, "0")}-${method.toUpperCase()}-${path}.json`;
}
