export class UnitMismatchError extends Error {
  constructor(from: string, to: string) { super(`Cannot convert ${from} to ${to}`); this.name = "UnitMismatchError"; }
}

const FACTORS: Record<string, { dim: "mass" | "volume"; toBase: number }> = {
  g: { dim: "mass", toBase: 1 }, kg: { dim: "mass", toBase: 1000 },
  ml: { dim: "volume", toBase: 1 }, l: { dim: "volume", toBase: 1000 },
};

export function convertQty(qty: number, from: string, to: string): number {
  const f = from.trim().toLowerCase(), t = to.trim().toLowerCase();
  if (f === t) return qty;
  const a = FACTORS[f], b = FACTORS[t];
  if (!a || !b || a.dim !== b.dim) throw new UnitMismatchError(from, to);
  return (qty * a.toBase) / b.toBase;
}
