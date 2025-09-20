// src/controllers/diagram.controller.ts
import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { ok, fail } from "../utils/http";
import { DiagramModel } from "../models/diagram.model";
import {
  CreateDiagramReq,
  FieldCreateReq,
  FieldDeleteReq,
  FieldUpdateReq,
  NodeLabelUpdateReq,
  UpdateDiagramReq,
} from "../schemas/diagram.schema";
import { normalizeErd } from "../schemas/erd-ai";
import { isValidErd } from "../libs/isValidErd";
import { getOwnerFilter } from "../services/diagrams/owner";
import { composePrompt, tailForPrompt } from "../services/diagrams/prompt";
import {
  applyOpsInMemory,
  toCanonicalKey,
  rewriteHandlesForFieldRename,
  removeEdgesTouchingField,
} from "../services/diagrams/ops";
import { hedgedGenerate, hedgedGenerateStream } from "../services/diagrams/ai";
import { loadDiagramWithNode } from "../services/diagrams/node-loader";
import { buildSqlExport } from "../services/diagrams/sql";

/* ---------------------------- chat types ---------------------------- */
type ChatRole = "user" | "assistant" | "system";
type ChatMessage = { role: ChatRole; content: string; ts: number };

/* ---------------------- assistant message helper --------------------- */
function buildAssistantSummary({
  nodes,
  edges,
  prompt,
}: {
  nodes: any[];
  edges: any[];
  prompt: string;
}) {
  const tableNames = nodes.map((n: any) => n?.data?.label || n?.id).filter(Boolean);
  const relCount = edges.length;
  const fieldsPerTable = nodes.map((n: any) => ({
    table: n?.data?.label || n?.id,
    fields: (n?.data?.schema ?? []).length,
    pks: (n?.data?.schema ?? []).filter((f: any) => f.key === "PK").length,
    fks: (n?.data?.schema ?? []).filter((f: any) => f.key === "FK").length,
  }));

  const top = tableNames.slice(0, 5).join(", ") + (tableNames.length > 5 ? "…" : "");
  const lines: string[] = [];
  lines.push(`Here’s the ERD based on your request:`);
  if (prompt?.trim()) lines.push(`> "${prompt.trim()}"`);
  lines.push("");
  lines.push(`• Tables: ${nodes.length}${tableNames.length ? ` — ${top}` : ""}`);
  lines.push(`• Relationships: ${relCount}`);
  lines.push(
    ...fieldsPerTable
      .slice(0, 5)
      .map(
        (r) => `  - ${r.table}: ${r.fields} fields (PK:${r.pks}${r.fks ? `, FK:${r.fks}` : ""})`,
      ),
  );
  if (fieldsPerTable.length > 5) lines.push(`  - …and ${fieldsPerTable.length - 5} more tables`);
  lines.push("");
  lines.push(`You can ask me to rename tables/fields, add columns, or change relationships.`);
  return lines.join("\n");
}

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

    // Manual nodes/edges path
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

      const chosenModel = (model || (existing as any).model || "gemini-2.5-flash-lite") as any;
      const baseVersion =
        typeof clientVersion === "number" ? clientVersion : (existing.version ?? 0);

      const prevChat: ChatMessage[] = Array.isArray((existing as any).chat)
        ? ((existing as any).chat as ChatMessage[])
        : [];

      const now = Date.now();
      const userMsg: ChatMessage = { role: "user", content: prompt.trim(), ts: now };

      // ❌ Do NOT append a static ack; rely on frontend spinner instead
      const workingChat: ChatMessage[] = [...prevChat, userMsg].slice(-100);

      const chatTail = tailForPrompt(workingChat, 6);
      const composed = composePrompt(
        (existing as any).toObject ? (existing as any).toObject() : existing,
        prompt,
        chatTail,
      );

      let nextNodes: any[] = [];
      let nextEdges: any[] = [];
      let assistantMessage: string | undefined;

      try {
        // ai can be {nodes, edges, message?} or {ops, message?}
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

        // Build a human-readable assistant message (fallback if provider doesn't supply one)
        assistantMessage =
          (ai as any)?.message ||
          buildAssistantSummary({ nodes: nextNodes, edges: nextEdges, prompt: prompt.trim() });

        const finalChat = [
          ...workingChat,
          { role: "assistant", content: assistantMessage, ts: Date.now() },
        ].slice(-100);

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
              chat: finalChat,
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
      return res.status(out.status).json(fail(out.message, out.code));
    }

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

/* --------------------- STREAMING UPDATE (chat integrated) --------------------- */

export async function updateDiagramStream(req: Request, res: Response) {
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

    // Manual nodes/edges path - not supported in streaming
    if (Array.isArray(nodes) || Array.isArray(edges)) {
      return res
        .status(400)
        .json(fail("Manual updates not supported in streaming mode", "NOT_SUPPORTED"));
    }

    // AI generation path
    if (prompt && prompt.trim()) {
      if (!isValidErd(prompt)) {
        return res
          .status(400)
          .json(fail("Your prompt does not seem ERD-related.", "INVALID_ERD_PROMPT"));
      }

      const chosenModel = (model || (existing as any).model || "gemini-2.5-flash-lite") as any;
      const baseVersion =
        typeof clientVersion === "number" ? clientVersion : (existing.version ?? 0);

      const prevChat: ChatMessage[] = Array.isArray((existing as any).chat)
        ? ((existing as any).chat as ChatMessage[])
        : [];

      const now = Date.now();
      const userMsg: ChatMessage = { role: "user", content: prompt.trim(), ts: now };
      const workingChat: ChatMessage[] = [...prevChat, userMsg].slice(-100);

      const chatTail = tailForPrompt(workingChat, 6);
      const composed = composePrompt(
        (existing as any).toObject ? (existing as any).toObject() : existing,
        prompt,
        chatTail,
      );

      // Check if client wants streaming (Accept header or query param)
      const wantsStreaming =
        req.headers.accept?.includes("text/event-stream") || req.query.stream === "true";

      if (wantsStreaming) {
        // Set up Server-Sent Events
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, Cache-Control, Accept",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Credentials", "true");

        const sendSSE = (data: any) => {
          try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (error) {
            console.log("Client disconnected, stopping stream");
            throw error;
          }
        };

        // Handle client disconnect
        req.on("close", () => {
          console.log("Client disconnected from streaming endpoint");
        });

        try {
          sendSSE({ type: "start", message: "Starting AI generation..." });

          let nextNodes: any[] = [];
          let nextEdges: any[] = [];
          let assistantMessage: string | undefined;
          let isComplete = false;

          // Start heartbeat to keep connection alive
          const heartbeatInterval = setInterval(() => {
            if (!isComplete) {
              sendSSE({ type: "heartbeat", data: { timestamp: Date.now() } });
            }
          }, 5000); // Send heartbeat every 5 seconds

          try {
            for await (const chunk of hedgedGenerateStream(composed, chosenModel)) {
              if (chunk.type === "progress") {
                sendSSE({ type: "progress", data: chunk.data });
              } else if (chunk.type === "partial") {
                sendSSE({ type: "partial", data: chunk.data });
              } else if (chunk.type === "heartbeat") {
                sendSSE({ type: "heartbeat", data: chunk.data });
              } else if (chunk.type === "complete") {
                isComplete = true;
                clearInterval(heartbeatInterval);

                if (chunk.error) {
                  sendSSE({ type: "error", error: chunk.error });
                  res.end();
                  return;
                }

                const ai = chunk.data as any;
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

                assistantMessage =
                  ai?.message ||
                  buildAssistantSummary({
                    nodes: nextNodes,
                    edges: nextEdges,
                    prompt: prompt.trim(),
                  });

                const finalChat = [
                  ...workingChat,
                  { role: "assistant", content: assistantMessage, ts: Date.now() },
                ].slice(-100);

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
                      chat: finalChat,
                    },
                    $inc: { version: 1 },
                  },
                  { new: true },
                ).lean();

                if (!doc) {
                  sendSSE({ type: "error", error: "Version conflict" });
                  res.end();
                  return;
                }

                sendSSE({ type: "complete", data: doc });
                res.end();
                return;
              }
            }
          } finally {
            clearInterval(heartbeatInterval);
          }
        } catch (err: any) {
          console.error("[updateDiagramStream:AI] error:", err);
          let errMsg = err?.message || "AI generation failed";

          // Provide more helpful error messages for common issues
          if (errMsg.includes("Invalid diagram JSON")) {
            errMsg =
              "The AI generated an invalid diagram structure. Please try again with a different prompt.";
          } else if (errMsg.includes("Empty response")) {
            errMsg = "The AI didn't generate any content. Please try again.";
          } else if (errMsg.includes("timeout")) {
            errMsg = "The AI request timed out. Please try again.";
          } else if (errMsg.includes("quota") || errMsg.includes("429")) {
            errMsg = "AI service quota exceeded. Please try again later.";
          }

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

          sendSSE({ type: "error", error: errMsg });
          res.end();
          return;
        }
      } else {
        // Regular JSON response - collect all streaming data and return at once
        try {
          let nextNodes: any[] = [];
          let nextEdges: any[] = [];
          let assistantMessage: string | undefined;
          let hasError = false;
          let errorMessage = "";

          for await (const chunk of hedgedGenerateStream(composed, chosenModel)) {
            if (chunk.type === "complete") {
              if (chunk.error) {
                hasError = true;
                errorMessage = chunk.error;
                break;
              }

              const ai = chunk.data as any;
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

              assistantMessage =
                ai?.message ||
                buildAssistantSummary({
                  nodes: nextNodes,
                  edges: nextEdges,
                  prompt: prompt.trim(),
                });
              break;
            }
          }

          if (hasError) {
            const finalChat = [
              ...workingChat,
              { role: "assistant", content: `There was an error: ${errorMessage}`, ts: Date.now() },
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

            return res.status(502).json(fail(errorMessage, "AI_FAILED"));
          }

          const finalChat = [
            ...workingChat,
            { role: "assistant", content: assistantMessage, ts: Date.now() },
          ].slice(-100);

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
                chat: finalChat,
              },
              $inc: { version: 1 },
            },
            { new: true },
          ).lean();

          if (!doc) return res.status(409).json(fail("Version conflict", "CONFLICT"));
          return res.json(ok(doc));
        } catch (err: any) {
          console.error("[updateDiagramStream:AI] error:", err);
          let errMsg = err?.message || "AI generation failed";

          // Provide more helpful error messages for common issues
          if (errMsg.includes("Invalid diagram JSON")) {
            errMsg =
              "The AI generated an invalid diagram structure. Please try again with a different prompt.";
          } else if (errMsg.includes("Empty response")) {
            errMsg = "The AI didn't generate any content. Please try again.";
          } else if (errMsg.includes("timeout")) {
            errMsg = "The AI request timed out. Please try again.";
          } else if (errMsg.includes("quota") || errMsg.includes("429")) {
            errMsg = "AI service quota exceeded. Please try again later.";
          }

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
    }

    // If no prompt, return existing diagram
    if (prompt && prompt.trim()) {
      // This case is handled above in the AI generation path
    } else {
      // For non-AI updates, return regular JSON response
      return res.json(ok((existing as any).toObject ? (existing as any).toObject() : existing));
    }
  } catch (err) {
    console.error("[updateDiagramStream] error:", err);
    res.status(500).json(fail("Failed to update diagram", "SERVER_ERROR"));
  }
}
