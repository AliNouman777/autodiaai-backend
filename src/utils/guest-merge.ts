import mongoose, { Types } from "mongoose";
import { DiagramModel } from "../models/diagram.model";

export async function mergeGuestDiagramsToUser(
  aid: string | undefined,
  userId: string,
  plan: "free" | "pro",
) {
  if (!aid) return { merged: 0 };
  if (plan === "free") {
    const current = await DiagramModel.countDocuments({ userId });
    if (current >= 10) return { merged: 0 };
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const res = await DiagramModel.updateMany(
      { ownerAnonId: aid },
      { $set: { userId: new Types.ObjectId(userId) }, $unset: { ownerAnonId: "" } },
      { session },
    );
    await session.commitTransaction();
    return { merged: res.modifiedCount ?? 0 };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}
