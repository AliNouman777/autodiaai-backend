// diagram.controller.ts
import type { Request, Response } from "express";
import Diagram, { DiagramDoc } from "../models/diagram.model";
import { ok, fail } from "../utils/http";
import {
  CreateDiagramReq,
  FieldCreateReq,
  FieldDeleteReq,
  FieldReorderReq,
  FieldUpdateReq,
  NodeLabelUpdateReq,
  UpdateDiagramReq,
} from "../schemas/diagram.schema";
import { getProviderFor, type CanonicalModel } from "../services/ai";
import aicacheModel from "../models/aicache.model";
import * as nodeCrypto from "node:crypto";
import { isValidErd } from "../libs/isValidErd";
import { erdToSql } from "../utils/sql/erdToSql";
import { sanitizeFilename } from "../utils/file";
import { pickDialect } from "../utils/sql/pickDialect";
import { normalizeErd, ZErdStrict } from "../schemas/erd-ai";
import { HydratedDocument } from "mongoose";
import { DialectRenderer } from "../utils/sql/dialects";
import z from "zod";

// ---------- helpers ----------
function ensureDiagramShape(obj: any) {
  if (!obj || typeof obj !== "object") throw new Error("Bad AI output");
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    throw new Error("AI must return { nodes: [], edges: [] }");
  }
  const title =
    typeof obj.title === "string" && obj.title.trim().length
      ? obj.title.trim()
      : "Untitled Diagram";

  // ⬇️ Normalize to strict (adds markers if missing)
  const strict = normalizeErd({ nodes: obj.nodes, edges: obj.edges });

  return { title, nodes: strict.nodes, edges: strict.edges };
}

function makeKey(model: string, prompt: string) {
  const norm = prompt.trim().replace(/\s+/g, " ");
  return `${model}::` + nodeCrypto.createHash("sha256").update(norm).digest("hex");
}

async function generateFromPrompt({
  prompt,
  model,
  titleOverride,
}: {
  prompt: string;
  model: CanonicalModel;
  titleOverride?: string;
}) {
  const key = makeKey(model, prompt);

  // 1) Try cache
  const hit = await aicacheModel.findOne({ key }).lean();
  if (hit) {
    // Cache stores normalized payload (after this change)
    const diagram = ensureDiagramShape(hit.payload);
    if (titleOverride) diagram.title = titleOverride;
    return { ...diagram, prompt, model };
  }

  // 2) Call provider
  const provider = getProviderFor(model);
  const raw = await provider.generate(prompt, model);
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);

  // 3) Parse JSON (tolerant), then normalize
  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const s = rawText.indexOf("{");
    const e = rawText.lastIndexOf("}");
    if (s >= 0 && e > s) parsed = JSON.parse(rawText.slice(s, e + 1));
    else throw new Error("AI did not return JSON");
  }

  const diagram = ensureDiagramShape(parsed); // ⬅️ includes normalizeErd inside
  if (titleOverride) diagram.title = titleOverride;

  // 4) Save cache (normalized!)
  await aicacheModel.create({ key, raw: rawText, payload: diagram });

  return { ...diagram, prompt, model };
}

type Loaded = { diagram: HydratedDocument<DiagramDoc>; node: any };
type NotFound = { error: "Diagram not found" | "Node not found" };

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite edge handles when a field id is renamed */
function rewriteHandlesForFieldRename(diagram: any, oldFieldId: string, newFieldId: string) {
  const from = new RegExp(`^${escapeRegExp(oldFieldId)}-(left|right)$`, "i");
  const to = (side: string) => `${newFieldId}-${side}`;
  for (const e of diagram.edges ?? []) {
    if (typeof e.sourceHandle === "string" && from.test(e.sourceHandle)) {
      const side = e.sourceHandle.toLowerCase().endsWith("left") ? "left" : "right";
      e.sourceHandle = to(side);
    }
    if (typeof e.targetHandle === "string" && from.test(e.targetHandle)) {
      const side = e.targetHandle.toLowerCase().endsWith("left") ? "left" : "right";
      e.targetHandle = to(side);
    }
  }
}

/** Drop edges referencing a field id (on delete) */
function removeEdgesTouchingField(diagram: any, fieldId: string) {
  const startsWith = new RegExp(`^${escapeRegExp(fieldId)}-(left|right)$`, "i");
  diagram.edges = (diagram.edges ?? []).filter(
    (e: any) => !(startsWith.test(e.sourceHandle || "") || startsWith.test(e.targetHandle || "")),
  );
}

/* Load a diagram and a specific node (subdoc), making sure data/schema exist and are cast correctly) */
export async function loadDiagramWithNode(
  diagramId: string,
  userId: string,
  nodeId: string,
): Promise<Loaded | NotFound> {
  // IMPORTANT: do not .lean() — we need Mongoose docs/subdocs
  const diagram = await Diagram.findOne({ _id: diagramId, userId });
  if (!diagram) return { error: "Diagram not found" };

  const node: any = (diagram.nodes ?? []).find((n: any) => n?.id === nodeId);
  if (!node) return { error: "Node not found" };

  // Use subdocument .set() so Mongoose casts arrays to DocumentArray (avoids TS2740)
  if (!node.data) {
    node.set?.("data", { label: "Table", schema: [] });
  } else if (!Array.isArray(node.data.schema)) {
    node.set?.("data.schema", []);
  }

  return { diagram, node };
}

// ---------- CRUD ----------

// GET /api/diagrams
export async function listMyDiagrams(req: Request, res: Response) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Diagram.find({ userId: req.user!.id }).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Diagram.countDocuments({ userId: req.user!.id }),
  ]);

  return res.json(ok({ items, page, limit, total, pages: Math.ceil(total / limit) }));
}

// GET /api/diagrams/:id
export async function getDiagram(req: Request, res: Response) {
  const doc = await Diagram.findOne({ _id: req.params.id, userId: req.user!.id }).lean();
  if (!doc) return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
  res.json(ok(doc));
}

// DELETE /api/diagrams/:id
export async function deleteDiagram(req: Request, res: Response) {
  const r = await Diagram.deleteOne({ _id: req.params.id, userId: req.user!.id });
  if (!r.deletedCount) return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
  res.json(ok({}));
}

// POST /api/diagrams  (create by metadata only: name + type [+ optional model])
export async function createDiagram(req: Request, res: Response) {
  const parsed = CreateDiagramReq.safeParse({ body: req.body });
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid diagram payload", "VALIDATION_ERROR"));
  }

  const { name, type, model } = parsed.data.body as {
    name: string;
    type: string;
    model?: CanonicalModel; // optional on create
  };

  const doc = await Diagram.create({
    userId: req.user!.id,
    title: name.trim(),
    type, // validated slug in Zod
    prompt: "",
    model: model as CanonicalModel, // default canonical model
    nodes: [],
    edges: [],
  });

  return res.status(201).json(ok(doc));
}

// PATCH /api/diagrams/:id
// - update metadata: name/type/title
// - update content: nodes/edges
// - OR generate via AI when body contains { prompt, model? }

export async function updateDiagram(req: Request, res: Response) {
  if (!UpdateDiagramReq || typeof (UpdateDiagramReq as any).safeParse !== "function") {
    console.error(
      "[DiagramCtrl] UpdateDiagramReq is undefined or not a Zod schema. Check imports.",
    );
    return res.status(500).json(fail("Server schema not loaded", "SERVER_CONFIG"));
  }

  const parsed = UpdateDiagramReq.safeParse({
    params: req.params,
    body: req.body,
  });
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid update", "VALIDATION_ERROR"));
  }

  const { id } = parsed.data.params;
  const { title, type, nodes, edges, prompt, model } = parsed.data.body;

  try {
    const existing = await Diagram.findOne({ _id: id, userId: req.user!.id });
    if (!existing) {
      return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
    }

    const updates: Record<string, any> = {};

    if (typeof title === "string" && title.trim()) updates.title = title.trim();
    if (typeof type === "string") updates.type = type;

    // If client sends nodes/edges, normalize to strict before saving
    if (Array.isArray(nodes) || Array.isArray(edges)) {
      const input = {
        nodes: Array.isArray(nodes) ? nodes : (existing.nodes as any[]),
        edges: Array.isArray(edges) ? edges : (existing.edges as any[]),
      };
      const strict = normalizeErd(input);
      updates.nodes = strict.nodes;
      updates.edges = strict.edges;
    }

    // AI generation path
    if (prompt && prompt.trim()) {
      if (!isValidErd(prompt)) {
        return res
          .status(400)
          .json(fail("Your prompt does not seem ERD-related.", "INVALID_ERD_PROMPT"));
      }

      const chosenModel = (model || existing.model) as CanonicalModel;

      try {
        const generated = await generateFromPrompt({
          prompt: prompt.trim(),
          model: chosenModel,
          titleOverride: title?.trim() || undefined,
        });

        // generated already normalized by ensureDiagramShape()
        updates.nodes = generated.nodes;
        updates.edges = generated.edges;
        updates.prompt = generated.prompt;
        updates.model = chosenModel;
      } catch (err: any) {
        console.error("[DiagramCtrl] updateDiagram:AI-path:error", err);
        const errMsg = err?.message || "AI generation failed";

        if (errMsg.includes("429") || /quota/i.test(errMsg)) {
          return res.status(429).json(fail(errMsg, "AI_QUOTA_EXCEEDED"));
        }
        if (err?.response?.status) {
          return res.status(err.response.status).json(fail(errMsg, "AI_FAILED"));
        }
        return res.status(502).json(fail(errMsg, "AI_FAILED"));
      }
    } else if (model) {
      updates.model = model;
    }

    if (Object.keys(updates).length === 0) {
      return res.json(ok(existing.toObject ? existing.toObject() : existing));
    }

    const doc = await Diagram.findByIdAndUpdate(
      existing._id,
      { $set: updates },
      { new: true },
    ).lean();
    return res.json(ok(doc));
  } catch (err) {
    return res.status(500).json(fail("Failed to update diagram", "SERVER_ERROR"));
  }
}

/**
 * GET /api/diagrams/:id/export.sql
 */

export async function exportDiagramSql(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const doc = await Diagram.findOne({ _id: id, userId: req.user!.id }).lean();
    if (!doc) return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));

    const rawErd = { nodes: (doc as any).nodes ?? [], edges: (doc as any).edges ?? [] };

    // Prefer strict validation. If it fails (old data), normalize on the fly.
    let erd: z.infer<typeof ZErdStrict>;
    const parsed = ZErdStrict.safeParse(rawErd);
    if (parsed.success) {
      erd = parsed.data;
    } else {
      erd = normalizeErd(rawErd); // ⬅️ upgrade legacy documents lacking markers
    }

    let dialect: DialectRenderer;
    try {
      dialect = pickDialect(req);
    } catch {
      return res.status(400).json(fail("Unsupported or invalid SQL dialect", "BAD_DIALECT"));
    }

    const schema =
      typeof req.query?.schema === "string" && dialect.supportsSchema()
        ? (req.query.schema as string)
        : "";

    const sql = erdToSql(erd, {
      dialect,
      schema,
      addIdentity: true,
      addFkIndexes: true,
      addNotNull: true,
      addTimestampsDefault: true,
    });

    const base = sanitizeFilename(
      (req.query.filename as string) || (doc as any).title || (doc as any).name || "diagram",
    );
    const fileName = `${base}.sql`;

    res.setHeader("Content-Type", "application/sql; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.send(sql);
  } catch (err) {
    res.status(500).json(fail("Failed to export SQL", "SERVER_ERROR"));
  }
}

/* ======================= Node Schema CRUD ======================= */

// POST /api/diagrams/:id/nodes/:nodeId/schema
export async function addNodeField(req: Request, res: Response) {
  const parsed = FieldCreateReq.safeParse({ params: req.params, body: req.body });
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid field payload", "VALIDATION_ERROR"));
  }
  const { id, nodeId } = parsed.data.params;
  const field = parsed.data.body;

  const loaded = await loadDiagramWithNode(id, req.user!.id, nodeId);
  if ("error" in loaded) return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
  const { diagram, node } = loaded;

  const exists = node.data!.schema.some((f: any) => f.id === field.id);
  if (exists) return res.status(409).json(fail("Field id already exists", "CONFLICT"));

  node.data!.schema.push({
    key: "NONE",
    nullable: true,
    default: null,
    ...field,
  });

  diagram.markModified("nodes");
  await diagram.save();
  return res.json(ok(diagram));
}

// PATCH /api/diagrams/:id/nodes/:nodeId/schema/:fieldId
export async function updateNodeField(req: Request, res: Response) {
  const parsed = FieldUpdateReq.safeParse({ params: req.params, body: req.body });
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid field update", "VALIDATION_ERROR"));
  }
  const { id, nodeId, fieldId } = parsed.data.params;
  const patch = parsed.data.body; // may include { id?, title?, type?, key? }

  const loaded = await loadDiagramWithNode(id, req.user!.id, nodeId);
  if ("error" in loaded) return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
  const { diagram, node } = loaded;

  const idx = node.data!.schema.findIndex((f: any) => f.id === fieldId);

  // ---------- UPSERT: Create if not found ----------
  if (idx === -1) {
    // For create, require these
    const newId = (patch.id ?? fieldId)?.trim();
    const title = patch.title?.trim();
    const type = patch.type?.trim();

    if (!newId || !title || !type) {
      return res
        .status(400)
        .json(fail("For new field, provide id, title and type.", "VALIDATION_ERROR"));
    }
    const dup = node.data!.schema.some((f: any) => f.id === newId);
    if (dup) return res.status(409).json(fail("Field id already exists", "CONFLICT"));

    node.data!.schema.push({
      id: newId,
      title,
      type,
      key: patch.key ?? "NONE",
      nullable: true,
      default: null,
    });

    diagram.markModified("nodes");
    await diagram.save();
    return res.json(ok(diagram));
  }

  // ---------- Update existing ----------
  const current = node.data!.schema[idx];

  // Renaming the id?
  if (patch.id && patch.id !== current.id) {
    const dup = node.data!.schema.some((f: any) => f.id === patch.id);
    if (dup) return res.status(409).json(fail("New field id already exists", "CONFLICT"));
    // rewrite edge handles from old id to new id
    rewriteHandlesForFieldRename(diagram, current.id, patch.id);
  }

  node.data!.schema[idx] = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.type !== undefined ? { type: patch.type } : {}),
    ...(patch.key !== undefined ? { key: patch.key } : {}),
    ...(patch.id !== undefined ? { id: patch.id } : {}),
  };

  diagram.markModified("nodes");
  await diagram.save();
  return res.json(ok(diagram));
}

// DELETE /api/diagrams/:id/nodes/:nodeId/schema/:fieldId
export async function deleteNodeField(req: Request, res: Response) {
  const parsed = FieldDeleteReq.safeParse({ params: req.params });
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid request", "VALIDATION_ERROR"));
  }
  const { id, nodeId, fieldId } = parsed.data.params;

  const loaded = await loadDiagramWithNode(id, req.user!.id, nodeId);
  if ("error" in loaded) return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
  const { diagram, node } = loaded;

  const before = node.data!.schema.length;
  node.data!.schema = node.data!.schema.filter((f: any) => f.id !== fieldId);
  if (node.data!.schema.length === before) {
    return res.status(404).json(fail("Field not found", "NOT_FOUND"));
  }

  removeEdgesTouchingField(diagram, fieldId);

  diagram.markModified("nodes");
  await diagram.save();
  return res.json(ok(diagram));
}

// PATCH /api/diagrams/:id/nodes/:nodeId/schema/reorder
export async function reorderNodeFields(req: Request, res: Response) {
  const parsed = FieldReorderReq.safeParse({ params: req.params, body: req.body });
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid reorder payload", "VALIDATION_ERROR"));
  }
  const { id, nodeId } = parsed.data.params;
  const { order } = parsed.data.body;

  const loaded = await loadDiagramWithNode(id, req.user!.id, nodeId);
  if ("error" in loaded) return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
  const { diagram, node } = loaded;

  const byId = new Map(node.data!.schema.map((f: any) => [f.id, f]));
  const reordered: any[] = [];
  for (const fid of order) {
    const f = byId.get(fid);
    if (f) reordered.push(f);
  }
  for (const f of node.data!.schema) {
    if (!order.includes(f.id)) reordered.push(f);
  }

  node.data!.schema = reordered;

  diagram.markModified("nodes");
  await diagram.save();
  return res.json(ok(diagram));
}

// PATCH /api/diagrams/:id/nodes/:nodeId/label
export async function updateNodeLabel(req: Request, res: Response) {
  const parsed = NodeLabelUpdateReq.safeParse({ params: req.params, body: req.body });
  if (!parsed.success) {
    return res.status(400).json(fail("Invalid label payload", "VALIDATION_ERROR"));
  }
  const { id, nodeId } = parsed.data.params;
  const { label } = parsed.data.body;

  const loaded = await loadDiagramWithNode(id, req.user!.id, nodeId);
  if ("error" in loaded) return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
  const { diagram, node } = loaded;

  node.data!.label = label;

  diagram.markModified("nodes");
  await diagram.save();
  return res.json(ok(diagram));
}
