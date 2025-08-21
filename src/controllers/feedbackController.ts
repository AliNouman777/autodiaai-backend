import { Request, Response } from "express";
import { Feedback } from "../models/feedback.model";
import { FeedbackInput } from "../schemas/feedback.schema";

export async function createFeedback(req: Request, res: Response) {
  const parsed = FeedbackInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { category, name, feedback } = parsed.data;

  try {
    const doc = await Feedback.create({ category, name, feedback });
    return res.status(201).json({ id: doc._id, createdAt: doc.createdAt });
  } catch (e) {
    return res.status(500).json({ error: "failed_to_save" });
  }
}

export async function listFeedback(_req: Request, res: Response) {
  const rows = await Feedback.find({}, { category: 1, name: 1, feedback: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json(rows);
}
