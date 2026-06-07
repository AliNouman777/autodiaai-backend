import { NextFunction, Request, Response } from "express";
import {DiagramModel} from "../models/diagram.model";

export async function enforceFreePlanLimit(req: Request, res: Response, next: NextFunction) {
  if (!req.user)
    return res.status(401).json({ success: false, error: { code: 401, message: "Unauthorized" } });
  if (req.user.plan !== "free") return next();

  const count = await DiagramModel.countDocuments({ userId: req.user.id });
  if (count >= 4) {
    return res.status(403).json({
      success: false,
      error: { code: "PLAN_LIMIT_REACHED", message: "Free plan limit reached (max 4 diagrams)." },
    });
  }
  next();
}
