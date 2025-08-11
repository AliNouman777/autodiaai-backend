import mongoose from "mongoose";

export type UserDoc = mongoose.Document & {
  email: string;
  password: string;
  plan: "free" | "pro";
};

const userSchema = new mongoose.Schema<UserDoc>(
  {
    email: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true },
    plan: { type: String, enum: ["free", "pro"], default: "free" },
  },
  { timestamps: true },
);

export default mongoose.model<UserDoc>("User", userSchema);
