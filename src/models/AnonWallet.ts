// models/AnonWallet.ts
import { Schema, model, models, type Model, type HydratedDocument } from "mongoose";

export interface AnonWallet {
  anonId: string; // from signed cookie `aid`
  credits: number; // guest credits
}

export type AnonWalletDoc = HydratedDocument<AnonWallet>;

const AnonWalletSchema = new Schema<AnonWallet>(
  {
    anonId: { type: String, unique: true, index: true, required: true },
    credits: { type: Number, default: 20, min: 0 },
  },
  { timestamps: true },
);

export const AnonWalletModel =
  (models.AnonWallet as Model<AnonWallet>) || model<AnonWallet>("AnonWallet", AnonWalletSchema);
