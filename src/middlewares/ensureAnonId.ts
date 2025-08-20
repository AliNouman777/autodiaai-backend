// src/middlewares/ensureAnonId.ts
import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";

export function ensureAnonId(req: Request, res: Response, next: NextFunction) {
  // If logged in, skip creating anon id
  if ((req as any).user?.id) return next();

  const hasAid = Boolean(req.signedCookies?.aid);
  if (!hasAid) {
    const aid = randomBytes(16).toString("hex");
    res.cookie("aid", aid, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 180, // 180 days
      path: "/",
    });
    (req as any).signedCookies = { ...(req as any).signedCookies, aid };
  }
  return next();
}
