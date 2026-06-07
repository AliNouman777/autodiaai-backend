// src/schemas/diagram.zod.ts
import { z } from "zod";

/* ------------------------------- Enums ------------------------------- */

export const FieldKeyEnum = z.enum(["PK", "FK", "NONE"]);

export const ModelEnum = z.enum([
  "gpt-5",
  "gpt-5-mini",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "deepseek/deepseek-chat-v3-0324:free",
]);

/** Free-text slug for diagram type (same constraint as mongoose validate) */
export const typeSlug = z
  .string()
  .trim()
  .min(1, "Type is required")
  .max(32, "Type too long")
  .regex(/^[a-z][a-z0-9_-]*$/i, "Use letters/numbers/_/- (start with a letter)");

/* --------------------------- Primitive pieces --------------------------- */

export const Position = z.object({
  x: z.number(),
  y: z.number(),
});

/** Field/column (matches FieldSchema) */
export const Field = z.object({
  id: z.string().min(1).trim(), // e.g., "authors-first_name"
  title: z.string().min(1).trim(), // e.g., "first_name"
  type: z.string().min(1).trim(), // e.g., "VARCHAR(255)"
  key: FieldKeyEnum.default("NONE").optional(),
  nullable: z.boolean().default(true).optional(),
  default: z.string().nullable().default(null).optional(),
  note: z.string().trim().optional(),
});

/** Node.data (matches NodeDataSchema) */
export const NodeData = z.object({
  label: z.string().min(1).trim(), // table name e.g., "Authors"
  schema: z.array(Field).default([]),
});

export const MarkerStartEnum = z.enum([
  "one-start",
  "many-start",
  "zero-start",
  "zero-to-one-start",
  "zero-to-many-start",
]);
export const MarkerEndEnum = z.enum([
  "one-end",
  "many-end",
  "zero-end",
  "zero-to-one-end",
  "zero-to-many-end",
]);

/* ----------------------- Node / Edge (DB-aligned) ----------------------- */
/** Mirrors your Mongoose NodeSchema (data is optional in DB) */
export const DiagramNodeDB = z.object({
  id: z.string().min(1).trim(),
  type: z.string().min(1).trim(), // Mongoose allows any string; your UI uses "databaseSchema"
  position: Position, // required in DB
  data: NodeData.optional(), // optional in DB
});

/** Mirrors your Mongoose EdgeSchema (handles optional; no markers enforced) */
export const DiagramEdgeDB = z.object({
  id: z.string().min(1).trim(),
  source: z.string().min(1).trim(),
  sourceHandle: z.string().trim().optional(),
  target: z.string().min(1).trim(),
  targetHandle: z.string().trim().optional(),
  markerStart: MarkerStartEnum,
  markerEnd: MarkerEndEnum,
  data: z.record(z.string(), z.unknown()).optional(), // Mixed
});

/** Full diagram payload (DB-aligned) */
export const DiagramPayloadDB = z.object({
  title: z.string().default("Untitled Diagram"),
  type: typeSlug, // matches your Mongoose validation
  prompt: z.string().optional(),
  model: ModelEnum.default("gemini-2.5-flash-lite").optional(),
  nodes: z.array(DiagramNodeDB).default([]),
  edges: z.array(DiagramEdgeDB).default([]),
});

/* ----------------------- Node / Edge (API-aligned) ---------------------- */
/**
 * API version is stricter: we keep your current client assumptions:
 * - node.type is the ERD node type you use in the UI
 * - data is required with at least one field when creating/updating schema
 * Adjust if your UI allows empty tables.
 */
export const DiagramNodeAPI = z.object({
  id: z.string().min(1).trim(),
  type: z.literal("databaseSchema"),
  position: Position,
  data: NodeData.extend({
    schema: z.array(Field).min(1), // enforce at least 1 field over the API
  }),
});

/** API edge with optional handles (you can tighten if needed) */
export const DiagramEdgeAPI = z.object({
  id: z.string().min(1).trim(),
  source: z.string().min(1).trim(),
  target: z.string().min(1).trim(),
  sourceHandle: z.string().trim().optional(),
  targetHandle: z.string().trim().optional(),
  type: z.literal("superCurvyEdge").default("superCurvyEdge"),
  markerStart: MarkerStartEnum, // <-- required in API
  markerEnd: MarkerEndEnum, // <-- required in API
  data: z.record(z.string(), z.unknown()).default({}),
});

/** API payload for create/save from client */
export const DiagramPayloadAPI = z.object({
  title: z.string().default("Untitled Diagram"),
  nodes: z.array(DiagramNodeAPI).min(1), // require some content when saving via API
  edges: z.array(DiagramEdgeAPI).min(0),
});

/* -------------------------- Request wrappers --------------------------- */

/** Create by metadata only (same shape you had, but type follows slug) */
export const CreateDiagramReq = z.object({
  body: z.object({
    name: z.string().min(1),
    type: typeSlug, // keep same validation rule as DB
    model: ModelEnum.optional(),
    prompt: z.string().optional(),
  }),
});

/** Path param validator for ObjectId */
export const ObjectIdParam = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid id"),
});

/**
 * Update diagram — mirrors your existing intent, but aligns with the new model.
 * - You can send metadata (name/type/prompt/model)
 * - Or content (nodes/edges) using either the API (strict) or DB (loose) shape
 *   => choose one style for your controllers; below we accept the API style by default.
 */
export const UpdateDiagramReq = z.object({
  params: ObjectIdParam,
  body: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      type: typeSlug.optional(),
      title: z.string().optional(),
      prompt: z.string().trim().min(1).max(2000).optional(),
      model: ModelEnum.optional(),

      // Choose ONE of these depending on your controller’s policy:
      nodes: z.array(DiagramNodeAPI).optional(),
      edges: z.array(DiagramEdgeAPI).optional(),

      // If you want to also accept the looser DB shape, uncomment:
      // nodesDB: z.array(DiagramNodeDB).optional(),
      // edgesDB: z.array(DiagramEdgeDB).optional(),
    })
    .refine(
      (b) =>
        !!b.name ||
        !!b.type ||
        !!b.title ||
        !!b.prompt ||
        !!b.model ||
        !!b.nodes ||
        !!b.edges /* || !!b.nodesDB || !!b.edgesDB */,
      { message: "No fields to update" },
    ),
});

/* -------------------------- Field-level CRUD --------------------------- */
/** Use these for your /schema field add/update/delete endpoints */

export const FieldCreateReq = z.object({
  params: ObjectIdParam.extend({
    nodeId: z.string().min(1),
  }),
  body: Field, // full field on create
});

export const FieldUpdateReq = z.object({
  params: ObjectIdParam.extend({
    nodeId: z.string().min(1),
    fieldId: z.string().min(1),
  }),
  body: z
    .object({
      id: z.string().min(1).optional(), // allow rename with uniqueness check server-side
      title: z.string().min(1).trim().optional(),
      type: z.string().min(1).trim().optional(),
      key: FieldKeyEnum.optional(),
      nullable: z.boolean().optional(),
      default: z.string().nullable().optional(),
      note: z.string().trim().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" }),
});

export const FieldDeleteReq = z.object({
  params: ObjectIdParam.extend({
    nodeId: z.string().min(1),
    fieldId: z.string().min(1),
  }),
});

export const FieldReorderReq = z.object({
  params: ObjectIdParam.extend({
    nodeId: z.string().min(1),
  }),
  body: z.object({
    order: z.array(z.string().min(1)).min(1),
  }),
});

/* ------------------------ Optional: label rename ------------------------ */
export const NodeLabelUpdateReq = z.object({
  params: ObjectIdParam.extend({
    nodeId: z.string().min(1),
  }),
  body: z.object({
    label: z.string().min(1).trim(),
  }),
});
