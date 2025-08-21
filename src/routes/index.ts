import { Router } from "express";
import health from "./health.route";
import auth from "./auth.route";
import diagrams from "./diagram.route";
import feedback from "./feedback.route";

const api = Router();
api.use(health);
api.use(auth);
api.use(diagrams);
api.use("/feedback", feedback);

export default api;
