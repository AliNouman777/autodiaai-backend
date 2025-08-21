import { Router } from "express";
import { createFeedback, listFeedback } from "../controllers/feedbackController";

const r = Router();
r.post("/", createFeedback);
r.get("/", listFeedback);

export default r;
