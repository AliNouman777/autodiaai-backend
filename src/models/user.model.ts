import { Schema, model, models, type Model, type HydratedDocument } from "mongoose";

export interface User {
  firstName?: string;
  lastName?: string;
  email: string;
  passwordHash?: string; // optional (only for email/password accounts)
  plan: "free" | "pro";
  credits: number;
  providers: {
    google?: string; // Google OIDC "sub" (profile.id)
  };
  isEmailVerified: boolean;
  lastLoginAt?: Date;
}

export type UserDoc = HydratedDocument<User>;

export interface GoogleUpsertInput {
  providerId: string;
  email: string;
  name?: string | null;
  emailVerified?: boolean;
}

export interface UserModelType extends Model<User> {
  upsertFromGoogle(input: GoogleUpsertInput): Promise<UserDoc>;
}

const UserSchema = new Schema<User, UserModelType>(
  {
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    email: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    passwordHash: { type: String, select: false },
    plan: { type: String, enum: ["free", "pro"], default: "free" },
    credits: { type: Number, default: 50, min: 0 },
    providers: {
      google: { type: String, index: true },
    },
    isEmailVerified: { type: Boolean, default: false },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

// Index for provider lookups
UserSchema.index({ "providers.google": 1 });

function splitName(displayName?: string | null): { firstName?: string; lastName?: string } {
  if (!displayName) return {};
  const parts = displayName.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0] };
  if (parts.length > 1) return { firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1) };
  return {};
}

UserSchema.statics.upsertFromGoogle = async function upsertFromGoogle(
  this: UserModelType,
  input: GoogleUpsertInput,
): Promise<UserDoc> {
  const { providerId, email, name, emailVerified } = input;

  // 1) Find by google subject
  let user = await this.findOne({ "providers.google": providerId });
  if (user) {
    user.lastLoginAt = new Date();
    if (emailVerified && !user.isEmailVerified) user.isEmailVerified = true;
    await user.save();
    return user;
  }

  // 2) Link by email if exists
  user = await this.findOne({ email });
  if (user) {
    if (!user.providers) user.providers = {};
    user.providers.google = providerId;
    user.lastLoginAt = new Date();
    if (emailVerified) user.isEmailVerified = true;
    await user.save();
    return user;
  }

  // 3) Create
  const { firstName, lastName } = splitName(name || undefined);
  user = await this.create({
    email,
    firstName,
    lastName,
    providers: { google: providerId },
    isEmailVerified: !!emailVerified,
    plan: "free",
    credits: 50,
    lastLoginAt: new Date(),
  });

  return user;
};

export const UserModel =
  (models.User as UserModelType) || model<User, UserModelType>("User", UserSchema);
