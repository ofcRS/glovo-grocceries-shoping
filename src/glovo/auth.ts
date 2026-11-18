export interface GlovoAuth {
  accessToken: string;
  /** epoch seconds */
  expiresAt: number;
  userId: number | null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The glovo_auth_info cookie holds JSON, usually URL-encoded: {"accessToken":"<jwt>"} */
export function parseAuthCookie(cookieValue: string): GlovoAuth | null {
  if (!cookieValue) return null;
  let text = cookieValue;
  try { text = decodeURIComponent(cookieValue); } catch { /* keep raw */ }
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const accessToken = (obj as { accessToken?: unknown }).accessToken;
  if (typeof accessToken !== "string") return null;
  const claims = decodeJwtPayload(accessToken);
  if (!claims || typeof claims.exp !== "number") return null;

  let userId: number | null = null;
  if (typeof claims.payload === "string") {
    try {
      const inner = JSON.parse(claims.payload) as { userId?: unknown };
      if (typeof inner.userId === "number") userId = inner.userId;
    } catch { /* ignore */ }
  }
  return { accessToken, expiresAt: claims.exp, userId };
}

export function isExpiring(auth: GlovoAuth, nowSec: number, skewSec = 60): boolean {
  return auth.expiresAt - nowSec <= skewSec;
}

/**
 * Picks the auth to use from a cookie value. Returns null when absent/unparseable,
 * expired (exp <= nowSec), or still equal to `staleToken` (the token the server rejected).
 */
export function selectFreshAuth(cookieValue: string | undefined, staleToken: string | undefined, nowSec: number): GlovoAuth | null {
  if (cookieValue === undefined) return null;
  const auth = parseAuthCookie(cookieValue);
  if (!auth || auth.expiresAt <= nowSec) return null;
  if (staleToken !== undefined && auth.accessToken === staleToken) return null;
  return auth;
}
