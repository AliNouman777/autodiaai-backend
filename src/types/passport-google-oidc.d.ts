// src/types/passport-google-oidc.d.ts
declare module "passport-google-oidc" {
  import type { Request } from "express";
  import { Strategy as PassportStrategy } from "passport";

  export interface OIDCProfileName {
    familyName?: string;
    givenName?: string;
    middleName?: string;
  }

  export interface OIDCEmail {
    value: string;
    verified?: boolean;
  }

  export interface OIDCPhoto {
    value: string;
  }

  export interface Profile {
    id: string; // Google subject ("sub")
    displayName?: string;
    name?: OIDCProfileName;
    emails?: OIDCEmail[];
    photos?: OIDCPhoto[];
    provider: "google";
    _json?: unknown;
    [key: string]: unknown;
  }

  export interface StrategyOptions {
    clientID: string;
    clientSecret: string;
    callbackURL: string;
    passReqToCallback?: boolean;
  }

  export type Done = (err: any, user?: any, info?: any) => void;

  // Without req
  export type VerifyFunction = (
    issuer: string,
    profile: Profile,
    done: Done,
  ) => void | Promise<void>;

  // With req
  export type VerifyFunctionWithReq = (
    req: Request,
    issuer: string,
    profile: Profile,
    done: Done,
  ) => void | Promise<void>;

  /**
   * Strategy class compatible with passport.Strategy.
   * It MUST implement authenticate to satisfy @types/passport.
   */
  export class Strategy extends PassportStrategy {
    constructor(options: StrategyOptions, verify: VerifyFunction);
    constructor(
      options: StrategyOptions & { passReqToCallback: true },
      verify: VerifyFunctionWithReq,
    );
    name: string;
    authenticate(req: Request, options?: any): void;
  }

  export { Strategy as default };
}
