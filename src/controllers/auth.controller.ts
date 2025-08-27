import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import type { SignOptions } from "jsonwebtoken";
import { UserModel } from "../models/user.model";
import { signJwt } from "../utils/jwt";
import { ok, fail } from "../utils/http";
import { clearAuthCookies, setAuthCookies } from "../utils/cookies";
import { mergeGuestDiagramsToUser } from "../utils/guest-merge";

function asExpires(
  value: string | undefined,
  fallback: SignOptions["expiresIn"],
): SignOptions["expiresIn"] {
  return value && value.trim() ? (value.trim() as SignOptions["expiresIn"]) : fallback;
}

const ACCESS_EXPIRES: SignOptions["expiresIn"] =
  (process.env.JWT_ACCESS_EXPIRES as SignOptions["expiresIn"]) || "15m";
const REFRESH_EXPIRES: SignOptions["expiresIn"] =
  (process.env.JWT_REFRESH_EXPIRES as SignOptions["expiresIn"]) || "7d";

export async function register(req: Request, res: Response) {
  const { firstName, lastName, password } = req.body as {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  };

  // ✅ normalize email the same way as the schema
  const email = (req.body.email || "").trim().toLowerCase();

  // Pre-check for nicer UX (still keep DB-level catch for races)
  const exists = await UserModel.findOne({ email });
  if (exists) return res.status(409).json(fail("Email already registered", "EMAIL_TAKEN"));

  const hashed = await bcrypt.hash(password, 10);

  try {
    const user = await UserModel.create({
      firstName,
      lastName,
      email, // ✅ stored lowercased
      passwordHash: hashed,
      plan: "free",
    });

    const access = signJwt(
      { id: user.id, email: user.email, plan: user.plan },
      process.env.JWT_ACCESS_SECRET || "access",
      { expiresIn: asExpires(process.env.JWT_ACCESS_EXPIRES, ACCESS_EXPIRES) },
    );

    const refresh = signJwt({ id: user.id }, process.env.JWT_REFRESH_SECRET || "refresh", {
      expiresIn: asExpires(process.env.JWT_REFRESH_EXPIRES, REFRESH_EXPIRES),
    });

    setAuthCookies(res, access, refresh);

    try {
      const aid = req.signedCookies?.aid as string | undefined;
      if (aid) {
        await mergeGuestDiagramsToUser(aid, user.id, user.plan as "free" | "pro");
        res.clearCookie("aid", { path: "/" });
      }
    } catch {
      /* best-effort */
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
  } catch (err: any) {
    // ✅ defend against race between findOne and create
    if (err && err.code === 11000) {
      return res.status(409).json(fail("Email already registered", "EMAIL_TAKEN"));
    }
    throw err;
  }
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as { email: string; password: string };

  const user = await UserModel.findOne({ email }).select("+passwordHash");
  if (!user || !user.passwordHash) {
    return res.status(401).json(fail("Invalid credentials", "BAD_LOGIN"));
  }
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json(fail("Invalid credentials", "BAD_LOGIN"));

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const access = signJwt(
    { id: user.id, email: user.email, plan: user.plan },
    process.env.JWT_ACCESS_SECRET || "access",
    { expiresIn: ACCESS_EXPIRES },
  );

  const refresh = signJwt({ id: user.id }, process.env.JWT_REFRESH_SECRET || "refresh", {
    expiresIn: REFRESH_EXPIRES,
  });

  setAuthCookies(res, access, refresh);

  try {
    const aid = req.signedCookies?.aid as string | undefined;
    if (aid) {
      await mergeGuestDiagramsToUser(aid, user.id, user.plan as "free" | "pro");
      res.clearCookie("aid", { path: "/" });
    }
  } catch {
    // best-effort; ignore merge errors
  }

  return res.json(
    ok({ user: { id: user.id, email: user.email, plan: user.plan }, tokens: { access, refresh } }),
  );
}

export async function me(req: Request, res: Response) {
  if (!req.user) return res.status(401).json(fail("Unauthorized", "UNAUTHORIZED"));

  const newAccess = signJwt(
    { id: req.user.id, email: req.user.email, plan: req.user.plan },
    process.env.JWT_ACCESS_SECRET || "access",
    { expiresIn: ACCESS_EXPIRES },
  );

  setAuthCookies(res, newAccess);
  return res.json(ok({ user: req.user }));
}

export async function logout(_req: Request, res: Response) {
  clearAuthCookies(res);
  return res.json(ok({ message: "Logged out" }));
}
