import express from "express";
import session from "express-session";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import api from "./routes";
import { errorHandler } from "./middlewares/error";
import logger from "./libs/logger";
import env from "./config/env";
import cookieParser from "cookie-parser";
import { getLiveness, getReadiness } from "./controllers/health.controller";
import passport from "passport";
import oauthRouter from "./routes/oauth.routes";

export function createServer() {
  const router = express.Router();
  const app = express();

  // Trust proxy (needed for correct IP/HTTPS handling behind proxies)
  app.set("trust proxy", 1);

  // Cookies (signed)
  app.use(cookieParser(process.env.COOKIE_SECRET || "dev-cookie-secret"));

  // Session (needed for OIDC state/nonce during the OAuth handshake)
  app.use(
    session({
      name: "sid",
      secret: process.env.SESSION_SECRET || "dev-session-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 10 * 60 * 1000,
      },
    }),
  );

  // Passport (after session, before routes)
  app.use(passport.initialize());

  // Logging
  app.use(pinoHttp({ logger }));

  // Security headers
  app.use(
    helmet({
      crossOriginOpenerPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // CORS
  const ALLOWED_ORIGINS = (env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Accept"],
      optionsSuccessStatus: 204,
    }),
  );

  // Compression - exclude streaming endpoints
  app.use(
    compression({
      filter: (req, res) => {
        // Don't compress streaming endpoints
        if (req.url?.includes("/stream")) {
          return false;
        }
        // Use default compression filter for other requests
        return compression.filter(req, res);
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Basic rate limit
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // ---------- Health ----------
  router.get("/", getLiveness);
  router.get("/ready", getReadiness);
  app.use("/", router);

  // ---------- API ----------
  app.use("/api", api);

  // ---------- OAuth (Google OIDC) ----------
  app.use("/auth/google", oauthRouter);

  // Backward-compat alias
  app.get("/api/auth/oauth/google", (req, res) => {
    const qs = req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "";
    return res.redirect(302, `/auth/google/login${qs}`);
  });

  // 404
  app.use((_req, res) =>
    res.status(404).json({ success: false, error: { code: 404, message: "Not Found" } }),
  );

  // Global error handler
  app.use(errorHandler);

  return app;
}
