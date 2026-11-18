export type StoreSlug =
  | "agrohub" | "goodwill" | "carrefour" | "spar" | "europroduct" | "gvirila" | "magniti"
  | "zghapari" | "2nabiji" | "psp" | "organika" | "alubali" | "suftasaxli" | "tursa";

const GEORGIAN_TO_SLUG: Record<string, StoreSlug> = {
  "აგროჰაბი": "agrohub",
  "გუდვილი": "goodwill",
  "კარფური": "carrefour",
  "სპარი": "spar",
  "ევროპროდუქტი": "europroduct",
  "გვირილა": "gvirila",
  "მაგნიტი": "magniti",
  "ზღაპარი": "zghapari",
  "ორი ნაბიჯი": "2nabiji",
  "პსპ": "psp",
  "ორგანიკა": "organika",
  "ალუბალი": "alubali",
  "სუფთა სახლი": "suftasaxli",
  "თურსა": "tursa",
};

export function storeSlug(georgianName: string): StoreSlug | null {
  return GEORGIAN_TO_SLUG[georgianName.trim()] ?? null;
}
