import { test, expect } from "bun:test";
import { formatGel, parseGel } from "../src/money";

test("formatGel renders tetri as GEL with two decimals", () => {
  expect(formatGel(399)).toBe("3.99 GEL");
  expect(formatGel(1000)).toBe("10.00 GEL");
  expect(formatGel(5)).toBe("0.05 GEL");
});

test("parseGel reads decimal strings into integer tetri without float drift", () => {
  expect(parseGel("4.99")).toBe(499);
  expect(parseGel("4.99₾")).toBe(499);
  expect(parseGel("10")).toBe(1000);
  expect(parseGel(" 0.1 ")).toBe(10);
});

test("parseGel rejects garbage", () => {
  expect(() => parseGel("abc")).toThrow();
});
