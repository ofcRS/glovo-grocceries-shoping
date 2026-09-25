import type { NormalizedName } from "./normalize";

export const THRESHOLDS = { accept: 0.75, consider: 0.4 } as const;

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Compares two quantities: 1 when equal, 0 when one side is missing or they differ. */
function qty(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null; // not applicable
  if (a === null || b === null) return 0;
  if (a === b) return 1; // also covers 0 vs 0 ("0%" fat), which would otherwise divide by zero
  return Math.abs(a - b) / Math.max(a, b) <= 0.05 ? 1 : 0;
}

/** True when quantity, percent or piece count is known on both sides and they differ by more than 5%. */
export function hasConflict(a: NormalizedName, b: NormalizedName): boolean {
  const pairs: Array<[number | null, number | null]> = [
    [a.volumeMl ?? a.weightG, b.volumeMl ?? b.weightG],
    [a.percent, b.percent],
    [a.count, b.count],
  ];
  return pairs.some(([x, y]) => x !== null && y !== null && qty(x, y) === 0);
}

/** True when every target token appears in the candidate; a target with no tokens covers nothing. */
export function coversTarget(target: NormalizedName, candidate: NormalizedName): boolean {
  if (target.tokens.length === 0) return false;
  const have = new Set(candidate.tokens);
  return target.tokens.every((t) => have.has(t));
}

/**
 * Weighted blend: tokens 0.6, quantity (volume or weight) 0.25, percent 0.15.
 * Components that do not apply to either side are dropped and weights renormalised.
 */
export function scoreCandidate(a: NormalizedName, b: NormalizedName): number {
  const parts: Array<[number, number]> = [[jaccard(a.tokens, b.tokens), 0.6]];
  const q = qty(a.volumeMl ?? a.weightG, b.volumeMl ?? b.weightG);
  if (q !== null) parts.push([q, 0.25]);
  const p = qty(a.percent, b.percent);
  if (p !== null) parts.push([p, 0.15]);
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  return parts.reduce((s, [v, w]) => s + v * w, 0) / wsum;
}
