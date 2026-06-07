// /src/auth/passport.ts
import passport from "passport";
import { Strategy as GoogleOIDCStrategy } from "passport-google-oidc";
import type { Request, Response, NextFunction } from "express";
import { UserModel } from "../models/user.model";

export type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
  provider: "google";
  providerId: string;
};

// Ask Google for email + profile (names)
const GOOGLE_SCOPES = ["openid", "email", "profile"];

passport.use(
  new GoogleOIDCStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      callbackURL: process.env.GOOGLE_CALLBACK_URL as string, // must match /auth/google/callback
      passReqToCallback: true,
    },
    async (
      _req: Request,
      _issuer: string,
      profile: any,
      done: (err: any, user?: AuthUser | false) => void,
    ) => {
      try {
        const providerId = String(profile?.id ?? "");
        const emailsArr = Array.isArray(profile?.emails) ? profile.emails : [];
        const primary = emailsArr.find((e: any) => e?.verified) ?? emailsArr[0];
        const email: string | null = primary?.value ?? null;
        if (!providerId || !email) return done(null, false);

        const given = (profile?.name?.givenName ?? "").trim() || undefined;
        const family = (profile?.name?.familyName ?? "").trim() || undefined;
        const name = profile?.displayName ?? ([given, family].filter(Boolean).join(" ") || null);

        // Upsert (create or link) user via model logic
        const userDoc = await UserModel.upsertFromGoogle({
          providerId,
          email,
          name,
          emailVerified: true,
        });

        // Backfill first/last if missing and Google provided them
        let updated = false;
        if (given && !userDoc.firstName) {
          userDoc.firstName = given;
          updated = true;
        }
        if (family && !userDoc.lastName) {
          userDoc.lastName = family;
          updated = true;
        }
        if (updated) {
          await userDoc.save({ validateBeforeSave: false });
        }

        const user: AuthUser = {
          id: String(userDoc._id),
          email: userDoc.email,
          name: [userDoc.firstName, userDoc.lastName].filter(Boolean).join(" ") || undefined,
          provider: "google",
          providerId,
        };

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    },
  ),
);

// Kick off Google login
export const googleLogin = (req: Request, res: Response, next: NextFunction) => {
  const state = typeof req.query.next === "string" && req.query.next.trim() ? req.query.next : "/";
  return passport.authenticate("google", {
    scope: GOOGLE_SCOPES,
    session: false,
    state,
  })(req, res, next);
};

// Handle callback (verification only; app logic continues in controller)
export const googleCallback = passport.authenticate("google", {
  session: false,
  failureRedirect: "/auth/google/failure",
});

export default passport;
