import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { ok, fail } from "../utils/http";
import { DiagramModel } from "../models/diagram.model";
import {
  CreateDiagramReq,
  FieldCreateReq,
  FieldDeleteReq,
  FieldReorderReq,
  FieldUpdateReq,
  NodeLabelUpdateReq,
  UpdateDiagramReq,
} from "../schemas/diagram.schema";
import { normalizeErd, ZErdStrict } from "../schemas/erd-ai";
import { isValidErd } from "../libs/isValidErd";
import { getOwnerFilter } from "../services/diagrams/owner";
import { composePrompt, tailForPrompt } from "../services/diagrams/prompt";
import {
  applyOpsInMemory,
  toCanonicalKey,
  rewriteHandlesForFieldRename,
  removeEdgesTouchingField,
} from "../services/diagrams/ops";
import { hedgedGenerate } from "../services/diagrams/ai";
import { loadDiagramWithNode } from "../services/diagrams/node-loader";
import { buildSqlExport } from "../services/diagrams/sql";

/* ---------------------------- chat types ---------------------------- */
type ChatRole = "user" | "assistant" | "system";
type ChatMessage = { role: ChatRole; content: string; ts: number };

/* ============================= CRUD ============================= */

export async function listMyDiagrams(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const owner = getOwnerFilter(req);
    const [items, total] = await Promise.all([
      DiagramModel.find(owner).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      DiagramModel.countDocuments(owner),
    ]);

    return res.json(ok({ items, page, limit, total, pages: Math.ceil(total / limit) }));
  } catch (err) {
    console.error("[listMyDiagrams] error:", err);
    return next(err);
  }
}

export async function getDiagram(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json(fail("Invalid diagram id", "BAD_ID"));
    }
    const owner = getOwnerFilter(req);
    const doc = await DiagramModel.findOne({ _id: new Types.ObjectId(id), ...owner }).lean();
    if (!doc) return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
    return res.json(ok(doc));
  } catch (err) {
    console.error("[getDiagram] error:", err);
    return res.status(500).json(fail("Failed to fetch diagram", "SERVER_ERROR"));
  }
}

export async function deleteDiagram(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json(fail("Invalid diagram id", "BAD_ID"));
    }
    const owner = getOwnerFilter(req);
    const r = await DiagramModel.deleteOne({ _id: new Types.ObjectId(id), ...owner });
    if (!r.deletedCount) return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
    return res.json(ok({}));
  } catch (err) {
    console.error("[deleteDiagram] error:", err);
    return res.status(500).json(fail("Failed to delete diagram", "SERVER_ERROR"));
  }
}

export async function createDiagram(req: Request, res: Response) {
  try {
    const parsed = CreateDiagramReq.safeParse({ body: req.body });
    if (!parsed.success) {
      return res.status(400).json(fail("Invalid diagram payload", "VALIDATION_ERROR"));
    }

    const { name, type, model } = parsed.data.body as {
      name: string;
      type: string;
      model?: string;
    };

    const owner = getOwnerFilter(req);
    const user = (req as any).user;
    const isGuest = !user?.id;

    if (isGuest) {
      const aid = req.signedCookies?.aid as string | undefined;
      if (!aid) return res.status(400).json(fail("Missing anon id", "MISSING_AID"));
      const count = await DiagramModel.countDocuments({ ownerAnonId: aid });
      if (count >= 4) {
        return res
          .status(403)
          .json(
            fail("Guest diagram limit reached (4). Please sign in to create more.", "GUEST_LIMIT"),
          );
      }
    } else if (user.plan === "free") {
      const count = await DiagramModel.countDocuments({ userId: user.id });
      if (count >= 10) {
        return res
          .status(403)
          .json(
            fail("Free plan limit reached (10 diagrams). Upgrade to create more.", "FREE_LIMIT"),
          );
      }
    }

    const doc = await DiagramModel.create({
      ...owner,
      title: name.trim(),
      type,
      prompt: "",
      model: (model as any) ?? "gemini-2.5-flash-lite",
      nodes: [],
      edges: [],
      chat: [],
      version: 0,
    });

    return res.status(201).json(ok(doc));
  } catch (err) {
    console.error("[createDiagram] error:", err);
    return res.status(500).json(fail("Failed to create diagram", "SERVER_ERROR"));
  }
}

/* --------------------- UPDATE (chat integrated) --------------------- */

export async function updateDiagram(req: Request, res: Response) {
  if (!UpdateDiagramReq || typeof (UpdateDiagramReq as any).safeParse !== "function") {
    console.error("[DiagramCtrl] UpdateDiagramReq missing/invalid");
    return res.status(500).json(fail("Server schema not loaded", "SERVER_CONFIG"));
  }
  const parsed = UpdateDiagramReq.safeParse({ params: req.params, body: req.body });
  if (!parsed.success) return res.status(400).json(fail("Invalid update", "VALIDATION_ERROR"));

  const { id } = parsed.data.params;
  const { title, type, nodes, edges, prompt, model } = parsed.data.body as any;
  const clientVersion: number | undefined = (parsed.data.body as any).version;

  try {
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json(fail("Invalid diagram id", "BAD_ID"));
    }

    const owner = getOwnerFilter(req);
    const existing = await DiagramModel.findOne({ _id: new Types.ObjectId(id), ...owner });
    if (!existing) return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));

    const updates: Record<string, any> = {};
    if (typeof title === "string" && title.trim()) updates.title = title.trim();
    if (typeof type === "string") updates.type = type;

    // Manual nodes/edges
    if (Array.isArray(nodes) || Array.isArray(edges)) {
      const input = {
        nodes: Array.isArray(nodes) ? nodes : (existing.nodes as any[]),
        edges: Array.isArray(edges) ? edges : (existing.edges as any[]),
      };
      const strict = normalizeErd(input);

      const doc = await DiagramModel.findOneAndUpdate(
        { _id: existing._id, version: existing.version ?? 0 },
        { $set: { ...updates, nodes: strict.nodes, edges: strict.edges }, $inc: { version: 1 } },
        { new: true },
      ).lean();

      if (!doc) return res.status(409).json(fail("Version conflict", "CONFLICT"));
      return res.json(ok(doc));
    }

    // AI generation path
    if (prompt && prompt.trim()) {
      if (!isValidErd(prompt)) {
        return res
          .status(400)
          .json(fail("Your prompt does not seem ERD-related.", "INVALID_ERD_PROMPT"));
      }

      const chosenModel = (model || (existing as any).model) as any;
      const baseVersion =
        typeof clientVersion === "number" ? clientVersion : (existing.version ?? 0);

      const prevChat: ChatMessage[] = Array.isArray((existing as any).chat)
        ? ((existing as any).chat as ChatMessage[])
        : [];

      const now = Date.now();
      const userMsg: ChatMessage = { role: "user", content: prompt.trim(), ts: now };
      const ackMsg: ChatMessage = {
        role: "assistant",
        content: "Got it. Generating your ERD… You can refine with another message.",
        ts: now + 1,
      };
      const workingChat: ChatMessage[] = [...prevChat, userMsg, ackMsg].slice(-100);

      const chatTail = tailForPrompt(workingChat, 6);
      const composed = composePrompt(
        (existing as any).toObject ? (existing as any).toObject() : existing,
        prompt,
        chatTail,
      );

      let nextNodes: any[] = [];
      let nextEdges: any[] = [];

      try {
        const ai = await hedgedGenerate(composed, chosenModel);

        if (Array.isArray(ai?.ops)) {
          const normalizedOps = ai.ops.map((o: any) =>
            o?.op === "add_field" ? { ...o, key: toCanonicalKey(o.key) } : o,
          );
          const applied = applyOpsInMemory(
            (existing as any).toObject ? (existing as any).toObject() : existing,
            normalizedOps,
          );
          const strict = normalizeErd(applied);
          nextNodes = strict.nodes;
          nextEdges = strict.edges;
        } else {
          const strict = normalizeErd({ nodes: ai?.nodes ?? [], edges: ai?.edges ?? [] });
          nextNodes = strict.nodes;
          nextEdges = strict.edges;
        }

        const doc = await DiagramModel.findOneAndUpdate(
          { _id: existing._id, version: baseVersion },
          {
            $set: {
              ...(title ? { title: title.trim() } : {}),
              ...(type ? { type } : {}),
              nodes: nextNodes,
              edges: nextEdges,
              prompt: prompt.trim(),
              model: chosenModel,
              chat: workingChat,
            },
            $inc: { version: 1 },
          },
          { new: true },
        ).lean();

        if (!doc) return res.status(409).json(fail("Version conflict", "CONFLICT"));
        return res.json(ok(doc));
      } catch (err: any) {
        console.error("[updateDiagram:AI] error:", err);
        const errMsg = err?.message || "AI generation failed";

        const finalChat = [
          ...workingChat,
          { role: "assistant", content: `There was an error: ${errMsg}`, ts: Date.now() },
        ].slice(-100);

        await DiagramModel.findOneAndUpdate(
          { _id: existing._id, version: baseVersion },
          {
            $set: {
              ...(title ? { title: title.trim() } : {}),
              ...(type ? { type } : {}),
              prompt: prompt.trim(),
              model: chosenModel,
              chat: finalChat,
            },
            $inc: { version: 1 },
          },
          { new: true },
        )
          .lean()
          .catch(() => {});

        if (errMsg.includes("429") || /quota/i.test(errMsg)) {
          return res.status(429).json(fail(errMsg, "AI_QUOTA_EXCEEDED"));
        }
        if (err?.response?.status) {
          return res.status(err.response.status).json(fail(errMsg, "AI_FAILED"));
        }
        return res.status(502).json(fail(errMsg, "AI_FAILED"));
      }
    }

    if (model) updates.model = model;

    if (Object.keys(updates).length === 0) {
      return res.json(ok((existing as any).toObject ? (existing as any).toObject() : existing));
    }

    const doc = await DiagramModel.findOneAndUpdate(
      { _id: existing._id, version: (existing as any).version ?? 0 },
      { $set: updates, $inc: { version: 1 } },
      { new: true },
    ).lean();

    if (!doc) return res.status(409).json(fail("Version conflict", "CONFLICT"));
    return res.json(ok(doc));
  } catch (err) {
    console.error("[updateDiagram] error:", err);
    return res.status(500).json(fail("Failed to update diagram", "SERVER_ERROR"));
  }
}

/* -------------------------- SQL export route ------------------------- */

export async function exportDiagramSql(req: Request, res: Response) {
  try {
    const out = await buildSqlExport(req);

    if (out.error) {
      // out is SqlExportError here (narrowed by discriminator)
      return res.status(out.status).json(fail(out.message, out.code));
    }

    // out is SqlExportSuccess here
    res.setHeader("Content-Type", out.contentType);
    res.setHeader("Content-Disposition", out.disposition);
    res.send(out.body);
  } catch (err) {
    console.error("[exportDiagramSql] error:", err);
    return res.status(500).json(fail("Failed to export SQL", "SERVER_ERROR"));
  }
}

/* ======================= Node Schema CRUD ======================= */

export async function addNodeField(req: Request, res: Response) {
  const parsed = FieldCreateReq.safeParse({ params: req.params, body: req.body });
  if (!parsed.success)
    return res.status(400).json(fail("Invalid field payload", "VALIDATION_ERROR"));

  const { id, nodeId } = parsed.data.params;
  const field = parsed.data.body;

  const loaded = await loadDiagramWithNode(req, id, nodeId);
  if ("error" in loaded) return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
  const { diagram, node } = loaded;

  const exists = node.data!.schema.some((f: any) => f.id === field.id);
  if (exists) return res.status(409).json(fail("Field id already exists", "CONFLICT"));

  node.data!.schema.push({ key: "NONE", nullable: true, default: null, ...field });
  diagram.markModified("nodes");
  await diagram.save();
  return res.json(ok(diagram));
}

export async function updateNodeField(req: Request, res: Response) {
  const parsed = FieldUpdateReq.safeParse({ params: req.params, body: req.body });
  if (!parsed.success)
    return res.status(400).json(fail("Invalid field update", "VALIDATION_ERROR"));

  const { id, nodeId, fieldId } = parsed.data.params;
  const patch = parsed.data.body;

  const loaded = await loadDiagramWithNode(req, id, nodeId);
  if ("error" in loaded) return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
  const { diagram, node } = loaded;

  const idx = node.data!.schema.findIndex((f: any) => f.id === fieldId);

  // upsert
  if (idx === -1) {
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

  const current = node.data!.schema[idx];

  if (patch.id && patch.id !== current.id) {
    const dup = node.data!.schema.some((f: any) => f.id === patch.id);
    if (dup) return res.status(409).json(fail("New field id already exists", "CONFLICT"));
    rewriteHandlesForFieldRename(diagram as any, current.id, patch.id);
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

export async function deleteNodeField(req: Request, res: Response) {
  const parsed = FieldDeleteReq.safeParse({ params: req.params });
  if (!parsed.success) return res.status(400).json(fail("Invalid request", "VALIDATION_ERROR"));

  const { id, nodeId, fieldId } = parsed.data.params;
  const loaded = await loadDiagramWithNode(req, id, nodeId);
  if ("error" in loaded) return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
  const { diagram, node } = loaded;

  const before = node.data!.schema.length;
  node.data!.schema = node.data!.schema.filter((f: any) => f.id !== fieldId);
  if (node.data!.schema.length === before) {
    return res.status(404).json(fail("Field not found", "NOT_FOUND"));
  }

  removeEdgesTouchingField(diagram as any, fieldId);
  diagram.markModified("nodes");
  await diagram.save();
  return res.json(ok(diagram));
}

export async function reorderNodeFields(req: Request, res: Response) {
  const parsed = FieldReorderReq.safeParse({ params: req.params, body: req.body });
  if (!parsed.success)
    return res.status(400).json(fail("Invalid reorder payload", "VALIDATION_ERROR"));

  const { id, nodeId } = parsed.data.params;
  const { order } = parsed.data.body;

  const loaded = await loadDiagramWithNode(req, id, nodeId);
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

export async function updateNodeLabel(req: Request, res: Response) {
  const parsed = NodeLabelUpdateReq.safeParse({ params: req.params, body: req.body });
  if (!parsed.success)
    return res.status(400).json(fail("Invalid label payload", "VALIDATION_ERROR"));

  const { id, nodeId } = parsed.data.params;
  const { label } = parsed.data.body;

  const loaded = await loadDiagramWithNode(req, id, nodeId);
  if ("error" in loaded) return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
  const { diagram, node } = loaded;

  node.data!.label = label;
  diagram.markModified("nodes");
  await diagram.save();
  return res.json(ok(diagram));
}
