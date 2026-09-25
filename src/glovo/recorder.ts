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

/** Keys compare case- and separator-insensitively, so `access_token`, `Phone-Number` and `firstName` all match. */
const normKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const REDACT_KEYS = new Set([
  "authorization", "cookie", "set-cookie", "accesstoken", "refreshtoken", "token",
  "email", "phone", "phonenumber", "mobile",
  "text", "details", "latitude", "longitude", "lat", "lng", "placeid", "formattedaddress", "addressline", "street",
  "firstname", "lastname", "fullname", "customername", "courier",
].map(normKey));

/**
 * A phone candidate is a digit run with separators that is not glued to an identifier (URL segment, UUID,
 * slug, query value). It only counts as a phone with 9+ digits: dates (8 digits), price ranges and weights
 * stay intact. Redaction happens at record time and the raw body is never kept, so over-redaction is
 * unrecoverable; that is why this errs towards keeping structured values.
 */
const PHONE_RE = /(?<![\w/=][-.]?)\+?\d[\d\s().-]{7,}\d(?![\w/=])/g;
const MIN_PHONE_DIGITS = 9;

function scrubPhones(s: string): string {
  if (/^\d+$/.test(s)) return s; // a digits-only value is an id or barcode; phone fields are caught by key
  return s.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= MIN_PHONE_DIGITS ? "[PHONE]" : m));
}

export function redact<T>(value: T): T {
  return walk(value, null) as T;
}

function walk(v: unknown, key: string | null): unknown {
  if (key && REDACT_KEYS.has(normKey(key))) return "[REDACTED]";
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return scrubPhones(v);
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
