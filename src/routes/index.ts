import { Router } from "express";
import auth from "./auth.route";
import diagrams from "./diagram.route";
import feedback from "./feedback.route";
import wishlist from "./wishlist.route"

const api = Router();
api.use(auth);
api.use(diagrams);
api.use("/feedback", feedback);
api.use("/wishlist" , wishlist)

export default api;
