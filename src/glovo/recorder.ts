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

const REDACTED = "[REDACTED]";

/** Keys compare case- and separator-insensitively, so `access_token`, `Phone-Number` and `firstName` all match. */
const normKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Exact keys whose whole value (object or array included) is replaced. */
const REDACT_KEYS = new Set([
  "authorization", "cookie", "set-cookie", "accesstoken", "refreshtoken", "token",
  "email", "phone", "phonenumber", "mobile",
  "latitude", "longitude", "lat", "lng", "placeid", "formattedaddress", "addressline", "street",
  "firstname", "lastname", "fullname", "customername", "courier",
].map(normKey));
/** Any key containing one of these, or starting with one of the prefixes, is also replaced whole. */
const SENSITIVE_FRAGMENTS = ["email", "phone", "password", "token", "secret", "cookie", "authorization"];
const SENSITIVE_PREFIXES = ["street", "postal", "courier"];
/**
 * Generic keys (`text`, `details`) and the `address…` family: their strings and numbers are replaced, but
 * objects and arrays are walked, so `product.details.barcode` and `address.cityCode` survive while the
 * personal leaves inside are caught by their own keys.
 */
const PRIMITIVE_ONLY_KEYS = new Set(["text", "details"]);
const PRIMITIVE_ONLY_PREFIX = "address";
/** An object with a sibling key containing one of these describes a person, so its names are redacted too. */
const PERSON_SIGNALS = ["email", "phone", "password"];
const PERSON_NAME_KEYS = new Set(["name", "firstname", "lastname", "fullname", "username"]);

type Rule = "whole" | "primitive" | null;

function keyRule(key: string): Rule {
  const k = normKey(key);
  if (PRIMITIVE_ONLY_KEYS.has(k) || k.startsWith(PRIMITIVE_ONLY_PREFIX)) return "primitive";
  if (REDACT_KEYS.has(k)) return "whole";
  if (SENSITIVE_FRAGMENTS.some((f) => k.includes(f)) || SENSITIVE_PREFIXES.some((p) => k.startsWith(p))) return "whole";
  return null;
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

function scrubPhones(s: string): string {
  // Digits-only values are ids or barcodes, except the unmistakable shape of a Georgian mobile.
  if (/^\d+$/.test(s)) return BARE_GE_MOBILE.test(s) ? "[PHONE]" : s;
  return s.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= MIN_PHONE_DIGITS ? "[PHONE]" : m));
}

export function redact<T>(value: T): T {
  return walk(value, null) as T;
}

function walk(v: unknown, rule: Rule): unknown {
  if (rule === "whole") return REDACTED;
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return rule === "primitive" ? REDACTED : scrubPhones(v);
  if (typeof v === "number") return rule === "primitive" ? REDACTED : v;
  if (typeof v !== "object") return v;
  // Array items are values of the same key, so they inherit its rule; object children use their own keys.
  if (Array.isArray(v)) return v.map((x) => walk(x, rule));
  const entries = Object.entries(v as Record<string, unknown>);
  const person = entries.some(([k]) => PERSON_SIGNALS.some((f) => normKey(k).includes(f)));
  const out: Record<string, unknown> = {};
  for (const [k, val] of entries) out[k] = walk(val, person && PERSON_NAME_KEYS.has(normKey(k)) ? "whole" : keyRule(k));
  return out;
}

/** Replace the value of every query parameter whose name is sensitive by the same key rules as `redact`. */
export function redactUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const params = [...u.searchParams];
  if (!params.some(([k]) => keyRule(k))) return url;
  u.search = new URLSearchParams(params.map(([k, val]) => [k, keyRule(k) ? "REDACTED" : val])).toString();
  return u.toString();
}

export function fixtureName(seq: number, method: string, url: string): string {
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
  return `${String(seq).padStart(3, "0")}-${method.toUpperCase()}-${path}.json`;
}

