// src/controllers/auth.controller.ts
import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { UserModel } from "../models/user.model";
import { ok, fail } from "../utils/http";
import { clearAuthCookies } from "../utils/cookies";
import { completeAuth } from "../utils/completeAuth";


export async function register(req: Request, res: Response) {
  const { firstName, lastName, password } = req.body as {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  };

  const email = (req.body.email || "").trim().toLowerCase();
  const exists = await UserModel.findOne({ email });
  if (exists) return res.status(409).json(fail("Email already registered", "EMAIL_TAKEN"));

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const user = await UserModel.create({
      firstName,
      lastName,
      email,
      passwordHash,
      plan: "free",
    });

    const result = await completeAuth(req, res, {
      id: user.id,
      email: user.email,
      plan: user.plan as "free" | "pro",
    });

    return res.status(201).json(
      ok({
        user: result.user,
        tokens: { access: result.access, refresh: result.refresh },
        usage: result.usage,
      }),
    );
  } catch (err: any) {
    if (err && err.code === 11000) {
      return res.status(409).json(fail("Email already registered", "EMAIL_TAKEN"));
    }
    throw err;
  }
}

export async function login(req: Request, res: Response) {
  const email = (req.body.email || "").trim().toLowerCase();
  const { password } = req.body as { email: string; password: string };

  const user = await UserModel.findOne({ email }).select("+passwordHash");
  if (!user || !user.passwordHash) {
    return res.status(401).json(fail("Invalid credentials", "BAD_LOGIN"));
  }
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json(fail("Invalid credentials", "BAD_LOGIN"));

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const result = await completeAuth(req, res, {
    id: user.id,
    email: user.email,
    plan: user.plan as "free" | "pro",
  });

  return res.json(
    ok({
      user: result.user,
      tokens: { access: result.access, refresh: result.refresh },
      usage: result.usage,
    }),
  );
}

export async function me(req: Request, res: Response) {
  if (!req.user) return res.status(401).json(fail("Unauthorized", "UNAUTHORIZED"));

  // Reuse completeAuth semantics but without merge/DB hit?
  // Here, just refresh the access token cheaply:
  const { id, email, plan } = req.user as { id: string; email: string; plan: "free" | "pro" };
  // If you want live usage in /me as well, call completeAuth and return result. Otherwise keep it light.

  return res.json(ok({ user: { id, email, plan } }));
}

export async function logout(_req: Request, res: Response) {
  clearAuthCookies(res);
  return res.json(ok({ message: "Logged out" }));
}
