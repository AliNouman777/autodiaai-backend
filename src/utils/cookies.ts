import { Response } from "express";
import { parseDurationToMs } from "./duration";

const ACCESS_DEFAULT = process.env.JWT_ACCESS_EXPIRES || "15m";
const REFRESH_DEFAULT = process.env.JWT_REFRESH_EXPIRES || "7d";

export const ACCESS_MAX_AGE = parseDurationToMs(ACCESS_DEFAULT, 15 * 60 * 1000);
export const REFRESH_MAX_AGE = parseDurationToMs(REFRESH_DEFAULT, 7 * 24 * 60 * 60 * 1000);

const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_SAMESITE = IS_PROD ? "None" : "Lax";
const COOKIE_SECURE = IS_PROD;
const COOKIE_PARTITIONED = IS_PROD;

export function buildCookie({
  name,
  value,
  maxAgeMs,
  deleteCookie = false,
}: {
  name: string;
  value?: string;
  maxAgeMs?: number;
  deleteCookie?: boolean;
}) {
  const parts: string[] = [];
  parts.push(`${name}=${deleteCookie ? "" : (value ?? "")}`);
  parts.push("Path=/");
  parts.push("HttpOnly");
  if (COOKIE_SECURE) parts.push("Secure");
  parts.push(`SameSite=${COOKIE_SAMESITE}`);
  if (COOKIE_PARTITIONED) parts.push("Partitioned");

  if (deleteCookie) {
    parts.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  } else if (typeof maxAgeMs === "number") {
    parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
    parts.push(`Expires=${new Date(Date.now() + maxAgeMs).toUTCString()}`);
  }
  return parts.join("; ");
}

export function appendSetCookie(res: Response, cookieStr: string) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) res.setHeader("Set-Cookie", cookieStr);
  else if (Array.isArray(prev)) res.setHeader("Set-Cookie", [...prev, cookieStr]);
  else res.setHeader("Set-Cookie", [prev as string, cookieStr]);
}

export function setAuthCookies(res: Response, access: string, refresh?: string) {
  appendSetCookie(res, buildCookie({ name: "access", value: access, maxAgeMs: ACCESS_MAX_AGE }));
  if (refresh)
    appendSetCookie(
      res,
      buildCookie({ name: "refresh", value: refresh, maxAgeMs: REFRESH_MAX_AGE }),
    );
}

export function clearAuthCookies(res: Response) {
  appendSetCookie(res, buildCookie({ name: "access", deleteCookie: true }));
  appendSetCookie(res, buildCookie({ name: "refresh", deleteCookie: true }));
}
