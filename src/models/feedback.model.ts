import { Schema, model, InferSchemaType, Types } from "mongoose";

const FeedbackSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    feedback: { type: String, required: true, trim: true, maxlength: 5000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type FeedbackDoc = InferSchemaType<typeof FeedbackSchema> & { _id: Types.ObjectId };
export const Feedback = model<FeedbackDoc>("Feedback", FeedbackSchema);
