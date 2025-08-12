import mongoose from "mongoose";

export type UserDoc = mongoose.Document & {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  plan: "free" | "pro";
};

const userSchema = new mongoose.Schema<UserDoc>(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true },
    plan: { type: String, enum: ["free", "pro"], default: "free" },
  },
  { timestamps: true },
);

export default mongoose.model<UserDoc>("User", userSchema);
