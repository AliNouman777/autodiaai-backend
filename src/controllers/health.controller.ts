import { Request, Response } from "express";
import os from "os";
import { ok } from "../utils/http";

export function getLiveness(_req: Request, res: Response) {
  res.json(ok({ status: "ok", ts: Date.now() }));
}

export function getReadiness(_req: Request, res: Response) {
  res.json(
    ok({
      status: "ready",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      hostname: os.hostname(),
    }),
  );
}
