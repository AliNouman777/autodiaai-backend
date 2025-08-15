// src/models/diagram.model.ts
import { Schema, model, Types, InferSchemaType } from "mongoose";

const diagramSchema = new Schema(
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

    // ✅ canonical model IDs we support end-to-end
    model: {
      type: String,
      enum: [
        "gpt-5",
        "gpt-5-mini",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "deepseek/deepseek-chat-v3-0324:free",
      ],
      default: "gemini-2.5-flash-lite",
      index: true,
    },

    nodes: { type: [Schema.Types.Mixed], default: [] },
    edges: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

export type DiagramDoc = InferSchemaType<typeof diagramSchema> & { _id: Types.ObjectId };
export default model<DiagramDoc>("Diagram", diagramSchema);
