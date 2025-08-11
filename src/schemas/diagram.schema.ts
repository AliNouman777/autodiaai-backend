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

export const NodeField = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  key: z.enum(["PK", "FK"]).optional(),
});

export const DiagramNode = z.object({
  id: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  type: z.literal("databaseSchema"),
  data: z.object({
    label: z.string(),
    schema: z.array(NodeField).min(1),
  }),
});

export const DiagramEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().regex(/-(left|right)$/i, { message: "sourceHandle must end with -left or -right" }),
  targetHandle: z.string().regex(/-(left|right)$/i, { message: "targetHandle must end with -left or -right" }),
  type: z.literal("superCurvyEdge"),
  markerStart: z.enum(MarkerStartValues),
  markerEnd: z.enum(MarkerEndValues),
  data: z.record(z.string(), z.any()).default({}), // must exist ({} by default)
});

export const DiagramPayload = z.object({
  title: z.string().default("Untitled Diagram"),
  nodes: z.array(DiagramNode).min(1),
  edges: z.array(DiagramEdge).min(0),
});

export const GenerateDiagramReq = z.object({
  body: z.object({
    prompt: z.string().min(5).max(2000),
    model: z.enum(["gpt5", "gemini"]).default("gpt5"),
    title: z.string().optional(),
  }),
});

export const UpdateDiagramReq = z.object({
  body: z
    .object({
      title: z.string().optional(),
      nodes: z.array(DiagramNode).optional(),
      edges: z.array(DiagramEdge).optional(),
    })
    .refine((b) => !!b.title || !!b.nodes || !!b.edges, { message: "No fields to update" }),
});
