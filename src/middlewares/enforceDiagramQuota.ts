// src/middleware/enforceDiagramQuota.ts
import type { Request, Response, NextFunction } from "express";
import { countUserDiagrams } from "../utils/diagramUsage";

export async function enforceDiagramQuota(req: Request, res: Response, next: NextFunction) {
  const auth = (req as any).user || (req as any).auth;
  if (!auth?.id) return res.status(401).json({ success: false, error: "Unauthorized" });

  const plan: "free" | "pro" = auth.plan || "free";
  if (plan !== "free") return next();

  const used = await countUserDiagrams(auth.id);

  if (used >= 10) {
    return res.status(403).json({
      success: false,
      error: "Free plan limit reached. Upgrade to create more diagrams.",
      meta: { used, limit: 10 },
    });
  }

  next();
}
