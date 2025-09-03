import type { Request } from "express";
import { Types, isValidObjectId } from "mongoose";
import { DiagramModel } from "../../models/diagram.model";
import { normalizeErd, ZErdStrict } from "../../schemas/erd-ai";
import { pickDialect } from "../../utils/sql/pickDialect";
import { erdToSql } from "../../utils/sql/erdToSql";
import { sanitizeFilename } from "../../utils/file";
import z from "zod";
import { getOwnerFilter } from "./owner";

/** SUCCESS branch */
export type SqlExportSuccess = {
  error: false; // discriminator
  contentType: string;
  disposition: string;
  body: string;
};

/** ERROR branch */
export type SqlExportError = {
  error: true; // discriminator
  status: number;
  code: string;
  message: string;
};

/**
 * Build the SQL export or return a structured error.
 * Discriminated union ensures TypeScript narrowing in the controller.
 */
export async function buildSqlExport(req: Request): Promise<SqlExportSuccess | SqlExportError> {
  
  const { id } = req.params as { id: string };

  if (!isValidObjectId(id)) {
    return { error: true, status: 400, code: "BAD_ID", message: "Invalid diagram id" };
  }

  const owner = getOwnerFilter(req);
  const doc = await DiagramModel.findOne({ _id: new Types.ObjectId(id), ...owner }).lean();
  if (!doc) {
    return { error: true, status: 404, code: "NOT_FOUND", message: "Diagram not found" };
  }

  const rawErd = { nodes: (doc as any).nodes ?? [], edges: (doc as any).edges ?? [] };

  let erd: z.infer<typeof ZErdStrict>;
  const parsed = ZErdStrict.safeParse(rawErd);
  erd = parsed.success ? parsed.data : normalizeErd(rawErd);

  let dialect;
  try {
    dialect = pickDialect(req);
  } catch {
    return {
      error: true,
      status: 400,
      code: "BAD_DIALECT",
      message: "Unsupported or invalid SQL dialect",
    };
  }

  const schema =
    typeof req.query?.schema === "string" && dialect.supportsSchema()
      ? (req.query.schema as string)
      : "";

  const sql = erdToSql(erd, {
    dialect,
    schema,
    addIdentity: true,
    addFkIndexes: true,
    addNotNull: true,
    addTimestampsDefault: true,
  });

  const base = sanitizeFilename(
    (req.query.filename as string) || (doc as any).title || (doc as any).name || "diagram",
  );
  const fileName = `${base}.sql`;

  return {
    error: false,
    contentType: "application/sql; charset=utf-8",
    disposition: `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(
      fileName,
    )}`,
    body: sql,
  };
}
