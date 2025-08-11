// src/models/diagram.model.ts
import { Schema, model, Types, InferSchemaType } from "mongoose";

const diagramSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "Untitled Diagram" },
    prompt: { type: String, required: true },
    model: { type: String, enum: ["gpt5", "gemini"], default: "gpt5", index: true },
    nodes: { type: [Schema.Types.Mixed], default: [] },
    edges: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

// auto-generate the TS type from the schema
export type DiagramDoc = InferSchemaType<typeof diagramSchema> & { _id: Types.ObjectId };

export default model<DiagramDoc>("Diagram", diagramSchema);
