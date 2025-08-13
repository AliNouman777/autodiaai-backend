import { z } from "zod";

export const MarkerStartValues = [
  "one-start",
  "many-start",
  "zero-to-one-start",
  "zero-to-many-start",
  "zero-start",
] as const;

export const MarkerEndValues = [
  "one-end",
  "many-end",
  "zero-to-one-end",
  "zero-to-many-end",
  "zero-end",
] as const;

/** Column/field inside a node (table) */
export const NodeField = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(), // keep free-form type
  key: z.enum(["PK", "FK"]).optional(),
});

/** Graph node */
export const DiagramNode = z.object({
  id: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  type: z.literal("databaseSchema"),
  data: z.object({
    label: z.string(),
    schema: z.array(NodeField).min(1),
  }),
});

const ModelEnum = z.enum(["gpt-5", "gpt-5-mini", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);

/** Graph edge */
export const DiagramEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z
    .string()
    .regex(/-(left|right)$/i, { message: "sourceHandle must end with -left or -right" }),
  targetHandle: z
    .string()
    .regex(/-(left|right)$/i, { message: "targetHandle must end with -left or -right" }),
  type: z.literal("superCurvyEdge"),
  markerStart: z.enum(MarkerStartValues),
  markerEnd: z.enum(MarkerEndValues),
  data: z.record(z.string(), z.unknown()).default({}), // generic bag, defaults to {}
});

/** Full graph payload (for manual/generator save) */
export const DiagramPayload = z.object({
  title: z.string().default("Untitled Diagram"),
  nodes: z.array(DiagramNode).min(1),
  edges: z.array(DiagramEdge).min(0),
});

/** Free-text slug for diagram type (no hard-coded enum) */
export const typeSlug = z
  .string()
  .trim()
  .min(1, "Type is required")
  .max(32, "Type too long")
  .regex(/^[a-z][a-z0-9_-]*$/i, "Use letters/numbers/_/- (start with a letter)");

/** Create by metadata only (name + type) */
export const CreateDiagramReq = z.object({
  body: z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    // Optional: allow create to set a default model if you want
    model: ModelEnum.optional(),
  }),
});

/**
 * Update diagram — supports:
 * - metadata: name/type (preferred fields)
 * - legacy title (maps to name server-side if you want)
 * - content: nodes/edges
 * At least one field must be present.
 */
// in schemas/diagram.schema.ts
export const UpdateDiagramReq = z.object({
  params: z.object({
    id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid diagram id"),
  }),
  body: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      type: typeSlug.optional(),
      title: z.string().optional(),
      nodes: z.array(DiagramNode).optional(),
      edges: z.array(DiagramEdge).optional(),
      prompt: z.string().trim().min(5).max(2000).optional(),
      model: ModelEnum.optional(),
    })
    .refine(
      (b) => !!b.name || !!b.type || !!b.title || !!b.nodes || !!b.edges || !!b.prompt, // allow pure generation updates
      { message: "No fields to update" },
    ),
});
