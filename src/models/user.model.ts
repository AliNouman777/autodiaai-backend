// src/models/user.model.ts
import { Schema, model, models, type Model, type HydratedDocument } from "mongoose";

export interface User {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  plan: "free" | "pro";
  credits: number; // <— add credits for logged-in users
}

export type UserDoc = HydratedDocument<User>;

const UserSchema = new Schema<User>(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true },
    plan: { type: String, enum: ["free", "pro"], default: "free" },
    credits: { type: Number, default: 50, min: 0 }, // pick a sensible default
  },
  { timestamps: true },
);

export const UserModel = (models.User as Model<User>) || model<User>("User", UserSchema);
