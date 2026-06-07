// src/controllers/feedbackController.ts
import { Request, Response } from "express";
import { Feedback } from "../models/feedback.model";
import { FeedbackInput } from "../schemas/feedback.schema";
import { ok, fail } from "../utils/http"; // adjust import if needed

export async function createFeedback(req: Request, res: Response) {
  // Validate request body
  const parsed = FeedbackInput.safeParse(req.body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return res.status(400).json(fail(`Invalid input: ${issues}`, "VALIDATION_ERROR"));
  }

  const { name, feedback } = parsed.data;

  try {
    const doc = await Feedback.create({ name, feedback });

    // Respond with name so frontend can render personalized toast
    return res.status(201).json(
      ok({
        id: doc.id,
        name: doc.name,
        message: `${doc.name}, thank you for your feedback!`,
      }),
    );
  } catch (e) {
    return res.status(500).json(fail("Failed to save feedback", "INTERNAL_ERROR"));
  }
}

export async function listFeedback(_req: Request, res: Response) {
  try {
    const rows = await Feedback.find({}, { name: 1, feedback: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json(ok({ items: rows, limit: 50 }));
  } catch (e) {
    return res.status(500).json(fail("Failed to fetch feedback", "INTERNAL_ERROR"));
  }
}
