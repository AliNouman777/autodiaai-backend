import express from "express";
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

export function createServer() {
  const app = express();

  // IMPORTANT for HTTPS behind Elastic Beanstalk / ALB
  app.set("trust proxy", 1);

  // Cookies (signed if you use req.signedCookies)
  app.use(cookieParser(process.env.COOKIE_SECRET || "dev-secret"));

  // Logging first
  app.use(pinoHttp({ logger }));

  // Helmet: disable COOP/COEP for now to avoid the warning until you're fully on HTTPS+COEP
  app.use(
    helmet({
      crossOriginOpenerPolicy: false,
      crossOriginEmbedderPolicy: false,
      // If CSP breaks your dev assets, you can disable temporarily:
      // contentSecurityPolicy: false,
    }),
  );

  // CORS (credentials + explicit origin)
  const ALLOWED_ORIGINS =
    env.CORS_ORIGIN === "*"
      ? true // reflect request origin — safe with credentials in `cors` package
      : Array.isArray(env.CORS_ORIGIN)
        ? env.CORS_ORIGIN
        : [env.CORS_ORIGIN];

  app.use(
    cors({
      origin: ALLOWED_ORIGINS,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      optionsSuccessStatus: 204,
    }),
  );

  // Useful for EB health checks (optional)
  // app.get("/health", (_req, res) => res.status(200).send("OK"));

  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.use("/api", api);

  app.use((_req, res) =>
    res.status(404).json({ success: false, error: { code: 404, message: "Not Found" } }),
  );

  app.use(errorHandler);

  return app;
}
