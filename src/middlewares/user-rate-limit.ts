import { NextFunction, Request, Response } from "express";

const buckets = new Map<string, { tokens: number; ts: number }>();
const CAP = 10; // 10 requests
const WINDOW_MS = 60_000; // per minute

export function userRateLimit(req: Request, res: Response, next: NextFunction) {
  const uid = req.user?.id;
  if (!uid)
    return res.status(401).json({ success: false, error: { code: 401, message: "Unauthorized" } });

  const now = Date.now();
  const b = buckets.get(uid) || { tokens: CAP, ts: now };
  const elapsed = now - b.ts;
  const refill = Math.floor(elapsed / WINDOW_MS) * CAP;
  b.tokens = Math.min(CAP, b.tokens + (refill || 0));
  b.ts = refill ? now : b.ts;

  if (b.tokens <= 0)
    return res.status(429).json({ success: false, error: { code: 429, message: "Slow down" } });
  b.tokens -= 1;
  buckets.set(uid, b);
  next();
}
