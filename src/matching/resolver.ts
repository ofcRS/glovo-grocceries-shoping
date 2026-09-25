import type { DazogeClient } from "../dazoge/client";
import { normalizeName } from "./normalize";
import { coversTarget, hasConflict, scoreCandidate, THRESHOLDS } from "./score";

export interface CachedMatch { glovoKey: string; dazogeId: string; confidence: number; confirmedAt: string }
export interface MatchCache { get(glovoKey: string): CachedMatch | null; put(m: CachedMatch): void }
export interface GlovoProductLike { key: string; name: string; barcode?: string | null }

/** `conflict`: quantity, percent or count known on both sides and different. `covers`: every Glovo token is in the name. */
export interface MatchCandidate { dazogeId: string; name: string; score: number; conflict: boolean; covers: boolean }

export type MatchResult =
  | { status: "matched"; dazogeId: string; confidence: number; via: "cache" | "barcode" | "name" }
  | { status: "ambiguous"; candidates: MatchCandidate[] }
  | { status: "none" };

const CLEAR_GAP = 0.1;
const EPSILON = 1e-9;

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
    .map((it): MatchCandidate => {
      const n = normalizeName(it.name);
      return { dazogeId: it.id, name: it.name, score: scoreCandidate(target, n), conflict: hasConflict(target, n), covers: coversTarget(target, n) };
    })
    .filter((c) => c.score >= THRESHOLDS.consider)
    .sort((a, b) => b.score - a.score);

  // De-duplicate by id (search returns one row per store).
  const seen = new Set<string>();
  const unique = scored.filter((c) => (seen.has(c.dazogeId) ? false : (seen.add(c.dazogeId), true)));

  if (unique.length === 0) return { status: "none" };
  const top = unique[0]!;
  const runnerUp = unique[1];
  // Auto-accept only a confident, conflict-free candidate that names everything the Glovo product names
  // and leads the runner-up clearly. The epsilon stops floating point turning a 0.1 gap into 0.0999….
  const clearWinner =
    top.score >= THRESHOLDS.accept &&
    !top.conflict &&
    top.covers &&
    (!runnerUp || top.score - runnerUp.score >= CLEAR_GAP - EPSILON);
  if (clearWinner) {
    const confidence = Math.round(top.score * 1000) / 1000;
    deps.cache.put({ glovoKey: p.key, dazogeId: top.dazogeId, confidence, confirmedAt: new Date().toISOString() });
    return { status: "matched", dazogeId: top.dazogeId, confidence, via: "name" };
  }
  return { status: "ambiguous", candidates: unique.slice(0, 5) };
}
