import { NextFunction, Request, Response } from "express";
import logger from "../libs/logger";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = err.statusCode ?? 500;
  const message = err.message ?? "Internal Server Error";
  logger.error({ err }, "Unhandled error");
  res.status(status).json({ success: false, error: { code: status, message } });
}
