// models/Usage.ts
import {
    Schema,
    model,
    models,
    type Model,
    type HydratedDocument,
  } from "mongoose";
  
  export interface Usage {
    key: string;
    identityType: "user" | "anon";
    identityId: string;
    modelName: string;
    cost: number;
    status: "reserved" | "charged" | "refunded" | "failed";
    meta?: Record<string, any>;
  }
  
  // What you’ll get back from queries
  export type UsageDoc = HydratedDocument<Usage>;
  
  const UsageSchema = new Schema<Usage>(
    {
      key: { type: String, unique: true, index: true, required: true },
      identityType: { type: String, enum: ["user", "anon"], required: true },
      identityId: { type: String, required: true, index: true },
      modelName: { type: String, required: true },
      cost: { type: Number, required: true, min: 0 },
      status: {
        type: String,
        enum: ["reserved", "charged", "refunded", "failed"],
        default: "reserved",
        index: true,
      },
      meta: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
  );
  
  UsageSchema.index({ identityType: 1, identityId: 1, createdAt: -1 });
  
  // Important: cast models.Usage to Model<Usage>
  const UsageModel =
    (models.Usage as Model<Usage>) || model<Usage>("Usage", UsageSchema);
  
  export default UsageModel;
  