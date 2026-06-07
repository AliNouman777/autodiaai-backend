// src/schemas/erd-ai.ts
import { z } from "zod";
import {
  MarkerStartEnum,
  MarkerEndEnum,
  DiagramEdgeAPI, // strict edge: requires markerStart/markerEnd/type/data
} from "./diagram.schema";

/* --------------------------- Loose field (LLM) --------------------------- */
const ZSchemaFieldLoose = z.object({
  id: z.string().min(1).trim(),
  title: z.string().min(1).trim(),
  type: z.string().min(1).trim(),
  // keep only PK/FK; anything else → undefined
  key: z
    .string()
    .optional()
    .transform((k) => (k === "PK" || k === "FK" ? (k as "PK" | "FK") : undefined)),
  nullable: z.boolean().optional(),
  default: z.any().optional(),
  note: z.string().trim().optional(),
});

/* --------------------------- Loose node (LLM) ---------------------------- */
/** LLM may omit position; default to {0,0}. */
export const ZNodeLoose = z.object({
  id: z.string().min(1).trim(),
  type: z.literal("databaseSchema"),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  data: z
    .object({
      label: z.string().min(1).trim(),
      schema: z.array(ZSchemaFieldLoose).default([]),
    })
    .default({ label: "Table", schema: [] }),
});

/* --------------------------- Loose edge (LLM) ---------------------------- */
export const ZEdgeLoose = z.object({
  id: z.string().min(1).trim(),
  source: z.string().min(1).trim(),
  target: z.string().min(1).trim(),
  sourceHandle: z.string().trim().optional(),
  targetHandle: z.string().trim().optional(),
  type: z.literal("superCurvyEdge").optional(),
  markerStart: MarkerStartEnum.optional(),
  markerEnd: MarkerEndEnum.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/* --------------------------- Loose ERD (LLM) ----------------------------- */
export const ZErdLoose = z.object({
  nodes: z.array(ZNodeLoose).default([]),
  edges: z.array(ZEdgeLoose).default([]),
});
export type TErdLoose = z.infer<typeof ZErdLoose>;

/* --------------------------- Strict field -------------------------------- */
const ZFieldStrict = z.object({
  id: z.string().min(1).trim(),
  title: z.string().min(1).trim(),
  type: z.string().min(1).trim(),
  key: z.union([z.literal("PK"), z.literal("FK")]).optional(),
});

/* --------------------------- Strict node --------------------------------- */
export const ZNodeStrict = z.object({
  id: z.string().min(1).trim(),
  type: z.literal("databaseSchema"),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.object({
    label: z.string().min(1).trim(),
    schema: z.array(ZFieldStrict).default([]),
  }),
});
export type TNodeStrict = z.infer<typeof ZNodeStrict>;

/* --------------------------- Strict ERD ---------------------------------- */
export const ZErdStrict = z.object({
  nodes: z.array(ZNodeStrict),
  edges: z.array(DiagramEdgeAPI), // requires markerStart/markerEnd/type/data
});
export type TErdStrict = z.infer<typeof ZErdStrict>;

/* --------------------------- Helpers ------------------------------------- */
const stripSide = (h?: string) => (h ? h.replace(/-(left|right)$/, "") : undefined);
const forceSide = (h: string | undefined, side: "left" | "right") =>
  h ? `${h.replace(/-(left|right)$/, "")}-${side}` : h;

/* --------------------------- Normalizer ---------------------------------- */
/**
 * Upgrades "loose" LLM output to "strict" UI/DB shape:
 * - Ensures node.position exists
 * - Ensures edges have type, data, markerStart/markerEnd
 * - Forces handle sides: sourceHandle -> '-right', targetHandle -> '-left'
 * - Infers markerEnd (cardinality) from target field when omitted
 */
export function normalizeErd(input: unknown): TErdStrict {
  const loose = ZErdLoose.parse(input);

  // index node fields to infer relationship cardinality
  const tableIndex = Object.fromEntries(
    loose.nodes.map((n) => {
      const fields = Object.fromEntries((n.data?.schema ?? []).map((f) => [f.id, f]));
      const pk = new Set(
        Object.values(fields)
          .filter((f: any) => f.key === "PK")
          .map((f: any) => f.id),
      );
      const fk = new Set(
        Object.values(fields)
          .filter((f: any) => f.key === "FK")
          .map((f: any) => f.id),
      );
      return [n.id, { fields, pk, fk }];
    }),
  );

  const inferMarkerEnd = (
    targetId: string,
    targetHandle?: string,
  ): z.infer<typeof MarkerEndEnum> => {
    const t = tableIndex[targetId];
    if (!t) return "many-end";
    const fid = stripSide(targetHandle);
    const field = fid ? t.fields[fid] : undefined;
    if (!field) return "many-end";

    const isPK = t.pk.has(field.id);
    const isFK = t.fk.has(field.id);
    const nullable = field.nullable === true;

    if (isFK) return nullable ? "zero-to-many-end" : "many-end";
    if (isPK) return nullable ? "zero-to-one-end" : "one-end";
    return nullable ? "zero-to-many-end" : "many-end";
  };

  /* -------- edges: fill defaults + fix handle sides -------- */
  const edges = loose.edges.map((e) =>
    DiagramEdgeAPI.parse({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: forceSide(e.sourceHandle, "right"),
      targetHandle: forceSide(e.targetHandle, "left"),
      type: e.type ?? "superCurvyEdge",
      markerStart: e.markerStart ?? "one-start",
      markerEnd: e.markerEnd ?? inferMarkerEnd(e.target, e.targetHandle),
      data: e.data ?? {},
    }),
  );

  /* -------- nodes: ensure position + clean fields -------- */
  const nodes: TNodeStrict[] = loose.nodes.map((n) =>
    ZNodeStrict.parse({
      id: n.id,
      type: "databaseSchema",
      position: n.position ?? { x: 0, y: 0 },
      data: {
        label: n.data?.label ?? "Table",
        schema: (n.data?.schema ?? []).map((f: any) => ({
          id: f.id,
          title: f.title,
          type: f.type,
          key: f.key === "PK" || f.key === "FK" ? f.key : undefined,
        })),
      },
    }),
  );

  return ZErdStrict.parse({ nodes, edges });
}
