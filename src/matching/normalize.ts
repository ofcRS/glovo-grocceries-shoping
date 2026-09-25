export interface NormalizedName { tokens: string[]; volumeMl: number | null; weightG: number | null; percent: number | null }

/**
 * Latin spellings seen on Glovo mapped to the Georgian spelling Dazoge uses.
 * Brands first, then generic food words. Extend as mismatches appear; every
 * entry maps a Latin token to a single canonical Georgian token.
 */
const ALIASES: Record<string, string> = {
  // brands
  sante: "სანტე",
  natakhtari: "ნატახტარი",
  sopeli: "სოფელი",
  nikora: "ნიკორა",
  koda: "კოდა",
  barambo: "ბარამბო",
  zedazeni: "ზედაზენი",
  // generic words
  milk: "რძე", молоко: "რძე",
  cheese: "ყველი", сыр: "ყველი",
  eggs: "კვერცხი", egg: "კვერცხი", яйца: "კვერცხი",
  chicken: "ქათამი", курица: "ქათამი",
  beef: "საქონლის", говядина: "საქონლის",
  pork: "ღორის", свинина: "ღორის",
  butter: "კარაქი", масло: "კარაქი",
  yogurt: "იოგურტი", yoghurt: "იოგურტი", йогурт: "იოგურტი",
  rice: "ბრინჯი", рис: "ბრინჯი",
  bread: "პური", хлеб: "პური",
  water: "წყალი", вода: "წყალი",
};

const STOP = new Set(["და", "the", "and", "with", "of", "ml", "l", "g", "kg", "gr", "ლ", "მლ", "გ", "გრ", "კგ", "ც", "x"]);

// `\b` is ASCII-only in JS, so Georgian units need an explicit "not followed by a letter" guard.
const NUM = "(\\d+(?:[.,]\\d+)?)";
const VOLUME_RE = new RegExp(`${NUM}\\s*(მლ|ml|ლ|l|lt|litre|liter)(?!\\p{L})`, "iu");
const WEIGHT_RE = new RegExp(`${NUM}\\s*(კგ|kg|გრ|გ|g|gr)(?!\\p{L})`, "iu");
const PERCENT_RE = new RegExp(`${NUM}\\s*%`, "u");

const num = (s: string) => Number(s.replace(",", "."));

export function normalizeName(raw: string): NormalizedName {
  let s = raw.toLowerCase();

  let percent: number | null = null;
  const pm = s.match(PERCENT_RE);
  if (pm && pm[1]) { percent = num(pm[1]); s = s.replace(pm[0], " "); }

  let volumeMl: number | null = null;
  const vm = s.match(VOLUME_RE);
  if (vm && vm[1] && vm[2]) {
    const n = num(vm[1]);
    volumeMl = /^(მლ|ml)$/i.test(vm[2]) ? Math.round(n) : Math.round(n * 1000);
    s = s.replace(vm[0], " ");
  }

  let weightG: number | null = null;
  const wm = s.match(WEIGHT_RE);
  if (wm && wm[1] && wm[2]) {
    const n = num(wm[1]);
    weightG = /^(კგ|kg)$/i.test(wm[2]) ? Math.round(n * 1000) : Math.round(n);
    s = s.replace(wm[0], " ");
  }

  const tokens = s
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOP.has(t))
    .map((t) => ALIASES[t] ?? t);

  return { tokens, volumeMl, weightG, percent };
}
