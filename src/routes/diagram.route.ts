// src/routes/diagram.routes.ts
import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
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

/* --------------------------- Diagram CRUD --------------------------- */

router.get("/diagrams", requireAuth, listMyDiagrams);
router.get("/diagrams/:id", requireAuth, getDiagram);
router.post("/diagrams", requireAuth, createDiagram);
router.patch("/diagrams/:id", requireAuth, updateDiagram);
router.get("/diagrams/:id/export.sql", requireAuth, exportDiagramSql);
router.delete("/diagrams/:id", requireAuth, deleteDiagram);

/* ------------------------ Node Schema (fields) ----------------------- */
/**
 * IMPORTANT: Put the "reorder" route BEFORE ":fieldId" routes
 * so "/schema/reorder" doesn't get captured by ":fieldId".
 */

// Rename table label
router.patch("/diagrams/:id/nodes/:nodeId/label", requireAuth, updateNodeLabel);

// Reorder fields (must be before :fieldId)
router.patch("/diagrams/:id/nodes/:nodeId/schema/reorder", requireAuth, reorderNodeFields);

// Add new field (column)
router.post("/diagrams/:id/nodes/:nodeId/schema", requireAuth, addNodeField);

// Update a field (column)
router.patch("/diagrams/:id/nodes/:nodeId/schema/:fieldId", requireAuth, updateNodeField);

// Delete a field (column)
router.delete("/diagrams/:id/nodes/:nodeId/schema/:fieldId", requireAuth, deleteNodeField);

export default router;
