import { Request, Response, NextFunction } from "express";
import { verifyJwt } from "../utils/jwt";

export type AuthUser = { id: string; email: string; plan: "free" | "pro" };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  let token = header.startsWith("Bearer ") ? header.slice(7) : null;

  // 👇 cookie fallback
  if (!token && req.cookies?.access) token = req.cookies.access as string;

  if (!token) {
    return res.status(401).json({ success: false, error: { code: 401, message: "Unauthorized" } });
  }

  const payload = verifyJwt<AuthUser>(token, process.env.JWT_ACCESS_SECRET || "access");
  if (!payload) {
    return res.status(401).json({ success: false, error: { code: 401, message: "Invalid token" } });
  }

  req.user = payload;
  next();
}
