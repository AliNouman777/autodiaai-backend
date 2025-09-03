import { Types } from "mongoose";
import type { Request } from "express";

export type OwnerFilter =
  | { userId: Types.ObjectId; ownerAnonId?: never }
  | { ownerAnonId: string; userId?: never };

export function getOwnerFilter(req: Request): OwnerFilter {
  const userId = (req as any).user?.id as string | undefined;
  if (userId) return { userId: new Types.ObjectId(userId) };
  const aid = req.signedCookies?.aid as string | undefined;
  if (!aid) throw Object.assign(new Error("Missing anon id"), { status: 401, code: "MISSING_AID" });
  return { ownerAnonId: aid };
}
