// src/utils/jwt.ts
import jwt, { Secret, SignOptions, JwtPayload } from "jsonwebtoken";

export function signJwt(payload: object, secret: Secret, options?: SignOptions) {
  return jwt.sign(payload, secret, options);
}

export function verifyJwt<T extends object = JwtPayload>(token: string, secret: Secret): T | null {
  try {
    return jwt.verify(token, secret) as T;
  } catch {
    return null;
  }
}
