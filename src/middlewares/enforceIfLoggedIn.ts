// src/middlewares/enforceIfLoggedIn.ts
import type { Request, Response, NextFunction } from "express";
import { enforceDiagramQuota } from "./enforceDiagramQuota";

/** Runs enforceDiagramQuota only for authenticated users; guests pass through. */
export function enforceIfLoggedIn(req: Request, res: Response, next: NextFunction) {
  const auth = (req as any).user || (req as any).auth;
 
  if (auth?.id) {
    return enforceDiagramQuota(req, res, next);
  }
  return next(); // guest → allow (your guest cap can be separate)
}
