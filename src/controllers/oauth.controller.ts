import type { Request, Response } from "express";
import type { SignOptions } from "jsonwebtoken";
import { signJwt } from "../utils/jwt";
import { setAuthCookies } from "../utils/cookies";
import { mergeGuestDiagramsToUser } from "../utils/guest-merge";
import logger from "../libs/logger";

const ACCESS_EXPIRES: SignOptions["expiresIn"] =
  (process.env.JWT_ACCESS_EXPIRES as SignOptions["expiresIn"]) || "15m";
const REFRESH_EXPIRES: SignOptions["expiresIn"] =
  (process.env.JWT_REFRESH_EXPIRES as SignOptions["expiresIn"]) || "7d";


function resolveSafeRedirect(frontendUrl: string, candidate?: string): string {
  try {
    if (!candidate) return new URL("/diagram", frontendUrl).toString();
    if (candidate.startsWith("/") && !candidate.startsWith("//")) {
      return new URL(candidate, frontendUrl).toString();
    }
  } catch {}
  return new URL("/diagram", frontendUrl).toString();
}

export async function finalizeGoogleCallback(req: Request, res: Response) {
  const u = req.user as { id: string; email: string; plan?: "free" | "pro" };
  if (!u) {
    return res.redirect(303, new URL("/auth/google/failure", process.env.FRONTEND_URL).toString());
  }

  const accessSecret = process.env.JWT_ACCESS_SECRET || "dev-access-secret";
  const refreshSecret = process.env.JWT_REFRESH_SECRET || "dev-refresh-secret";

  const access = signJwt({ id: u.id, email: u.email, plan: u.plan }, accessSecret, {
    expiresIn: ACCESS_EXPIRES,
  });

  const refresh = signJwt({ id: u.id }, refreshSecret, { expiresIn: REFRESH_EXPIRES });

  setAuthCookies(res, access, refresh);

  // Merge guest diagrams (parity with email/password flows)
  try {
    const aid = (req as any).signedCookies?.aid as string | undefined;
    if (aid) {
      await mergeGuestDiagramsToUser(aid, u.id, u.plan || "free");
      res.clearCookie("aid", { path: "/" });
    }
  } catch (e) {
    logger.error({ err: e }, "[oauth] mergeGuestDiagramsToUser failed");
  }

  const nextParam = typeof req.query.state === "string" ? req.query.state : undefined;
  const target = resolveSafeRedirect(process.env.FRONTEND_URL || "", nextParam);
  return res.redirect(303, target);
}

export function oauthFailure(_req: Request, res: Response) {
  return res.status(401).json({ success: false, error: "Google sign-in failed" });
}
