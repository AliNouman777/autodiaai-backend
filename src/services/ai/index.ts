// src/services/ai/index.ts
import { GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPT } from "../../Constant/ERDPrompt";
import { normalizeErd, ZErdLoose } from "../../schemas/erd-ai";

/** Canonical models (OpenAI & OpenRouter removed) */
export type CanonicalModel = "gemini-2.5-flash" | "gemini-2.5-flash-lite";

/** Provider interface */
export interface ERDProvider {
  name: "gemini";
  /**
   * Returns either:
   *  - { nodes, edges, message? }  (full ERD)
   *  - { ops, message? }           (patch-style ops)
   */
  generate(
    userPrompt: string,
    model: CanonicalModel,
  ): Promise<{ nodes?: any[]; edges?: any[]; ops?: any[]; message?: string }>;

  /**
   * Streaming version that yields partial results
   */
  generateStream(
    userPrompt: string,
    model: CanonicalModel,
  ): AsyncGenerator<
    { type: "progress" | "partial" | "complete" | "heartbeat"; data?: any; error?: string },
    void,
    unknown
  >;
}

/* ---------------- utilities ---------------- */
function tryParseJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error("Model did not return valid JSON");
  }
}

/** Validate loose → normalize to strict ERD */
function validateAndNormalizeDiagram(obj: any) {
  // First, try to clean up the data before validation
  const cleanedObj = cleanAndValidateDiagramData(obj);

  const parsed = ZErdLoose.safeParse(cleanedObj);
  if (!parsed.success) {
    const first = parsed.error.issues?.[0];
    const where = first?.path?.length ? first.path.join(".") + " " : "";
    throw new Error(`Invalid diagram JSON: ${where}${first?.message || "validation failed"}`);
  }
  return normalizeErd(parsed.data);
}

/** Clean and validate diagram data to handle incomplete AI responses */
function cleanAndValidateDiagramData(obj: any) {
  if (!obj || typeof obj !== "object") {
    throw new Error("Invalid diagram data: not an object");
  }

  const cleaned = { ...obj };

  // Ensure nodes array exists
  if (!Array.isArray(cleaned.nodes)) {
    cleaned.nodes = [];
  }

  // Clean each node
  cleaned.nodes = cleaned.nodes.map((node: any, nodeIndex: number) => {
    if (!node || typeof node !== "object") {
      throw new Error(`Invalid node at index ${nodeIndex}: not an object`);
    }

    const cleanedNode = { ...node };

    // Ensure required fields
    if (!cleanedNode.id || typeof cleanedNode.id !== "string") {
      cleanedNode.id = `node_${nodeIndex}`;
    }

    if (!cleanedNode.type) {
      cleanedNode.type = "databaseSchema";
    }

    if (!cleanedNode.position || typeof cleanedNode.position !== "object") {
      cleanedNode.position = { x: nodeIndex * 400, y: 0 };
    }

    // Clean data object
    if (!cleanedNode.data || typeof cleanedNode.data !== "object") {
      cleanedNode.data = { label: "Table", schema: [] };
    }

    if (!cleanedNode.data.label || typeof cleanedNode.data.label !== "string") {
      cleanedNode.data.label = `Table_${nodeIndex + 1}`;
    }

    // Clean schema array
    if (!Array.isArray(cleanedNode.data.schema)) {
      cleanedNode.data.schema = [];
    }

    // Clean each schema field
    cleanedNode.data.schema = cleanedNode.data.schema.map((field: any, fieldIndex: number) => {
      if (!field || typeof field !== "object") {
        return {
          id: `field_${nodeIndex}_${fieldIndex}`,
          title: `Field_${fieldIndex + 1}`,
          type: "VARCHAR(255)",
          key: undefined,
        };
      }

      const cleanedField = { ...field };

      // Ensure required fields
      if (!cleanedField.id || typeof cleanedField.id !== "string") {
        cleanedField.id = `field_${nodeIndex}_${fieldIndex}`;
      }

      if (!cleanedField.title || typeof cleanedField.title !== "string") {
        cleanedField.title = `Field_${fieldIndex + 1}`;
      }

      if (!cleanedField.type || typeof cleanedField.type !== "string") {
        cleanedField.type = "VARCHAR(255)";
      }

      // Clean key field
      if (cleanedField.key !== "PK" && cleanedField.key !== "FK") {
        cleanedField.key = undefined;
      }

      return cleanedField;
    });

    return cleanedNode;
  });

  // Ensure edges array exists
  if (!Array.isArray(cleaned.edges)) {
    cleaned.edges = [];
  }

  // Clean each edge
  cleaned.edges = cleaned.edges.map((edge: any, edgeIndex: number) => {
    if (!edge || typeof edge !== "object") {
      return {
        id: `edge_${edgeIndex}`,
        source: "node_0",
        target: "node_1",
        type: "superCurvyEdge",
      };
    }

    const cleanedEdge = { ...edge };

    // Ensure required fields
    if (!cleanedEdge.id || typeof cleanedEdge.id !== "string") {
      cleanedEdge.id = `edge_${edgeIndex}`;
    }

    if (!cleanedEdge.source || typeof cleanedEdge.source !== "string") {
      cleanedEdge.source = "node_0";
    }

    if (!cleanedEdge.target || typeof cleanedEdge.target !== "string") {
      cleanedEdge.target = "node_1";
    }

    if (!cleanedEdge.type) {
      cleanedEdge.type = "superCurvyEdge";
    }

    return cleanedEdge;
  });

  return cleaned;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 400 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.data?.status ?? err?.response?.status;
      const retriable =
        status === 429 || (typeof status === "number" && status >= 500 && status < 600);
      if (!retriable || i === attempts - 1) break;
      const backoff = baseDelayMs * 2 ** i;
      if (process.env.DEBUG) console.warn(`[AI] retrying after ${backoff}ms due to ${status}`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function withTimeout<T>(p: Promise<T>, ms = 180000): Promise<T> {
  let t: any;
  const timeout = new Promise<never>(
    (_, rej) => (t = setTimeout(() => rej(new Error("AI request timed out")), ms)),
  );
  try {
    const out = await Promise.race([p, timeout]);
    return out as T;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- Gemini singleton ---------------- */
const geminiClient = (() => {
  if (!process.env.GEMINI_API_KEY && process.env.NODE_ENV !== "test") {
    console.warn("[Gemini] GEMINI_API_KEY is missing");
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
})();

/* ---------------- Gemini provider ---------------- */
class GeminiProvider implements ERDProvider {
  name = "gemini" as const;

  async generate(userPrompt: string, model: CanonicalModel) {
    if (!(model === "gemini-2.5-flash" || model === "gemini-2.5-flash-lite")) {
      throw new Error(`GeminiProvider received unsupported model: ${model}`);
    }

    const run = async () => {
      const resp = await (geminiClient as any).models.generateContent({
        model,
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 4000,
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\nUSER REQUEST:\n${userPrompt}` }],
          },
        ],
      });

      // Get text from various SDK shapes
      let text: string | undefined;
      const maybeText = (resp as any).text;
      if (typeof maybeText === "function") text = await maybeText.call(resp);
      else if (typeof maybeText === "string") text = maybeText;
      else if (resp?.response?.candidates?.[0]?.content?.parts) {
        text = resp.response.candidates[0].content.parts
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .join("\n");
      }

      if (!text || !text.trim()) throw new Error("Empty response from Gemini");

      // The model may return: { nodes, edges, message? } OR { ops, message? }
      const raw = tryParseJson(text);

      const message =
        typeof raw?.message === "string" && raw.message.trim() ? raw.message.trim() : undefined;

      if (Array.isArray(raw?.ops)) {
        // ops-only path
        return { ops: raw.ops, message };
      }

      // full ERD path: validate + normalize
      const { nodes, edges } = validateAndNormalizeDiagram({
        nodes: raw?.nodes ?? [],
        edges: raw?.edges ?? [],
      });
      return { nodes, edges, message };
    };

    return withTimeout(withRetry(run));
  }

  async *generateStream(
    userPrompt: string,
    model: CanonicalModel,
  ): AsyncGenerator<
    { type: "progress" | "partial" | "complete" | "heartbeat"; data?: any; error?: string },
    void,
    unknown
  > {
    if (!(model === "gemini-2.5-flash" || model === "gemini-2.5-flash-lite")) {
      throw new Error(`GeminiProvider received unsupported model: ${model}`);
    }

    try {
      yield { type: "progress", data: { message: "Starting AI generation...", progress: 0 } };

      // Start heartbeat to keep connection alive
      const heartbeatInterval = setInterval(() => {
        // This will be handled by the controller
      }, 2000); // Send heartbeat every 2 seconds

      try {
        yield { type: "progress", data: { message: "Connecting to AI service...", progress: 10 } };

        // Simulate progress updates during AI generation
        const progressSteps = [
          { message: "Analyzing your request...", progress: 20 },
          { message: "Designing database structure...", progress: 40 },
          { message: "Generating table schemas...", progress: 60 },
          { message: "Creating relationships...", progress: 80 },
          { message: "Finalizing ERD...", progress: 90 },
        ];

        // Send progress updates with delays to simulate real-time processing
        for (const step of progressSteps) {
          console.log(`[STREAMING] Sending progress: ${step.message} (${step.progress}%)`);
          yield { type: "progress", data: step };
          await new Promise((resolve) => setTimeout(resolve, 800)); // Reduced delay for faster response
        }

        yield { type: "progress", data: { message: "Processing with AI...", progress: 95 } };

        // Call the actual AI generation
        const result = await this.generate(userPrompt, model);

        yield {
          type: "complete",
          data: result,
        };
      } finally {
        clearInterval(heartbeatInterval);
      }
    } catch (error: any) {
      yield {
        type: "complete",
        error: error?.message || "AI generation failed",
      };
    }
  }
}

/* ---------------- factory & exports ---------------- */
const geminiProvider = new GeminiProvider();

/** Only Gemini now */
export function getProviderFor(_model: CanonicalModel): ERDProvider {
  return geminiProvider;
}

/** Convenience */
export async function generateERD(userPrompt: string, model: CanonicalModel) {
  return geminiProvider.generate(userPrompt, model);
}

/** Streaming convenience */
export function generateERDStream(userPrompt: string, model: CanonicalModel) {
  return geminiProvider.generateStream(userPrompt, model);
}
