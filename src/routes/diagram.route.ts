import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import {
  createDiagram,
  deleteDiagram,
  exportDiagramSql,
  getDiagram,
  listMyDiagrams,
  updateDiagram,
} from "../controllers/diagram.controller";

const router = Router();

router.get("/diagrams", requireAuth, listMyDiagrams);
router.get("/diagrams/:id", requireAuth, getDiagram);
router.post("/diagrams", requireAuth, createDiagram);
router.patch("/diagrams/:id", requireAuth, updateDiagram);
// export diagram as sql
router.get("/diagrams/:id/export.sql", requireAuth, exportDiagramSql);

router.delete("/diagrams/:id", requireAuth, deleteDiagram);

export default router;
