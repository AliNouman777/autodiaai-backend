// src/controllers/oauth.controller.ts
import type { Request, Response } from "express";
import { completeAuth } from "../utils/completeAuth";
import { resolveSafeRedirect } from "../utils/redirect";

export async function finalizeGoogleCallback(req: Request, res: Response) {
  const u = req.user as { id: string; email: string; plan?: "free" | "pro" } | undefined;
  if (!u) {
    return res.redirect(303, new URL("/auth/google/failure", process.env.FRONTEND_URL).toString());
  }

  await completeAuth(req, res, u);

  const nextParam = typeof req.query.state === "string" ? req.query.state : undefined;
  const target = resolveSafeRedirect(process.env.FRONTEND_URL || "", nextParam);
  return res.redirect(303, target);
}

export function oauthFailure(_req: Request, res: Response) {
  return res.status(401).json({ success: false, error: "Google sign-in failed" });
}
