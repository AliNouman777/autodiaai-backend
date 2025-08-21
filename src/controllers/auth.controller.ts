// src/controllers/auth.controller.ts
import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { UserModel } from "../models/user.model";
import { signJwt } from "../utils/jwt";
import { ok, fail } from "../utils/http";
import type { SignOptions } from "jsonwebtoken";
import mongoose, { Types } from "mongoose";
import { DiagramModel } from "../models/diagram.model";

const asExpires = (
  value: string | undefined,
  fallback: SignOptions["expiresIn"],
): SignOptions["expiresIn"] =>
  value && value.trim() ? (value.trim() as SignOptions["expiresIn"]) : fallback;

// cookie helpers
const isProd = process.env.NODE_ENV === "production";
const ACCESS_MAX_AGE = 120 * 60 * 1000; // 120 minutes
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function setAuthCookies(res: Response, access: string, refresh?: string) {
  res.cookie("access", access, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_MAX_AGE,
  });
  if (refresh) {
    res.cookie("refresh", refresh, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: REFRESH_MAX_AGE,
    });
  }
}

function clearAuthCookies(res: Response) {
  res.clearCookie("access", { path: "/" });
  res.clearCookie("refresh", { path: "/" });
}

/** --------------------------------------------------------------
 * Merge any guest-owned diagrams (ownerAnonId == aid) into userId.
 * If plan is "free" and user already has 10 diagrams, skip merge entirely.
 * Runs in a transaction. Safe to call even if there’s nothing to merge.
 * -------------------------------------------------------------- */
async function mergeGuestDiagramsToUser(
  aid: string | undefined,
  userId: string,
  plan: "free" | "pro",
) {
  if (!aid) return { merged: 0 };

  if (plan === "free") {
    const current = await DiagramModel.countDocuments({ userId });
    if (current >= 10) return { merged: 0 };
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const res = await DiagramModel.updateMany(
      { ownerAnonId: aid },
      {
        $set: { userId: new Types.ObjectId(userId) },
        $unset: { ownerAnonId: "" },
      },
      { session },
    );

    await session.commitTransaction();
    return { merged: (res as any).modifiedCount ?? 0 };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

export async function register(req: Request, res: Response) {
  const { firstName, lastName, email, password } = req.body as {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  };

  const exists = await UserModel.findOne({ email });
  if (exists) return res.status(409).json(fail("Email already registered", "EMAIL_TAKEN"));

  const hashed = await bcrypt.hash(password, 10);
  const user = await UserModel.create({
    firstName,
    lastName,
    email,
    password: hashed,
    plan: "free",
  });

  const access = signJwt(
    { id: user.id, email: user.email, plan: user.plan },
    process.env.JWT_ACCESS_SECRET || "access",
    { expiresIn: asExpires(process.env.JWT_ACCESS_EXPIRES, "1440m") },
  );

  const refresh = signJwt({ id: user.id }, process.env.JWT_REFRESH_SECRET || "refresh", {
    expiresIn: asExpires(process.env.JWT_REFRESH_EXPIRES, "7d"),
  });

  setAuthCookies(res, access, refresh);

  // merge guest diagrams if allowed by plan
  try {
    const aid = req.signedCookies?.aid as string | undefined;
    if (aid) {
      await mergeGuestDiagramsToUser(aid, user.id, user.plan as "free" | "pro");
      res.clearCookie("aid", { path: "/" });
    }
  } catch (e) {
    console.error("[register] mergeGuestDiagramsToUser failed:", e);
  }

  return res.status(201).json(
    ok({
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        plan: user.plan,
      },
      tokens: { access, refresh },
    }),
  );
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as { email: string; password: string };
  const user = await UserModel.findOne({ email });
  if (!user) return res.status(401).json(fail("Invalid credentials", "BAD_LOGIN"));

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json(fail("Invalid credentials", "BAD_LOGIN"));

  const access = signJwt(
    { id: user.id, email: user.email, plan: user.plan },
    process.env.JWT_ACCESS_SECRET || "access",
    { expiresIn: asExpires(process.env.JWT_ACCESS_EXPIRES, "15m") },
  );
  const refresh = signJwt({ id: user.id }, process.env.JWT_REFRESH_SECRET || "refresh", {
    expiresIn: asExpires(process.env.JWT_REFRESH_EXPIRES, "7d"),
  });

  setAuthCookies(res, access, refresh);

  // merge guest diagrams if allowed by plan
  try {
    const aid = req.signedCookies?.aid as string | undefined;
    if (aid) {
      await mergeGuestDiagramsToUser(aid, user.id, user.plan as "free" | "pro");
      res.clearCookie("aid", { path: "/" });
    }
  } catch (e) {
    console.error("[login] mergeGuestDiagramsToUser failed:", e);
  }

  return res.json(
    ok({
      user: { id: user.id, email: user.email, plan: user.plan },
      tokens: { access, refresh },
    }),
  );
}

export async function me(req: Request, res: Response) {
  if (!req.user) return res.status(401).json(fail("Unauthorized", "UNAUTHORIZED"));

  const newAccess = signJwt(
    { id: req.user.id, email: req.user.email, plan: req.user.plan },
    process.env.JWT_ACCESS_SECRET || "access",
    { expiresIn: asExpires(process.env.JWT_ACCESS_EXPIRES, "120m") },
  );

  setAuthCookies(res, newAccess);
  return res.json(ok({ user: req.user }));
}

export async function logout(_req: Request, res: Response) {
  clearAuthCookies(res);
  return res.json(ok({ message: "Logged out" }));
}
