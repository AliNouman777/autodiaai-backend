// src/utils/completeAuth.ts
import type { Request, Response } from "express";
import type { SignOptions } from "jsonwebtoken";
import { signJwt } from "./jwt";
import { setAuthCookies } from "./cookies";
import { mergeGuestDiagramsToUser } from "./guest-merge";
import logger from "../libs/logger";
import { countUserDiagrams } from "./diagramUsage";

const ACCESS_EXPIRES: SignOptions["expiresIn"] =
  (process.env.JWT_ACCESS_EXPIRES as SignOptions["expiresIn"]) || "15m";
const REFRESH_EXPIRES: SignOptions["expiresIn"] =
  (process.env.JWT_REFRESH_EXPIRES as SignOptions["expiresIn"]) || "7d";

export type MinimalUser = {
  id: string;
  email: string;
  plan?: "free" | "pro";
};

export type CompleteAuthResult = {
  access: string;
  refresh: string;
  usage: { used: number; limit: number | null; remaining: number | null };
  user: { id: string; email: string; plan: "free" | "pro" };
};

/**
 * One place to:
 *  - merge guest diagrams
 *  - compute usage/quota
 *  - sign tokens (with usage hints in access)
 *  - set cookies
 */
export async function completeAuth(
  req: Request,
  res: Response,
  u: MinimalUser,
): Promise<CompleteAuthResult> {
  const accessSecret = process.env.JWT_ACCESS_SECRET || "dev-access-secret";
  const refreshSecret = process.env.JWT_REFRESH_SECRET || "dev-refresh-secret";
  const plan = u.plan || "free";

  // Best-effort merge of guest diagrams
  try {
    const aid = (req as any).signedCookies?.aid as string | undefined;
    if (aid) {
      await mergeGuestDiagramsToUser(aid, u.id, plan);
      res.clearCookie("aid", { path: "/" });
    }
  } catch (e) {
    logger.error({ err: e }, "[auth] mergeGuestDiagramsToUser failed");
  }

  // Compute current usage for quota + UI hints
  const used = await countUserDiagrams(u.id);

  const limit = plan === "free" ? 10 : null;
  const remaining = limit === null ? null : Math.max(0, limit - used);

  const payload = {
    id: u.id,
    email: u.email,
    plan,
    // include usage hints in access token (optional but nice for UI)
    usage: { used, limit, remaining },
  };

  const access = signJwt(payload, accessSecret, { expiresIn: ACCESS_EXPIRES });
  const refresh = signJwt({ id: u.id }, refreshSecret, { expiresIn: REFRESH_EXPIRES });

  setAuthCookies(res, access, refresh);

  return {
    access,
    refresh,
    usage: { used, limit, remaining },
    user: { id: u.id, email: u.email, plan },
  };
}
