// src/models/diagram.model.ts
import { Schema, model, models, type Model, type HydratedDocument, Types } from "mongoose";

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

/** --- sub-schemas --- */
const FieldSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    key: { type: String, enum: FIELD_KEYS, default: "NONE" },
    nullable: { type: Boolean, default: true },
    default: { type: String, default: null },
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
    type: { type: String, required: true, trim: true },
    position: { x: { type: Number, required: true }, y: { type: Number, required: true } },
    data: { type: NodeDataSchema, required: false },
  },
  { _id: false },
);

const EdgeSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    source: { type: String, required: true, trim: true },
    target: { type: String, required: true, trim: true },
    sourceHandle: { type: String, trim: true },
    targetHandle: { type: String, trim: true },
    type: { type: String, enum: ["superCurvyEdge"], default: "superCurvyEdge", required: true },
    markerStart: { type: String, enum: MARKER_START, required: true },
    markerEnd: { type: String, enum: MARKER_END, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

/** --- RAW ATTRS type (used in Schema<ModelAttrs> & Model<ModelAttrs>) --- */
export interface DiagramAttrs {
  userId: Types.ObjectId | null;
  ownerAnonId: string | null;
  title: string;
  type: string;
  prompt?: string;
  model: (typeof MODELS)[number];
  nodes: unknown[];
  edges: unknown[];
  // timestamps are added at runtime; no need to include in the schema generic
}

/** Hydrated document type you’ll get from queries */
export type DiagramDoc = HydratedDocument<DiagramAttrs>;

const DiagramSchema = new Schema<DiagramAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    ownerAnonId: { type: String, default: null, index: true },

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
    model: { type: String, enum: MODELS, default: "gemini-2.5-flash-lite", index: true },
    nodes: { type: [NodeSchema], default: [] },
    edges: { type: [EdgeSchema], default: [] },
  },
  { timestamps: true },
);

// exactly-one owner
DiagramSchema.pre("validate", function (next) {
  const hasUser = !!this.userId;
  const hasAnon = !!this.ownerAnonId;
  if ((hasUser || hasAnon) && !(hasUser && hasAnon)) return next();
  next(new Error("Exactly one of userId or ownerAnonId must be set."));
});

// good indexes (remove the bad identityType one)
DiagramSchema.index({ userId: 1, updatedAt: -1 });
DiagramSchema.index({ ownerAnonId: 1, updatedAt: -1 });

/** The Model must be Model<DiagramAttrs>, NOT Model<DiagramDoc> */
export const DiagramModel: Model<DiagramAttrs> =
  (models.Diagram as Model<DiagramAttrs>) || model<DiagramAttrs>("Diagram", DiagramSchema);
