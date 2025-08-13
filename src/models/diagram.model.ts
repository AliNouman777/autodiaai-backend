// src/models/diagram.model.ts
import { Schema, model, Types, InferSchemaType } from "mongoose";

const diagramSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "Untitled Diagram", trim: true },

    // ✅ no hardcoded enum; just a slug-style string
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

    prompt: { type: String, required: true },
    model: { type: String, enum: ["gpt5", "gemini"], default: "gpt5", index: true },
    nodes: { type: [Schema.Types.Mixed], default: [] },
    edges: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

export type DiagramDoc = InferSchemaType<typeof diagramSchema> & { _id: Types.ObjectId };
export default model<DiagramDoc>("Diagram", diagramSchema);
