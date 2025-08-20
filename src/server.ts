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

  app.use(cookieParser(process.env.COOKIE_SECRET || "dev-secret"));

  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN,
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));

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
