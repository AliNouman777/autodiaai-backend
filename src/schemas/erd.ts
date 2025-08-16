// src/schemas/erd.ts
import { z } from "zod";

export const ZSchemaField = z.object({
  id: z.string(),
  title: z.string().min(1), // column name
  type: z.string().min(1), // e.g., INT, VARCHAR(255)
  key: z.enum(["PK", "FK"]).optional(),
});

export const ZNode = z.object({
  id: z.string(),
  type: z.literal("databaseSchema"),
  data: z.object({
    label: z.string().min(1), // table name
    schema: z.array(ZSchemaField),
  }),
});

export const ZEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
});

export const ZErd = z.object({
  nodes: z.array(ZNode),
  edges: z.array(ZEdge),
});

export type TErd = z.infer<typeof ZErd>;
