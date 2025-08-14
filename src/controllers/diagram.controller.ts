import type { Request, Response } from "express";
import Diagram from "../models/diagram.model";
import { ok, fail } from "../utils/http";
import { CreateDiagramReq, UpdateDiagramReq } from "../schemas/diagram.schema";
import { getProviderFor, type CanonicalModel } from "../services/ai";
import aicacheModel from "../models/aicache.model";
import * as nodeCrypto from "node:crypto";
import { isValidErd } from "../libs/isValidErd";

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
  return { title, nodes: obj.nodes, edges: obj.edges };
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
    const diagram = ensureDiagramShape(hit.payload);
    if (titleOverride) diagram.title = titleOverride;
    return { ...diagram, prompt, model };
  }

  // 2) Call provider (passes exact canonical model)
  const provider = getProviderFor(model);
  const raw = await provider.generate(prompt, model);
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);

  // 3) Parse JSON (tolerant)
  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const s = rawText.indexOf("{");
    const e = rawText.lastIndexOf("}");
    if (s >= 0 && e > s) parsed = JSON.parse(rawText.slice(s, e + 1));
    else throw new Error("AI did not return JSON");
  }
  const diagram = ensureDiagramShape(parsed);
  if (titleOverride) diagram.title = titleOverride;

  // 4) Save cache
  await aicacheModel.create({ key, raw: rawText, payload: diagram });

  return { ...diagram, prompt, model };
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
    model: (model as CanonicalModel) , // default canonical model
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
  const parsed = UpdateDiagramReq.safeParse({
    params: req.params,
    body: req.body
  });

  if (!parsed.success) {
    return res.status(400).json(fail("Invalid update", "VALIDATION_ERROR"));
  }

  const { id } = parsed.data.params;
  const { name, title, type, nodes, edges, prompt, model } = parsed.data.body;

  try {
    const existing = await Diagram.findOne({ _id: id, userId: req.user!.id });
    if (!existing) {
      return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
    }

    const updates: Record<string, any> = {};

    if (typeof title === "string" && title.trim()) updates.title = title.trim();
    if (typeof type === "string") updates.type = type;
    if (Array.isArray(nodes)) updates.nodes = nodes;
    if (Array.isArray(edges)) updates.edges = edges;

    // AI generation path
    if (prompt && prompt.trim()) {
      if (!isValidErd(prompt)) {
        return res.status(400).json(fail("Your prompt does not seem ERD-related.", "INVALID_ERD_PROMPT"));
      }

      const chosenModel = model || existing.model || "gpt-5";

      try {
        const generated = await generateFromPrompt({
          prompt: prompt.trim(),
          model: chosenModel,
          titleOverride: title?.trim() || undefined,
        });

        updates.nodes = generated.nodes;
        updates.edges = generated.edges;
        updates.prompt = generated.prompt;
        updates.model = chosenModel;

      } catch (err: any) {
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
      { new: true }
    ).lean();

    return res.json(ok(doc));

  } catch (err) {
    console.error("Update diagram error:", err);
    return res.status(500).json(fail("Failed to update diagram", "SERVER_ERROR"));
  }
}



