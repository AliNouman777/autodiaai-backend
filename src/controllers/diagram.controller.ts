import type { Request, Response } from "express";
import Diagram from "../models/diagram.model";
import { ok, fail } from "../utils/http";
import { GenerateDiagramReq, DiagramPayload, UpdateDiagramReq } from "../schemas/diagram.schema";
import { getProvider, validateDiagram, SYSTEM_PROMPT } from "../services/ai";
import aicacheModel from "../models/aicache.model";
import * as nodeCrypto from "node:crypto";

// GET /api/diagrams
export async function listMyDiagrams(req: Request, res: Response) {
  const items = await Diagram.find({ userId: req.user!.id }).sort({ createdAt: -1 }).lean();
  res.json(ok({ items }));
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

// POST /api/diagrams  (save client-provided JSON)
export async function createDiagram(req: Request, res: Response) {
  const parsed = DiagramPayload.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json(fail("Invalid diagram payload", "VALIDATION_ERROR"));
  const { title, nodes, edges } = parsed.data;
  const doc = await Diagram.create({
    userId: req.user!.id,
    title: title || "Untitled Diagram",
    prompt: "(manual)",
    model: "gpt5",
    nodes,
    edges,
  });
  res.status(201).json(ok(doc));
}

// PATCH /api/diagrams/:id (partial)
export async function updateDiagram(req: Request, res: Response) {
  const parsed = UpdateDiagramReq.safeParse({ body: req.body });
  if (!parsed.success) return res.status(400).json(fail("Invalid update", "VALIDATION_ERROR"));
  const update: any = {};
  if (req.body.title) update.title = req.body.title;
  if (req.body.nodes) update.nodes = req.body.nodes;
  if (req.body.edges) update.edges = req.body.edges;

  const doc = await Diagram.findOneAndUpdate(
    { _id: req.params.id, userId: req.user!.id },
    { $set: update },
    { new: true },
  ).lean();
  if (!doc) return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
  res.json(ok(doc));
}

// POST /api/diagrams/generate

/** very small guard so we don't save junk */
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
  const normPrompt = prompt.trim().replace(/\s+/g, " ");
  return `${model}::` + nodeCrypto.createHash("sha256").update(normPrompt).digest("hex");
}

/**
 * POST /api/diagrams/generate
 * body: { prompt: string; model: "gpt5"|"gemini"; title?: string }
 */
export async function generateDiagram(req: Request, res: Response) {
  // super minimal validation
  const prompt = String(req.body?.prompt || "").trim();
  const model = (req.body?.model as "gpt5" | "gemini") || "gpt5";
  const titleOverride = typeof req.body?.title === "string" ? req.body.title.trim() : "";

  if (!prompt) return res.status(400).json(fail("prompt is required", "VALIDATION_ERROR"));
  if (!["gpt5", "gemini"].includes(model))
    return res.status(400).json(fail("invalid model", "VALIDATION_ERROR"));

  const key = makeKey(model, prompt);

  try {
    // 1) try cache (global cache across users)
    const hit = await aicacheModel.findOne({ key }).lean();
    if (hit) {
      const diagram = ensureDiagramShape(hit.payload);
      if (titleOverride) diagram.title = titleOverride;

      const doc = await Diagram.create({
        userId: req.user!.id,
        title: diagram.title,
        prompt,
        model,
        nodes: diagram.nodes,
        edges: diagram.edges,
      });

      return res.status(201).json(ok(doc));
    }

    // 2) call provider (OpenAI/Gemini)
    const provider = getProvider(model);
    const raw = await provider.generate(prompt);

    const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);

    // 3) parse → shape guard (kept tiny & forgiving)
    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // fallback: try to extract {...} if model wrapped in prose/fences
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");
      if (start >= 0 && end > start) parsed = JSON.parse(rawText.slice(start, end + 1));
      else throw new Error("AI did not return JSON");
    }
    const diagram = ensureDiagramShape(parsed);
    if (titleOverride) diagram.title = titleOverride;

    // 4) save to cache (so next same prompt/model skips LLM)
    await aicacheModel.create({ key, raw: rawText, payload: diagram });

    // 5) save user doc
    const doc = await Diagram.create({
      userId: req.user!.id,
      title: diagram.title,
      prompt,
      model,
      nodes: diagram.nodes,
      edges: diagram.edges,
    });

    return res.status(201).json(ok(doc));
  } catch (err: any) {
    return res.status(502).json(fail(err?.message || "AI failed", "AI_FAILED"));
  }
}
