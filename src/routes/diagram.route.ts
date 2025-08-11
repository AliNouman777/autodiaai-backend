import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import {
  createDiagram,
  deleteDiagram,
  generateDiagram,
  getDiagram,
  listMyDiagrams,
  updateDiagram,
} from "../controllers/diagram.controller";

const router = Router();
router.use(requireAuth);

router.get("/diagrams", listMyDiagrams);
router.get("/diagrams/:id", getDiagram);
router.post("/diagrams", createDiagram);
router.post("/diagrams/generate", generateDiagram);
router.patch("/diagrams/:id", updateDiagram);
router.delete("/diagrams/:id", deleteDiagram);

export default router;
