import { Schema, model, InferSchemaType } from "mongoose";

const aiCacheSchema = new Schema(
  {
    // cache key: `${model}::${normalizedPrompt}`
    key: { type: String, required: true, unique: true, index: true },
    // raw text from provider (so you can see it later if needed)
    raw: { type: String, required: true },
    // parsed diagram shape we’ll return/use
    payload: {
      title: String,
      nodes: { type: [Schema.Types.Mixed], default: [] },
      edges: { type: [Schema.Types.Mixed], default: [] },
    },
  },
  { timestamps: true },
);

export type AiCacheDoc = InferSchemaType<typeof aiCacheSchema>;
export default model<AiCacheDoc>("AiCache", aiCacheSchema);
