// src/validation/feedback.ts

import { z } from "zod";

export const FeedbackInput = z.object({
  name: z.string().trim().min(1).max(120),
  feedback: z.string().trim().min(1).max(5000),
});

export type FeedbackInputT = z.infer<typeof FeedbackInput>;
