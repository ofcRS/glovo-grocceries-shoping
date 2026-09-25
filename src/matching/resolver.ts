import type { DazogeClient } from "../dazoge/client";
import { normalizeName } from "./normalize";
import { scoreCandidate, THRESHOLDS } from "./score";

export interface CachedMatch { glovoKey: string; dazogeId: string; confidence: number; confirmedAt: string }
export interface MatchCache { get(glovoKey: string): CachedMatch | null; put(m: CachedMatch): void }
export interface GlovoProductLike { key: string; name: string; barcode?: string | null }

export type MatchResult =
  | { status: "matched"; dazogeId: string; confidence: number; via: "cache" | "barcode" | "name" }
  | { status: "ambiguous"; candidates: Array<{ dazogeId: string; name: string; score: number }> }
  | { status: "none" };

export class MemoryMatchCache implements MatchCache {
  private m = new Map<string, CachedMatch>();
  get(k: string) { return this.m.get(k) ?? null; }
  put(x: CachedMatch) { this.m.set(x.glovoKey, x); }
}

/** Query Dazoge with the most distinctive tokens: brand alias first, then the rest, max 3. */
function searchQuery(name: string): string {
  const n = normalizeName(name);
  return n.tokens.slice(0, 3).join(" ") || name;
}

export async function resolve(
  p: GlovoProductLike,
  deps: { dazoge: Pick<DazogeClient, "search" | "getProduct">; cache: MatchCache },
): Promise<MatchResult> {
  const cached = deps.cache.get(p.key);
  if (cached) return { status: "matched", dazogeId: cached.dazogeId, confidence: cached.confidence, via: "cache" };

  if (p.barcode) {
    const hit = await deps.dazoge.getProduct(p.barcode);
    if (hit) {
      deps.cache.put({ glovoKey: p.key, dazogeId: hit.id, confidence: 1, confirmedAt: new Date().toISOString() });
      return { status: "matched", dazogeId: hit.id, confidence: 1, via: "barcode" };
    }
  }

  const target = normalizeName(p.name);
  const page = await deps.dazoge.search(searchQuery(p.name));
  const scored = page.items
    .map((it) => ({ dazogeId: it.id, name: it.name, score: scoreCandidate(target, normalizeName(it.name)) }))
    .filter((c) => c.score >= THRESHOLDS.consider)
    .sort((a, b) => b.score - a.score);

  // De-duplicate by id (search returns one row per store).
  const seen = new Set<string>();
  const unique = scored.filter((c) => (seen.has(c.dazogeId) ? false : (seen.add(c.dazogeId), true)));

  if (unique.length === 0) return { status: "none" };
  const top = unique[0]!;
  const runnerUp = unique[1];
  const clearWinner = top.score >= THRESHOLDS.accept && (!runnerUp || top.score - runnerUp.score >= 0.1);
  if (clearWinner) {
    deps.cache.put({ glovoKey: p.key, dazogeId: top.dazogeId, confidence: top.score, confirmedAt: new Date().toISOString() });
    return { status: "matched", dazogeId: top.dazogeId, confidence: top.score, via: "name" };
  }
  return { status: "ambiguous", candidates: unique.slice(0, 5) };
}
