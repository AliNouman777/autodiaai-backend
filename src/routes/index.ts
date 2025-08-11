import { Router } from "express";
import health from "./health.route";
import auth from "./auth.route";
import diagrams from "./diagram.route";

const api = Router();
api.use(health);
api.use(auth);
api.use(diagrams); // <-- THIS mounts /diagrams routes

export default api;
