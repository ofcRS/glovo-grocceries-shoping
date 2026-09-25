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

// Playwright ignores the handler's promise, so a throw here would be an unhandled rejection: catch everything.
page.on("response", async (res) => {
  try {
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
  } catch (err) {
    console.error(`[skip] ${res.url()}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
