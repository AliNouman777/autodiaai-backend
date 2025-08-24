import { Router } from "express";
import { createWishlist, wishlist } from "../controllers/wishlist.controller";

const r = Router();
r.post("/", createWishlist);
r.get("/", wishlist);

export default r;
