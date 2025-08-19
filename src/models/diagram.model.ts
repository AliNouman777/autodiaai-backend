// src/models/diagram.model.ts
import { Schema, model, Types, InferSchemaType } from "mongoose";

/* ------------------------------- Enums ------------------------------- */
const FIELD_KEYS = ["PK", "FK", "NONE"] as const;

const MARKER_START = [
  "one-start",
  "many-start",
  "zero-start",
  "zero-to-one-start",
  "zero-to-many-start",
] as const;

const MARKER_END = [
  "one-end",
  "many-end",
  "zero-end",
  "zero-to-one-end",
  "zero-to-many-end",
] as const;

const MODELS = [
  "gpt-5",
  "gpt-5-mini",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "deepseek/deepseek-chat-v3-0324:free",
] as const;

/* --------------------------- Field / Node ---------------------------- */
const FieldSchema = new Schema(
  {
    id: { type: String, required: true, trim: true }, // e.g., "users-id"
    title: { type: String, required: true, trim: true }, // e.g., "id"
    type: { type: String, required: true, trim: true }, // e.g., "INT", "VARCHAR(255)"
    key: { type: String, enum: FIELD_KEYS, default: "NONE" }, // keep NONE for legacy/neutral
    nullable: { type: Boolean, default: true },
    default: { type: String, default: null }, // allow explicit null default
    note: { type: String, trim: true },
  },
  { _id: false },
);

const NodeDataSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    schema: { type: [FieldSchema], default: [] },
  },
  { _id: false },
);

const NodeSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    // DB allows any string; UI uses "databaseSchema"
    type: { type: String, required: true, trim: true },
    position: {
      x: { type: Number, required: true },
      y: { type: Number, required: true },
    },
    // Optional in DB (matches DiagramNodeDB). API layer can enforce stricter.
    data: { type: NodeDataSchema, required: false },
  },
  { _id: false },
);

/* -------------------------------- Edge ------------------------------- */
/** Matches DiagramEdgeDB: type fixed to "superCurvyEdge", markers required, data defaults to {} */
const EdgeSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    source: { type: String, required: true, trim: true },
    target: { type: String, required: true, trim: true },
    sourceHandle: { type: String, trim: true },
    targetHandle: { type: String, trim: true },

    // keep edge type stable and explicit
    type: {
      type: String,
      enum: ["superCurvyEdge"],
      default: "superCurvyEdge",
      required: true,
    },

    // 🔴 required by schema (no defaults here to force upstream normalization)
    markerStart: { type: String, enum: MARKER_START, required: true },
    markerEnd: { type: String, enum: MARKER_END, required: true },

    data: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

/* ------------------------------ Diagram ------------------------------ */
const DiagramSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "Untitled Diagram", trim: true },

    type: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
      validate: {
        validator: (v: string) => /^[a-z][a-z0-9_-]{0,31}$/i.test(v),
        message: "Type must be a slug (letters/numbers/underscore/hyphen, 1–32 chars).",
      },
    },

    prompt: { type: String },

    model: {
      type: String,
      enum: MODELS,
      default: "gemini-2.5-flash-lite",
      index: true,
    },

    nodes: { type: [NodeSchema], default: [] },
    edges: { type: [EdgeSchema], default: [] },
  },
  { timestamps: true },
);

// Helpful compound index for reads
DiagramSchema.index({ _id: 1, userId: 1 });

export type DiagramDoc = InferSchemaType<typeof DiagramSchema> & { _id: Types.ObjectId };
export default model<DiagramDoc>("Diagram", DiagramSchema);
