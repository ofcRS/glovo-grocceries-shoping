/** Integer number of tetri. 1 GEL = 100 tetri. */
export type Tetri = number;

export function formatGel(t: Tetri): string {
  const sign = t < 0 ? "-" : "";
  const abs = Math.abs(Math.round(t));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} GEL`;
}

export function parseGel(s: string): Tetri {
  const m = s.trim().match(/^(\d+)(?:[.,](\d{1,2}))?\s*(?:₾|GEL)?$/i);
  if (!m) throw new Error(`Not a GEL amount: ${JSON.stringify(s)}`);
  const whole = Number(m[1]);
  const frac = (m[2] ?? "").padEnd(2, "0");
  return whole * 100 + Number(frac);
}
