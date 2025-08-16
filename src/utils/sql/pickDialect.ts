// src/utils/sql/pickDialect.ts
import type { Request } from "express";
import type { DialectRenderer, DialectId } from "./dialects";
import { PostgresRenderer, MySqlRenderer, SqliteRenderer } from "./dialects";

const DIALECTS: Record<DialectId, DialectRenderer> = {
  postgres: PostgresRenderer,
  mysql: MySqlRenderer,
  sqlite: SqliteRenderer,
};

export function pickDialect(req: Request, userDefault?: DialectId): DialectRenderer {
  const raw =
    (req.query.dialect as string | undefined)?.toLowerCase() ||
    (req.header("x-sql-dialect") || "").toLowerCase() ||
    userDefault ||
    "postgres";

  const d = (["postgres", "mysql", "sqlite"] as DialectId[]).includes(raw as DialectId)
    ? (raw as DialectId)
    : "postgres";

  return DIALECTS[d];
}
