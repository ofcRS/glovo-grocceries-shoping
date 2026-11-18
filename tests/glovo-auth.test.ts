import { test, expect } from "bun:test";
import { parseAuthCookie, isExpiring, selectFreshAuth } from "../src/glovo/auth";

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

const cookieFor = (token: string) => encodeURIComponent(JSON.stringify({ accessToken: token }));

test("selectFreshAuth accepts a changed, unexpired token after a rejection", () => {
  const fresh = jwtWith({ exp: 2000 });
  expect(selectFreshAuth(cookieFor(fresh), "rejected-token", 1000)?.accessToken).toBe(fresh);
});

test("selectFreshAuth rejects the same token that was rejected, even if unexpired", () => {
  const tok = jwtWith({ exp: 2000 });
  expect(selectFreshAuth(cookieFor(tok), tok, 1000)).toBeNull();
});

test("selectFreshAuth rejects an expired token", () => {
  expect(selectFreshAuth(cookieFor(jwtWith({ exp: 1000 })), undefined, 1000)).toBeNull(); // exp == now counts as expired
  expect(selectFreshAuth(cookieFor(jwtWith({ exp: 999 })), "other-token", 1000)).toBeNull();
});

test("selectFreshAuth with no stale token accepts any unexpired token", () => {
  const tok = jwtWith({ exp: 1001 });
  expect(selectFreshAuth(cookieFor(tok), undefined, 1000)).toEqual({ accessToken: tok, expiresAt: 1001, userId: null });
});

test("selectFreshAuth returns null for a missing or unparseable cookie", () => {
  expect(selectFreshAuth(undefined, undefined, 0)).toBeNull();
  expect(selectFreshAuth("garbage", undefined, 0)).toBeNull();
});
