// src/controllers/auth.controller.ts
import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import User from "../models/user.model";
import { signJwt } from "../utils/jwt";
import { ok, fail } from "../utils/http";
import type { SignOptions } from "jsonwebtoken";

const asExpires = (
  value: string | undefined,
  fallback: SignOptions["expiresIn"],
): SignOptions["expiresIn"] =>
  value && value.trim() ? (value.trim() as SignOptions["expiresIn"]) : fallback;

// cookie helpers
const isProd = process.env.NODE_ENV === "production";
const ACCESS_MAX_AGE = 15 * 60 * 1000; // 15 minutes
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

export async function register(req: Request, res: Response) {
  const { firstName, lastName, email, password } = req.body as {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  };

  const exists = await User.findOne({ email });
  if (exists) {
    return res.status(409).json(fail("Email already registered", "EMAIL_TAKEN"));
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({
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

  return res.status(201).json(
    ok({
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        plan: user.plan,
      },
      tokens: { access, refresh }, // optional to return refresh
    }),
  );
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as { email: string; password: string };
  const user = await User.findOne({ email });
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

  // ✅ set cookies on login
  setAuthCookies(res, access, refresh);

  return res.json(
    ok({
      user: { id: user.id, email: user.email, plan: user.plan },
      tokens: { access, refresh }, // ← optional to return
    }),
  );
}

export async function me(req: Request, res: Response) {
  if (!req.user) return res.status(401).json(fail("Unauthorized", "UNAUTHORIZED"));

  // rotate a fresh access token in the cookie
  const newAccess = signJwt(
    { id: req.user.id, email: req.user.email, plan: req.user.plan },
    process.env.JWT_ACCESS_SECRET || "access",
    { expiresIn: asExpires(process.env.JWT_ACCESS_EXPIRES, "15m") },
  );

  setAuthCookies(res, newAccess);
  return res.json(ok({ user: req.user }));
}

export async function logout(_req: Request, res: Response) {
  clearAuthCookies(res);
  return res.json(ok({ message: "Logged out" }));
}
