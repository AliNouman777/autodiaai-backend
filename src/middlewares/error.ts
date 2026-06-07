// src/middlewares/error.ts
import type { Request, Response, NextFunction } from "express";
import { fail } from "../utils/http";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  // If a handler already sent something, do not attempt to write again
  if (res.headersSent || res.writableEnded) {
    return;
  }

  const status =
    (typeof err?.status === "number" && err.status) ||
    (typeof err?.statusCode === "number" && err.statusCode) ||
    500;

  const message = err?.message || "Unexpected error";
  res.status(status).json(fail(message, status >= 500 ? "SERVER_ERROR" : "BAD_REQUEST"));
}
