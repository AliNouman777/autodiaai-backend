// src/utils/diagramUsage.ts
import { DiagramModel } from "../models/diagram.model";
import mongoose from "mongoose";

/** Counts diagrams owned by a user, handling both ownerId/userId + string/ObjectId. */
export async function countUserDiagrams(userId: string, extra: Record<string, any> = {}) {
  const ids: any[] = [userId];
  if (mongoose.Types.ObjectId.isValid(userId)) {
    ids.push(new mongoose.Types.ObjectId(userId));
  }

  return DiagramModel.countDocuments({
    $and: [
      { $or: [{ ownerId: { $in: ids } }, { userId: { $in: ids } }] },
      { archived: { $ne: true } }, // keep your archived semantics
      extra,
    ],
  });
}
