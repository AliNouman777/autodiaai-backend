// services/mergeGuestDiagrams.ts
import mongoose from "mongoose";
import { DiagramModel } from "../models/diagram.model";

export async function mergeGuestDiagramsToUser(aid: string, userId: string) {
  if (!aid) return { merged: 0 };

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const res = await DiagramModel.updateMany(
      { ownerAnonId: aid }, // all guest diagrams for this browser
      { $set: { userId: new mongoose.Types.ObjectId(userId) }, $unset: { ownerAnonId: "" } },
      { session },
    );

    await session.commitTransaction();
    return { merged: res.modifiedCount ?? 0 };
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}
