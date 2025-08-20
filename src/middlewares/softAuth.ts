// src/middlewares/softAuth.ts
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export function softAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined;

    const token =
      (req.cookies?.access as string | undefined) ||
      (req.signedCookies?.access as string | undefined) ||
      bearer;

    if (!token) {
      // no token → just continue as guest
      return next();
    }

    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET || "access") as any;
    (req as any).user = { id: payload.id, email: payload.email, plan: payload.plan };

    return next();
  } catch {
    // invalid/expired token → continue as guest
    return next();
  }
}
