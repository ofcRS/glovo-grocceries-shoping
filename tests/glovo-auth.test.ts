import { test, expect } from "bun:test";
import { parseAuthCookie, isExpiring } from "../src/glovo/auth";

function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS512", kid: "old" })}.${b64(payload)}.signature`;
}

test("parses URL-encoded JSON cookie and reads exp and userId from the JWT", () => {
  const token = jwtWith({ iat: 1700000000, exp: 1700001200, payload: JSON.stringify({ userId: 123456 }) });
  const cookie = encodeURIComponent(JSON.stringify({ accessToken: token }));
  const auth = parseAuthCookie(cookie);
  expect(auth).toEqual({ accessToken: token, expiresAt: 1700001200, userId: 123456 });
});

test("parses a plain (not encoded) JSON cookie too", () => {
  const token = jwtWith({ exp: 100 });
  const auth = parseAuthCookie(JSON.stringify({ accessToken: token }));
  expect(auth?.expiresAt).toBe(100);
  expect(auth?.userId).toBeNull();
});

test("returns null for empty, garbage, or missing accessToken", () => {
  expect(parseAuthCookie("")).toBeNull();
  expect(parseAuthCookie("not json")).toBeNull();
  expect(parseAuthCookie(JSON.stringify({ refreshToken: "x" }))).toBeNull();
  expect(parseAuthCookie(JSON.stringify({ accessToken: "not.a.jwt" }))).toBeNull();
});

test("isExpiring honours skew", () => {
  const auth = { accessToken: "t", expiresAt: 1000, userId: null };
  expect(isExpiring(auth, 900)).toBe(false);     // 100s left, default skew 60
  expect(isExpiring(auth, 950)).toBe(true);      // 50s left
  expect(isExpiring(auth, 1001)).toBe(true);
  expect(isExpiring(auth, 900, 200)).toBe(true);
});
