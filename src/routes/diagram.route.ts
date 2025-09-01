// src/routes/diagram.routes.ts
import { Router } from "express";
import { softAuth } from "../middlewares/softAuth";
import { ensureAnonId } from "../middlewares/ensureAnonId";
import { enforceIfLoggedIn } from "../middlewares/enforceIfLoggedIn"; // ⬅️ add this
import {
  createDiagram,
  deleteDiagram,
  exportDiagramSql,
  getDiagram,
  listMyDiagrams,
  updateDiagram,
  addNodeField,
  updateNodeField,
  deleteNodeField,
  reorderNodeFields,
  updateNodeLabel,
} from "../controllers/diagram.controller";

const router = Router();

// 1) Attach logged-in user if token is present
router.use(softAuth);

// 2) Only if NOT logged in, ensure anon id exists
router.use(ensureAnonId);

/* --------------------------- Diagram CRUD --------------------------- */
router.get("/diagrams", listMyDiagrams);
router.get("/diagrams/:id", getDiagram);

// Enforce 10-diagram cap for *logged-in free* users only
router.post("/diagrams", enforceIfLoggedIn, createDiagram);

router.patch("/diagrams/:id", updateDiagram);
router.get("/diagrams/:id/export.sql", exportDiagramSql);
router.delete("/diagrams/:id", deleteDiagram);

/* ------------------------ Node Schema (fields) ----------------------- */
router.patch("/diagrams/:id/nodes/:nodeId/label", updateNodeLabel);
router.patch("/diagrams/:id/nodes/:nodeId/schema/reorder", reorderNodeFields);
router.post("/diagrams/:id/nodes/:nodeId/schema", addNodeField);
router.patch("/diagrams/:id/nodes/:nodeId/schema/:fieldId", updateNodeField);
router.delete("/diagrams/:id/nodes/:nodeId/schema/:fieldId", deleteNodeField);

export default router;
