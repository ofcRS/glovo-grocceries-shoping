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
  return Math.abs(a - b) / Math.max(a, b) <= 0.05 ? 1 : 0;
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
