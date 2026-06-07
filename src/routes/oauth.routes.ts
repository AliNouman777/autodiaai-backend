import { Router } from "express";
import passport, { googleCallback, googleLogin } from "../auth/passport";
import { finalizeGoogleCallback, oauthFailure } from "../controllers/oauth.controller";

// Ensure app.use(passport.initialize()) is called in server.ts BEFORE mounting this router
const router = Router();

router.get("/login", googleLogin);
router.get("/callback", googleCallback, finalizeGoogleCallback);
router.get("/failure", oauthFailure);

export default router;
