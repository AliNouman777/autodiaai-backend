import { Router } from "express";
import { validate } from "../middlewares/validate";
import { registerSchema, loginSchema } from "../schemas/auth.schema";
import { login, me, register, logout } from "../controllers/auth.controller";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.post("/register", validate(registerSchema), register);
router.post("/login", validate(loginSchema), login);
router.get("/me", requireAuth, me);
router.get("/logout", requireAuth, logout);
export default router;
