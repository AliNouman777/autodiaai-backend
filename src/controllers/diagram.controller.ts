/**
 * Diagram Controller - Production-level diagram management
 *
 * This module handles all diagram CRUD operations, AI generation, and streaming updates.
 * It provides comprehensive error handling, input validation, and logging.
 *
 * @author AutoDiaAI Team
 * @version 2.0.0
 */

import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { ok, fail } from "../utils/http";
import { DiagramModel, type DiagramDoc } from "../models/diagram.model";
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
import logger from "../libs/logger";

/* ============================= CONSTANTS ============================= */

/** Default AI model for diagram generation */
const DEFAULT_MODEL = "gemini-2.5-flash-lite" as const;

/** Maximum number of diagrams for guest users */
const GUEST_DIAGRAM_LIMIT = 4;

/** Maximum number of diagrams for free plan users */
const FREE_PLAN_DIAGRAM_LIMIT = 10;

/** Maximum chat history to keep */
const MAX_CHAT_HISTORY = 100;

/** Maximum chat tail for prompt composition */
const MAX_CHAT_TAIL = 6;

/** Heartbeat interval for streaming connections (ms) */
const HEARTBEAT_INTERVAL = 5000;

/** Request timeout for AI generation (ms) */
const AI_GENERATION_TIMEOUT = 180000;

/* ============================= TYPES ============================= */

/** Chat message roles */
type ChatRole = "user" | "assistant" | "system";

/** Chat message structure */
interface ChatMessage {
  role: ChatRole;
  content: string;
  ts: number;
}

/** AI generation result */
interface AIGenerationResult {
  nodes?: any[];
  edges?: any[];
  ops?: any[];
  message?: string;
}

/** Streaming chunk types */
interface StreamingChunk {
  type: "progress" | "partial" | "heartbeat" | "complete";
  data?: any;
  error?: string;
}

/** Diagram update parameters */
interface DiagramUpdateParams {
  id: string;
  title?: string;
  type?: string;
  nodes?: any[];
  edges?: any[];
  prompt?: string;
  model?: string;
  version?: number;
}

/** Error context for logging */
interface ErrorContext {
  operation: string;
  userId?: string;
  diagramId?: string;
  additionalInfo?: Record<string, any>;
}

/* ============================= UTILITY FUNCTIONS ============================= */

/**
 * Enhanced error logging with context
 */
function logError(error: any, context: ErrorContext): void {
  const logData = {
    error: error?.message || "Unknown error",
    stack: error?.stack,
    operation: context.operation,
    userId: context.userId,
    diagramId: context.diagramId,
    ...context.additionalInfo,
  };

  logger.error(logData, `[${context.operation}] Error occurred`);
}

/**
 * Enhanced success logging with context
 */
function logSuccess(message: string, context: Partial<ErrorContext>): void {
  const logData = {
    operation: context.operation,
    userId: context.userId,
    diagramId: context.diagramId,
    ...context.additionalInfo,
  };

  logger.info(logData, message);
}

/**
 * Validates ObjectId format
 */
function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id);
}

/**
 * Sanitizes user input by trimming strings
 */
function sanitizeInput(input: any): any {
  if (typeof input === "string") {
    return input.trim();
  }
  if (Array.isArray(input)) {
    return input.map(sanitizeInput);
  }
  if (input && typeof input === "object") {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(input)) {
      sanitized[key] = sanitizeInput(value);
    }
    return sanitized;
  }
  return input;
}

/**
 * Normalizes error messages for better user experience
 */
function normalizeErrorMessage(error: any): string {
  const message = error?.message || "An unexpected error occurred";

  // Map common error patterns to user-friendly messages
  if (message.includes("Invalid diagram JSON")) {
    return "The AI generated an invalid diagram structure. Please try again with a different prompt.";
  }
  if (message.includes("Empty response")) {
    return "The AI didn't generate any content. Please try again.";
  }
  if (message.includes("timeout")) {
    return "The AI request timed out. Please try again.";
  }
  if (message.includes("quota") || message.includes("429")) {
    return "AI service quota exceeded. Please try again later.";
  }
  if (message.includes("Version conflict")) {
    return "The diagram was modified by another session. Please refresh and try again.";
  }

  return message;
}

/**
 * Determines if the request wants streaming response
 */
function wantsStreaming(req: Request): boolean {
  return req.headers.accept?.includes("text/event-stream") || req.query.stream === "true";
}

/**
 * Sets up Server-Sent Events headers
 */
function setupSSEHeaders(res: Response, req: Request): void {
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
}

/**
 * Creates a safe SSE sender that handles client disconnections
 */
function createSSESender(res: Response) {
  return (data: any): void => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      logger.info("Client disconnected, stopping stream");
      throw error;
    }
  };
}

/* ============================= HELPER FUNCTIONS ============================= */

/**
 * Builds a comprehensive assistant summary for diagram generation results
 *
 * @param params - Summary parameters
 * @returns Formatted summary string
 */
function buildAssistantSummary({
  nodes,
  edges,
  prompt,
}: {
  nodes: any[];
  edges: any[];
  prompt: string;
}): string {
  try {
    const tableNames = nodes.map((n: any) => n?.data?.label || n?.id).filter(Boolean);

    const relCount = edges.length;

    const fieldsPerTable = nodes.map((n: any) => {
      const schema = n?.data?.schema ?? [];
      return {
        table: n?.data?.label || n?.id,
        fields: schema.length,
        pks: schema.filter((f: any) => f.key === "PK").length,
        fks: schema.filter((f: any) => f.key === "FK").length,
      };
    });

    const topTables = tableNames.slice(0, 5).join(", ");
    const hasMoreTables = tableNames.length > 5;

    const lines: string[] = [];
    lines.push("Here's the ERD based on your request:");

    if (prompt?.trim()) {
      lines.push(`> "${prompt.trim()}"`);
    }

    lines.push("");
    lines.push(
      `• Tables: ${nodes.length}${tableNames.length ? ` — ${topTables}${hasMoreTables ? "…" : ""}` : ""}`,
    );
    lines.push(`• Relationships: ${relCount}`);

    // Add table details
    const tableDetails = fieldsPerTable.slice(0, 5).map((r) => {
      const fkInfo = r.fks > 0 ? `, FK:${r.fks}` : "";
      return `  - ${r.table}: ${r.fields} fields (PK:${r.pks}${fkInfo})`;
    });

    lines.push(...tableDetails);

    if (fieldsPerTable.length > 5) {
      lines.push(`  - …and ${fieldsPerTable.length - 5} more tables`);
    }

    lines.push("");
    lines.push("You can ask me to rename tables/fields, add columns, or change relationships.");

    return lines.join("\n");
  } catch (error) {
    logger.error({ error }, "Failed to build assistant summary");
    return "Diagram generated successfully. You can ask me to make changes or additions.";
  }
}

/**
 * Validates diagram limits for different user types
 */
async function validateDiagramLimits(
  req: Request,
): Promise<{ allowed: boolean; message?: string }> {
  try {
    const user = (req as any).user;
    const isGuest = !user?.id;
    const owner = getOwnerFilter(req);

    if (isGuest) {
      const aid = req.signedCookies?.aid as string | undefined;
      if (!aid) {
        return { allowed: false, message: "Missing anonymous ID" };
      }

      const count = await DiagramModel.countDocuments({ ownerAnonId: aid });
      if (count >= GUEST_DIAGRAM_LIMIT) {
        return {
          allowed: false,
          message: `Guest diagram limit reached (${GUEST_DIAGRAM_LIMIT}). Please sign in to create more.`,
        };
      }
    } else if (user.plan === "free") {
      const count = await DiagramModel.countDocuments({ userId: user.id });
      if (count >= FREE_PLAN_DIAGRAM_LIMIT) {
        return {
          allowed: false,
          message: `Free plan limit reached (${FREE_PLAN_DIAGRAM_LIMIT} diagrams). Upgrade to create more.`,
        };
      }
    }

    return { allowed: true };
  } catch (error) {
    logError(error, { operation: "validateDiagramLimits" });
    return { allowed: false, message: "Failed to validate diagram limits" };
  }
}

/**
 * Processes AI generation result and normalizes the output
 */
function processAIGenerationResult(
  ai: AIGenerationResult,
  existing: any,
  prompt: string,
): { nodes: any[]; edges: any[]; message: string } {
  try {
    let nextNodes: any[] = [];
    let nextEdges: any[] = [];

    if (Array.isArray(ai?.ops)) {
      // Handle operations-based generation
      const normalizedOps = ai.ops.map((o: any) =>
        o?.op === "add_field" ? { ...o, key: toCanonicalKey(o.key) } : o,
      );

      const applied = applyOpsInMemory(
        existing.toObject ? existing.toObject() : existing,
        normalizedOps,
      );

      const strict = normalizeErd(applied);
      nextNodes = strict.nodes;
      nextEdges = strict.edges;
    } else {
      // Handle direct nodes/edges generation
      const strict = normalizeErd({
        nodes: ai?.nodes ?? [],
        edges: ai?.edges ?? [],
      });
      nextNodes = strict.nodes;
      nextEdges = strict.edges;
    }

    const assistantMessage =
      ai?.message ||
      buildAssistantSummary({
        nodes: nextNodes,
        edges: nextEdges,
        prompt: prompt.trim(),
      });

    return {
      nodes: nextNodes,
      edges: nextEdges,
      message: assistantMessage,
    };
  } catch (error) {
    logError(error, { operation: "processAIGenerationResult" });
    throw new Error("Failed to process AI generation result");
  }
}

/* ============================= CRUD OPERATIONS ============================= */

/**
 * Lists diagrams for the authenticated user with pagination
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 * @returns Paginated list of diagrams
 */
export async function listMyDiagrams(req: Request, res: Response, next: NextFunction) {
  const operation = "listMyDiagrams";
  const userId = (req as any).user?.id;

  try {
    // Validate and sanitize pagination parameters
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const owner = getOwnerFilter(req);

    logSuccess("Fetching diagrams list", { operation, userId, additionalInfo: { page, limit } });

    const [items, total] = await Promise.all([
      DiagramModel.find(owner).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      DiagramModel.countDocuments(owner),
    ]);

    const pages = Math.ceil(total / limit);

    logSuccess("Diagrams list fetched successfully", {
      operation,
      userId,
      additionalInfo: { count: items.length, total, pages },
    });

    return res.json(
      ok({
        items,
        page,
        limit,
        total,
        pages,
      }),
    );
  } catch (err) {
    logError(err, { operation, userId });
    return next(err);
  }
}

/**
 * Retrieves a specific diagram by ID
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns Diagram data or error response
 */
export async function getDiagram(req: Request, res: Response) {
  const operation = "getDiagram";
  const { id } = req.params;
  const userId = (req as any).user?.id;

  try {
    // Validate ObjectId format
    if (!isValidObjectId(id)) {
      logError(new Error("Invalid ObjectId format"), { operation, userId, diagramId: id });
      return res.status(400).json(fail("Invalid diagram id", "BAD_ID"));
    }

    const owner = getOwnerFilter(req);

    logSuccess("Fetching diagram", { operation, userId, diagramId: id });

    const doc = await DiagramModel.findOne({
      _id: new Types.ObjectId(id),
      ...owner,
    }).lean();

    if (!doc) {
      logError(new Error("Diagram not found"), { operation, userId, diagramId: id });
      return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
    }

    logSuccess("Diagram fetched successfully", { operation, userId, diagramId: id });

    return res.json(ok(doc));
  } catch (err) {
    logError(err, { operation, userId, diagramId: id });
    return res.status(500).json(fail("Failed to fetch diagram", "SERVER_ERROR"));
  }
}

/**
 * Deletes a specific diagram by ID
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns Success response or error
 */
export async function deleteDiagram(req: Request, res: Response) {
  const operation = "deleteDiagram";
  const { id } = req.params;
  const userId = (req as any).user?.id;

  try {
    // Validate ObjectId format
    if (!isValidObjectId(id)) {
      logError(new Error("Invalid ObjectId format"), { operation, userId, diagramId: id });
      return res.status(400).json(fail("Invalid diagram id", "BAD_ID"));
    }

    const owner = getOwnerFilter(req);

    logSuccess("Deleting diagram", { operation, userId, diagramId: id });

    const result = await DiagramModel.deleteOne({
      _id: new Types.ObjectId(id),
      ...owner,
    });

    if (!result.deletedCount) {
      logError(new Error("Diagram not found for deletion"), { operation, userId, diagramId: id });
      return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
    }

    logSuccess("Diagram deleted successfully", { operation, userId, diagramId: id });

    return res.json(ok({}));
  } catch (err) {
    logError(err, { operation, userId, diagramId: id });
    return res.status(500).json(fail("Failed to delete diagram", "SERVER_ERROR"));
  }
}

/**
 * Creates a new diagram with validation and limit checks
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns Created diagram or error response
 */
export async function createDiagram(req: Request, res: Response) {
  const operation = "createDiagram";
  const userId = (req as any).user?.id;

  try {
    // Validate request payload
    const parsed = CreateDiagramReq.safeParse({ body: req.body });
    if (!parsed.success) {
      logError(new Error("Invalid diagram payload"), {
        operation,
        userId,
        additionalInfo: { validationErrors: parsed.error },
      });
      return res.status(400).json(fail("Invalid diagram payload", "VALIDATION_ERROR"));
    }

    const { name, type, model } = parsed.data.body as {
      name: string;
      type: string;
      model?: string;
    };

    // Sanitize input
    const sanitizedName = sanitizeInput(name);
    const sanitizedType = sanitizeInput(type);
    const sanitizedModel = sanitizeInput(model) || DEFAULT_MODEL;

    // Validate diagram limits
    const limitCheck = await validateDiagramLimits(req);
    if (!limitCheck.allowed) {
      logError(new Error("Diagram limit exceeded"), {
        operation,
        userId,
        additionalInfo: { message: limitCheck.message },
      });

      const statusCode = limitCheck.message?.includes("Guest") ? 403 : 403;
      const errorCode = limitCheck.message?.includes("Guest") ? "GUEST_LIMIT" : "FREE_LIMIT";

      return res.status(statusCode).json(fail(limitCheck.message!, errorCode));
    }

    const owner = getOwnerFilter(req);

    logSuccess("Creating new diagram", {
      operation,
      userId,
      additionalInfo: { name: sanitizedName, type: sanitizedType, model: sanitizedModel },
    });

    const doc = await DiagramModel.create({
      ...owner,
      title: sanitizedName,
      type: sanitizedType,
      prompt: "",
      model: sanitizedModel as any,
      nodes: [],
      edges: [],
      chat: [],
      version: 0,
    });

    logSuccess("Diagram created successfully", {
      operation,
      userId,
      diagramId: doc._id.toString(),
    });

    return res.status(201).json(ok(doc));
  } catch (err) {
    logError(err, { operation, userId });
    return res.status(500).json(fail("Failed to create diagram", "SERVER_ERROR"));
  }
}

/* ============================= EXPORT OPERATIONS ============================= */

/**
 * Exports diagram as SQL DDL statements
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns SQL file download or error response
 */
export async function exportDiagramSql(req: Request, res: Response) {
  const operation = "exportDiagramSql";
  const { id } = req.params;
  const userId = (req as any).user?.id;

  try {
    logSuccess("Exporting diagram to SQL", { operation, userId, diagramId: id });

    const exportResult = await buildSqlExport(req);

    if (exportResult.error) {
      logError(new Error(exportResult.message), {
        operation,
        userId,
        diagramId: id,
        additionalInfo: { status: exportResult.status, code: exportResult.code },
      });
      return res.status(exportResult.status).json(fail(exportResult.message, exportResult.code));
    }

    // Set appropriate headers for file download
    res.setHeader("Content-Type", exportResult.contentType);
    res.setHeader("Content-Disposition", exportResult.disposition);

    logSuccess("SQL export completed successfully", { operation, userId, diagramId: id });

    res.send(exportResult.body);
  } catch (err) {
    logError(err, { operation, userId, diagramId: id });
    return res.status(500).json(fail("Failed to export SQL", "SERVER_ERROR"));
  }
}

/* ============================= NODE SCHEMA CRUD ============================= */

/**
 * Adds a new field to a diagram node
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns Updated diagram or error response
 */
export async function addNodeField(req: Request, res: Response) {
  const operation = "addNodeField";
  const userId = (req as any).user?.id;

  try {
    // Validate request payload
    const parsed = FieldCreateReq.safeParse({ params: req.params, body: req.body });
    if (!parsed.success) {
      logError(new Error("Invalid field payload"), {
        operation,
        userId,
        additionalInfo: { validationErrors: parsed.error },
      });
      return res.status(400).json(fail("Invalid field payload", "VALIDATION_ERROR"));
    }

    const { id, nodeId } = parsed.data.params;
    const field = sanitizeInput(parsed.data.body);

    logSuccess("Adding field to node", {
      operation,
      userId,
      diagramId: id,
      additionalInfo: { nodeId, fieldId: field.id },
    });

    const loaded = await loadDiagramWithNode(req, id, nodeId);
    if ("error" in loaded) {
      logError(new Error(loaded.error), {
        operation,
        userId,
        diagramId: id,
        additionalInfo: { nodeId },
      });
      return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
    }

    const { diagram, node } = loaded;

    // Check if field already exists
    const exists = node.data!.schema.some((f: any) => f.id === field.id);
    if (exists) {
      logError(new Error("Field ID already exists"), {
        operation,
        userId,
        diagramId: id,
        additionalInfo: { nodeId, fieldId: field.id },
      });
      return res.status(409).json(fail("Field id already exists", "CONFLICT"));
    }

    // Add the new field with default values
    node.data!.schema.push({
      key: "NONE",
      nullable: true,
      default: null,
      ...field,
    });

    diagram.markModified("nodes");
    await diagram.save();

    logSuccess("Field added successfully", {
      operation,
      userId,
      diagramId: id,
      additionalInfo: { nodeId, fieldId: field.id },
    });

    return res.json(ok(diagram));
  } catch (err) {
    logError(err, { operation, userId });
    return res.status(500).json(fail("Failed to add field", "SERVER_ERROR"));
  }
}

/**
 * Updates an existing field in a diagram node (supports upsert)
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns Updated diagram or error response
 */
export async function updateNodeField(req: Request, res: Response) {
  const operation = "updateNodeField";
  const userId = (req as any).user?.id;

  try {
    // Validate request payload
    const parsed = FieldUpdateReq.safeParse({ params: req.params, body: req.body });
    if (!parsed.success) {
      logError(new Error("Invalid field update payload"), {
        operation,
        userId,
        additionalInfo: { validationErrors: parsed.error },
      });
      return res.status(400).json(fail("Invalid field update", "VALIDATION_ERROR"));
    }

    const { id, nodeId, fieldId } = parsed.data.params;
    const patch = sanitizeInput(parsed.data.body);

    logSuccess("Updating node field", {
      operation,
      userId,
      diagramId: id,
      additionalInfo: { nodeId, fieldId },
    });

    const loaded = await loadDiagramWithNode(req, id, nodeId);
    if ("error" in loaded) {
      logError(new Error(loaded.error), {
        operation,
        userId,
        diagramId: id,
        additionalInfo: { nodeId },
      });
      return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
    }

    const { diagram, node } = loaded;
    const idx = node.data!.schema.findIndex((f: any) => f.id === fieldId);

    // Handle upsert (create new field if not found)
    if (idx === -1) {
      const newId = (patch.id ?? fieldId)?.trim();
      const title = patch.title?.trim();
      const type = patch.type?.trim();

      if (!newId || !title || !type) {
        logError(new Error("Missing required fields for new field creation"), {
          operation,
          userId,
          diagramId: id,
          additionalInfo: { nodeId, fieldId, newId, title, type },
        });
        return res
          .status(400)
          .json(fail("For new field, provide id, title and type.", "VALIDATION_ERROR"));
      }

      const duplicate = node.data!.schema.some((f: any) => f.id === newId);
      if (duplicate) {
        logError(new Error("Field ID already exists"), {
          operation,
          userId,
          diagramId: id,
          additionalInfo: { nodeId, fieldId: newId },
        });
        return res.status(409).json(fail("Field id already exists", "CONFLICT"));
      }

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

      logSuccess("New field created successfully", {
        operation,
        userId,
        diagramId: id,
        additionalInfo: { nodeId, fieldId: newId },
      });

      return res.json(ok(diagram));
    }

    // Update existing field
    const current = node.data!.schema[idx];

    // Handle field ID change (requires updating references)
    if (patch.id && patch.id !== current.id) {
      const duplicate = node.data!.schema.some((f: any) => f.id === patch.id);
      if (duplicate) {
        logError(new Error("New field ID already exists"), {
          operation,
          userId,
          diagramId: id,
          additionalInfo: { nodeId, fieldId, newFieldId: patch.id },
        });
        return res.status(409).json(fail("New field id already exists", "CONFLICT"));
      }

      // Update all references to the old field ID
      rewriteHandlesForFieldRename(diagram as any, current.id, patch.id);
    }

    // Apply updates to the field
    node.data!.schema[idx] = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.key !== undefined ? { key: patch.key } : {}),
      ...(patch.id !== undefined ? { id: patch.id } : {}),
    };

    diagram.markModified("nodes");
    await diagram.save();

    logSuccess("Field updated successfully", {
      operation,
      userId,
      diagramId: id,
      additionalInfo: { nodeId, fieldId },
    });

    return res.json(ok(diagram));
  } catch (err) {
    logError(err, { operation, userId });
    return res.status(500).json(fail("Failed to update field", "SERVER_ERROR"));
  }
}

/**
 * Deletes a field from a diagram node
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns Updated diagram or error response
 */
export async function deleteNodeField(req: Request, res: Response) {
  const operation = "deleteNodeField";
  const userId = (req as any).user?.id;

  try {
    // Validate request parameters
    const parsed = FieldDeleteReq.safeParse({ params: req.params });
    if (!parsed.success) {
      logError(new Error("Invalid delete request"), {
        operation,
        userId,
        additionalInfo: { validationErrors: parsed.error },
      });
      return res.status(400).json(fail("Invalid request", "VALIDATION_ERROR"));
    }

    const { id, nodeId, fieldId } = parsed.data.params;

    logSuccess("Deleting node field", {
      operation,
      userId,
      diagramId: id,
      additionalInfo: { nodeId, fieldId },
    });

    const loaded = await loadDiagramWithNode(req, id, nodeId);
    if ("error" in loaded) {
      logError(new Error(loaded.error), {
        operation,
        userId,
        diagramId: id,
        additionalInfo: { nodeId },
      });
      return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
    }

    const { diagram, node } = loaded;
    const beforeCount = node.data!.schema.length;

    // Remove the field
    node.data!.schema = node.data!.schema.filter((f: any) => f.id !== fieldId);

    if (node.data!.schema.length === beforeCount) {
      logError(new Error("Field not found for deletion"), {
        operation,
        userId,
        diagramId: id,
        additionalInfo: { nodeId, fieldId },
      });
      return res.status(404).json(fail("Field not found", "NOT_FOUND"));
    }

    // Remove any edges that reference this field
    removeEdgesTouchingField(diagram as any, fieldId);

    diagram.markModified("nodes");
    await diagram.save();

    logSuccess("Field deleted successfully", {
      operation,
      userId,
      diagramId: id,
      additionalInfo: { nodeId, fieldId },
    });

    return res.json(ok(diagram));
  } catch (err) {
    logError(err, { operation, userId });
    return res.status(500).json(fail("Failed to delete field", "SERVER_ERROR"));
  }
}

/**
 * Updates the label of a diagram node
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns Updated diagram or error response
 */
export async function updateNodeLabel(req: Request, res: Response) {
  const operation = "updateNodeLabel";
  const userId = (req as any).user?.id;

  try {
    // Validate request payload
    const parsed = NodeLabelUpdateReq.safeParse({ params: req.params, body: req.body });
    if (!parsed.success) {
      logError(new Error("Invalid label payload"), {
        operation,
        userId,
        additionalInfo: { validationErrors: parsed.error },
      });
      return res.status(400).json(fail("Invalid label payload", "VALIDATION_ERROR"));
    }

    const { id, nodeId } = parsed.data.params;
    const { label } = parsed.data.body;
    const sanitizedLabel = sanitizeInput(label);

    logSuccess("Updating node label", {
      operation,
      userId,
      diagramId: id,
      additionalInfo: { nodeId, label: sanitizedLabel },
    });

    const loaded = await loadDiagramWithNode(req, id, nodeId);
    if ("error" in loaded) {
      logError(new Error(loaded.error), {
        operation,
        userId,
        diagramId: id,
        additionalInfo: { nodeId },
      });
      return res.status(404).json(fail(loaded.error, "NOT_FOUND"));
    }

    const { diagram, node } = loaded;

    node.data!.label = sanitizedLabel;
    diagram.markModified("nodes");
    await diagram.save();

    logSuccess("Node label updated successfully", {
      operation,
      userId,
      diagramId: id,
      additionalInfo: { nodeId, label: sanitizedLabel },
    });

    return res.json(ok(diagram));
  } catch (err) {
    logError(err, { operation, userId });
    return res.status(500).json(fail("Failed to update node label", "SERVER_ERROR"));
  }
}

/* ============================= STREAMING UPDATE ============================= */

/**
 * Handles streaming AI generation with proper error handling
 */
async function handleStreamingGeneration(
  composed: string,
  chosenModel: any,
  sendSSE: (data: any) => void,
  existing: any,
  prompt: string,
  title?: string,
  type?: string,
  baseVersion?: number,
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    let nextNodes: any[] = [];
    let nextEdges: any[] = [];
    let assistantMessage: string | undefined;
    let isComplete = false;

    // Start heartbeat to keep connection alive
    const heartbeatInterval = setInterval(() => {
      if (!isComplete) {
        sendSSE({ type: "heartbeat", data: { timestamp: Date.now() } });
      }
    }, HEARTBEAT_INTERVAL);

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
            return { success: false, error: chunk.error };
          }

          const result = processAIGenerationResult(chunk.data, existing, prompt);
          nextNodes = result.nodes;
          nextEdges = result.edges;
          assistantMessage = result.message;

          break;
        }
      }
    } finally {
      clearInterval(heartbeatInterval);
    }

    return {
      success: true,
      data: {
        nodes: nextNodes,
        edges: nextEdges,
        message: assistantMessage,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: normalizeErrorMessage(error),
    };
  }
}

/**
 * Handles non-streaming AI generation
 */
async function handleNonStreamingGeneration(
  composed: string,
  chosenModel: any,
  existing: any,
  prompt: string,
): Promise<{ success: boolean; data?: any; error?: string }> {
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

        const result = processAIGenerationResult(chunk.data, existing, prompt);
        nextNodes = result.nodes;
        nextEdges = result.edges;
        assistantMessage = result.message;
        break;
      }
    }

    if (hasError) {
      return { success: false, error: errorMessage };
    }

    return {
      success: true,
      data: {
        nodes: nextNodes,
        edges: nextEdges,
        message: assistantMessage,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: normalizeErrorMessage(error),
    };
  }
}

/**
 * Updates diagram with AI generation results
 */
async function updateDiagramWithResults(
  existing: any,
  baseVersion: number,
  updates: {
    title?: string;
    type?: string;
    nodes: any[];
    edges: any[];
    prompt: string;
    model: string;
    chat: ChatMessage[];
  },
): Promise<any> {
  return await DiagramModel.findOneAndUpdate(
    { _id: existing._id, version: baseVersion },
    {
      $set: {
        ...(updates.title ? { title: updates.title.trim() } : {}),
        ...(updates.type ? { type: updates.type } : {}),
        nodes: updates.nodes,
        edges: updates.edges,
        prompt: updates.prompt.trim(),
        model: updates.model,
        chat: updates.chat,
      },
      $inc: { version: 1 },
    },
    { new: true },
  ).lean();
}

/**
 * Handles streaming AI generation for diagram updates
 *
 * @param req - Express request object
 * @param res - Express response object
 * @returns Streaming response or error
 */
export async function updateDiagramStream(req: Request, res: Response) {
  const operation = "updateDiagramStream";
  const userId = (req as any).user?.id;

  try {
    // Validate schema availability
    if (!UpdateDiagramReq || typeof (UpdateDiagramReq as any).safeParse !== "function") {
      logError(new Error("UpdateDiagramReq schema not available"), { operation, userId });
      return res.status(500).json(fail("Server schema not loaded", "SERVER_CONFIG"));
    }

    // Validate request payload
    const parsed = UpdateDiagramReq.safeParse({ params: req.params, body: req.body });
    if (!parsed.success) {
      logError(new Error("Invalid update payload"), {
        operation,
        userId,
        additionalInfo: { validationErrors: parsed.error },
      });
      return res.status(400).json(fail("Invalid update", "VALIDATION_ERROR"));
    }

    const { id } = parsed.data.params;
    const { title, type, nodes, edges, prompt, model } = sanitizeInput(parsed.data.body) as any;
    const clientVersion: number | undefined = (parsed.data.body as any).version;

    // Validate ObjectId format
    if (!isValidObjectId(id)) {
      logError(new Error("Invalid ObjectId format"), { operation, userId, diagramId: id });
      return res.status(400).json(fail("Invalid diagram id", "BAD_ID"));
    }

    const owner = getOwnerFilter(req);

    logSuccess("Starting diagram stream update", {
      operation,
      userId,
      diagramId: id,
      additionalInfo: { hasPrompt: !!prompt, hasNodes: !!nodes, hasEdges: !!edges },
    });

    const existing = await DiagramModel.findOne({ _id: new Types.ObjectId(id), ...owner });
    if (!existing) {
      logError(new Error("Diagram not found"), { operation, userId, diagramId: id });
      return res.status(404).json(fail("Diagram not found", "NOT_FOUND"));
    }

    // Manual nodes/edges updates are not supported in streaming mode
    if (Array.isArray(nodes) || Array.isArray(edges)) {
      logError(new Error("Manual updates not supported in streaming mode"), {
        operation,
        userId,
        diagramId: id,
      });
      return res
        .status(400)
        .json(fail("Manual updates not supported in streaming mode", "NOT_SUPPORTED"));
    }

    // AI generation path
    if (prompt && prompt.trim()) {
      // Validate ERD prompt
      if (!isValidErd(prompt)) {
        logError(new Error("Invalid ERD prompt"), {
          operation,
          userId,
          diagramId: id,
          additionalInfo: { prompt: prompt.substring(0, 100) },
        });
        return res
          .status(400)
          .json(fail("Your prompt does not seem ERD-related.", "INVALID_ERD_PROMPT"));
      }

      const chosenModel = (model || (existing as any).model || DEFAULT_MODEL) as any;
      const baseVersion =
        typeof clientVersion === "number" ? clientVersion : (existing.version ?? 0);

      // Prepare chat history
      const prevChat: ChatMessage[] = Array.isArray((existing as any).chat)
        ? ((existing as any).chat as ChatMessage[])
        : [];

      const now = Date.now();
      const userMsg: ChatMessage = { role: "user", content: prompt.trim(), ts: now };
      const workingChat: ChatMessage[] = [...prevChat, userMsg].slice(-MAX_CHAT_HISTORY);

      const chatTail = tailForPrompt(workingChat, MAX_CHAT_TAIL);
      const composed = composePrompt(
        (existing as any).toObject ? (existing as any).toObject() : existing,
        prompt,
        chatTail,
      );

      // Check if client wants streaming
      const isStreaming = wantsStreaming(req);

      if (isStreaming) {
        // Set up Server-Sent Events
        setupSSEHeaders(res, req);
        const sendSSE = createSSESender(res);

        // Handle client disconnect
        req.on("close", () => {
          logger.info(
            { operation, userId, diagramId: req.params.id },
            "Client disconnected from streaming endpoint",
          );
        });

        try {
          sendSSE({ type: "start", message: "Starting AI generation..." });

          const result = await handleStreamingGeneration(
            composed,
            chosenModel as any,
            sendSSE,
            existing,
            prompt,
            title,
            type,
            baseVersion,
          );

          if (!result.success) {
            sendSSE({ type: "error", error: result.error });
            res.end();
            return;
          }

          const { nodes: nextNodes, edges: nextEdges, message: assistantMessage } = result.data;

          const finalChat = [
            ...workingChat,
            { role: "assistant" as ChatRole, content: assistantMessage, ts: Date.now() },
          ].slice(-MAX_CHAT_HISTORY);

          const doc = await updateDiagramWithResults(existing, baseVersion, {
            title,
            type,
            nodes: nextNodes,
            edges: nextEdges,
            prompt: prompt.trim(),
            model: chosenModel,
            chat: finalChat,
          });

          if (!doc) {
            sendSSE({ type: "error", error: "Version conflict" });
            res.end();
            return;
          }

          sendSSE({ type: "complete", data: doc });
          res.end();
          return;
        } catch (err: any) {
          logError(err, { operation, userId, diagramId: id });
          const errMsg = normalizeErrorMessage(err);

          const finalChat = [
            ...workingChat,
            {
              role: "assistant" as ChatRole,
              content: `There was an error: ${errMsg}`,
              ts: Date.now(),
            },
          ].slice(-MAX_CHAT_HISTORY);

          // Update diagram with error message
          await updateDiagramWithResults(existing, baseVersion, {
            title,
            type,
            nodes: [],
            edges: [],
            prompt: prompt.trim(),
            model: chosenModel,
            chat: finalChat,
          }).catch(() => {});

          sendSSE({ type: "error", error: errMsg });
          res.end();
          return;
        }
      } else {
        // Regular JSON response - collect all streaming data and return at once
        try {
          const result = await handleNonStreamingGeneration(
            composed,
            chosenModel as any,
            existing,
            prompt,
          );

          if (!result.success) {
            const finalChat = [
              ...workingChat,
              {
                role: "assistant" as ChatRole,
                content: `There was an error: ${result.error}`,
                ts: Date.now(),
              },
            ].slice(-MAX_CHAT_HISTORY);

            await updateDiagramWithResults(existing, baseVersion, {
              title,
              type,
              nodes: [],
              edges: [],
              prompt: prompt.trim(),
              model: chosenModel,
              chat: finalChat,
            }).catch(() => {});

            const statusCode =
              result.error?.includes("429") || /quota/i.test(result.error || "") ? 429 : 502;
            const errorCode =
              result.error?.includes("429") || /quota/i.test(result.error || "")
                ? "AI_QUOTA_EXCEEDED"
                : "AI_FAILED";

            return res.status(statusCode).json(fail(result.error!, errorCode));
          }

          const { nodes: nextNodes, edges: nextEdges, message: assistantMessage } = result.data;

          const finalChat = [
            ...workingChat,
            { role: "assistant" as ChatRole, content: assistantMessage, ts: Date.now() },
          ].slice(-MAX_CHAT_HISTORY);

          const doc = await updateDiagramWithResults(existing, baseVersion, {
            title,
            type,
            nodes: nextNodes,
            edges: nextEdges,
            prompt: prompt.trim(),
            model: chosenModel,
            chat: finalChat,
          });

          if (!doc) {
            return res.status(409).json(fail("Version conflict", "CONFLICT"));
          }

          logSuccess("Diagram updated successfully (non-streaming)", {
            operation,
            userId,
            diagramId: id,
          });

          return res.json(ok(doc));
        } catch (err: any) {
          logError(err, { operation, userId, diagramId: id });
          const errMsg = normalizeErrorMessage(err);

          const finalChat = [
            ...workingChat,
            {
              role: "assistant" as ChatRole,
              content: `There was an error: ${errMsg}`,
              ts: Date.now(),
            },
          ].slice(-MAX_CHAT_HISTORY);

          await updateDiagramWithResults(existing, baseVersion, {
            title,
            type,
            nodes: [],
            edges: [],
            prompt: prompt.trim(),
            model: chosenModel,
            chat: finalChat,
          }).catch(() => {});

          const statusCode = errMsg.includes("429") || /quota/i.test(errMsg) ? 429 : 502;
          const errorCode =
            errMsg.includes("429") || /quota/i.test(errMsg) ? "AI_QUOTA_EXCEEDED" : "AI_FAILED";

          return res.status(statusCode).json(fail(errMsg, errorCode));
        }
      }
    }

    // If no prompt provided, return existing diagram
    if (!prompt || !prompt.trim()) {
      logSuccess("Returning existing diagram (no prompt provided)", {
        operation,
        userId,
        diagramId: id,
      });
      return res.json(ok((existing as any).toObject ? (existing as any).toObject() : existing));
    }
  } catch (err) {
    logError(err, { operation, userId, diagramId: req.params.id });
    return res.status(500).json(fail("Failed to update diagram", "SERVER_ERROR"));
  }
}
