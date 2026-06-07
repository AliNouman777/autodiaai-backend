// src/config/env.ts
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Try multiple .env locations, prefer env-specific, then local, then default
const candidates = [`.env.${process.env.NODE_ENV ?? "development"}`, ".env.local", ".env"];

let loadedFrom: string | null = null;
for (const file of candidates) {
  const p = path.resolve(process.cwd(), file);
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override: true }); // override any empty shell vars
    loadedFrom = file;
    break;
  }
}

const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 4000),
  MONGO_URI: process.env.MONGO_URI ?? "",
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "*",
};

if (!env.MONGO_URI) {
  const tried = candidates.map((f) => (f === loadedFrom ? `*${f}` : f)).join(", ");
  throw new Error(
    `MONGO_URI is required. Checked files: ${tried}. ` +
      `Make sure a real ".env" exists in project root and includes MONGO_URI=...`,
  );
}

export default env;
