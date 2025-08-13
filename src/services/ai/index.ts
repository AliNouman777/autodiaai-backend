// src/services/ai.ts
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { DiagramPayload } from "../../schemas/diagram.schema";

/** Canonical model IDs you support end-to-end */
export type CanonicalModel = "gpt-5" | "gpt-5-mini" | "gemini-2.5-flash" | "gemini-2.5-flash-lite";

/** Which SDK/provider a canonical model belongs to */
function providerKindFor(model: CanonicalModel): "openai" | "gemini" {
  return model.startsWith("gemini-") ? "gemini" : "openai";
}

/** Common interface all providers implement */
export interface ERDProvider {
  name: "openai" | "gemini";
  /** Generate ERD JSON with a specific canonical model id (validated & typed) */
  generate(userPrompt: string, model: CanonicalModel): Promise<ReturnType<typeof validateDiagram>>;
}

/* ----------------- utilities ----------------- */

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

export function validateDiagram(raw: any) {
  const obj = typeof raw === "string" ? tryParseJson(raw) : raw;
  const parsed = DiagramPayload.safeParse(obj);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid diagram JSON: ${issue.path.join(".")} ${issue.message}`);
  }
  return parsed.data;
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
      const status = err?.status ?? err?.data?.status;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable || i === attempts - 1) break;
      const backoff = baseDelayMs * 2 ** i;
      if (process.env.DEBUG) console.warn(`[AI] retrying after ${backoff}ms due to ${status}`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function withTimeout<T>(p: Promise<T>, ms = 60000): Promise<T> {
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

export const SYSTEM_PROMPT = `You are a helpful and precise assistant that converts natural language descriptions of database models into JSON data for an Entity Relationship Diagram (ERD). Follow the rules strictly.

🎯 OBJECTIVE:
Generate a JSON object with two arrays: "nodes" and "edges".
- Each "node" is a database table.
- Each "edge" is a relationship between tables and must match the handle style used in our data (e.g., 'users-id-right', 'posts-user_id-left').

🚫 DO NOT use keys named "defaultNodes" or "defaultEdges". Only "nodes" and "edges".

📦 JSON FORMAT — STRICTLY FOLLOW THIS:

1) Each entry in "nodes" must look like:
{
  "id": string,                 // numeric string starting at "1", then "2", "3", ...
  "position": { "x": number, "y": number },
  "type": "databaseSchema",
  "data": {
    "label": string,            // table name
    "schema": [
      {
        "id": string,           // 'table-column' (preserve dashes in column names)
        "title": string,        // column name ONLY (no "(PK)" or "(FK)" suffixes)
        // IMPORTANT: "key" rules
        // - For primary keys: include "key": "PK"
        // - For foreign keys: include "key": "FK"
        // - For ALL other columns: DO NOT include the "key" property at all
        "type": string          // SQL type (e.g., "INT", "VARCHAR(255)", "TIMESTAMP")
      }
    ]
  }
}

Rules for fields:
- Every table must include one PK field with "key": "PK".
- Foreign key columns must include "key": "FK".
- Never put "(PK)" or "(FK)" in "title"; use the "key" property.
- Never set "key" to an empty string. If a column is not PK or FK, omit "key" entirely.

2) Each entry in "edges" must look like:
{
  "id": string,                 // "e<source>-<target>", e.g., "e1-2"
  "source": string,             // node id (numeric string) of the PK table
  "sourceHandle": string,       // '<sourceFieldId>-right'
  "target": string,             // node id (numeric string) of the FK table
  "targetHandle": string,       // '<targetFieldId>-left'
  "type": "superCurvyEdge",
  "markerStart": "one-start" | "many-start" | "zero-to-one-start" | "zero-to-many-start" | "zero-start",
  "markerEnd": "one-end" | "many-end" | "zero-to-one-end" | "zero-to-many-end" | "zero-end",
  "data": {}
}

🧠 CARDINALITY RULES:
- one-to-one (mandatory): "one-start" → "one-end"
- one-to-one (optional): "one-start" → "zero-to-one-end"
- one-to-many (mandatory): "one-start" → "many-end"
- zero-to-many: "one-start" → "zero-to-many-end"
- many-to-many: use a join table and two one-to-many edges
- optional foreign key: use "zero-to-one-end" or "zero-to-many-end" on the FK side

🧪 DATA QUALITY CHECKLIST:
✅ Realistic table & column names
✅ Every table has a primary key (include "key": "PK" on that field)
✅ Foreign keys marked with "key": "FK"
✅ Non-key columns OMIT the "key" property entirely (do not set it to "")
✅ Field "id" strictly 'table-column'
✅ Edge handles match '<fieldId>-right' (source) and '<fieldId>-left' (target)
✅ Use "superCurvyEdge" for all edges
✅ Include empty "data": {} in each edge
✅ Node ids are numeric strings ("1","2","3",...) and edge ids follow "e<source>-<target>"

📘 INSTRUCTIONS FOR DOMAIN MODELING:
Model only entities relevant to the user's domain (e.g., e-commerce, blog, HR).
Auto-generate reasonable fields like created_at/updated_at (TIMESTAMP) but do not invent unrelated tables.

🚨 STRICT OUTPUT FORMAT:
- Output pure JSON with keys "nodes" and "edges"
- No markdown, no extra text, no explanations
- Never truncate — include all nodes & edges completely
`;

/* ---------------- Singletons ---------------- */
const openAIClient = (() => {
  if (!process.env.OPENAI_API_KEY && process.env.NODE_ENV !== "test") {
    console.warn("[OpenAI] OPENAI_API_KEY is missing");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
})();

const geminiClient = (() => {
  if (!process.env.GEMINI_API_KEY && process.env.NODE_ENV !== "test") {
    console.warn("[Gemini] GEMINI_API_KEY is missing");
  }
  return new GoogleGenAI({});
})();

/* ---------------- OpenAI provider ---------------- */
class OpenAIProvider implements ERDProvider {
  name = "openai" as const;

  async generate(userPrompt: string, model: CanonicalModel) {
    if (!(model === "gpt-5" || model === "gpt-5-mini")) {
      throw new Error(`OpenAIProvider received unsupported model: ${model}`);
    }

    const run = async () => {
      const t0 = Date.now();
      if (process.env.DEBUG) console.log("[OpenAI] request →", { model });

      // Use Responses API; remove `response_format` to satisfy current SDK typings
      const resp = await openAIClient.responses.create({
        model,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      });

      const text = resp.output_text ?? "";
      if (process.env.DEBUG)
        console.log("[OpenAI] response ←", { ms: Date.now() - t0, len: text.length });
      if (!text) throw new Error("Empty response from OpenAI");
      return validateDiagram(text);
    };

    return withTimeout(withRetry(run));
  }
}

// ---------------- Gemini provider (@google/genai) ----------------
class GeminiProvider implements ERDProvider {
  name = "gemini" as const;

  async generate(userPrompt: string, model: CanonicalModel) {
    if (!(model === "gemini-2.5-flash" || model === "gemini-2.5-flash-lite")) {
      throw new Error(`GeminiProvider received unsupported model: ${model}`);
    }

    const run = async () => {
      const t0 = Date.now();
      if (process.env.DEBUG) console.log("[Gemini] request →", { model });

      const resp = await geminiClient.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\nUSER REQUEST:\n${userPrompt}` }],
          },
        ],
        // keep both keys for SDK variance
        // @ts-ignore
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
          maxOutputTokens: 4000,
        },
        // @ts-ignore
        config: { responseMimeType: "application/json" },
      });

      // --- SAFE TEXT EXTRACTION ACROSS SDK VERSIONS ---
      let text: string | undefined;

      const maybeText = (resp as any).text;
      if (typeof maybeText === "function") {
        // old SDK style: function
        text = await maybeText.call(resp);
      } else if (typeof maybeText === "string") {
        // newer SDK style: string
        text = maybeText;
      } else if (Array.isArray((resp as any).candidates)) {
        // raw candidates fallback
        const c = (resp as any).candidates[0];
        const parts = c?.content?.parts;
        if (Array.isArray(parts)) {
          text = parts
            .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
            .filter(Boolean)
            .join("\n");
        }
      }
      if (process.env.DEBUG) {
        console.log("[Gemini] response ←", { ms: Date.now() - t0, len: text?.length ?? 0 });
      }

      if (!text || !text.trim()) throw new Error("Empty response from Gemini");
      return validateDiagram(text);
      // -----------------------------------------------
    };

    return withTimeout(withRetry(run));
  }
}

/* ---------------- factory ---------------- */
const openaiProvider = new OpenAIProvider();
const geminiProvider = new GeminiProvider();

export function getProviderFor(model: CanonicalModel): ERDProvider {
  return providerKindFor(model) === "gemini" ? geminiProvider : openaiProvider;
}

/* ---------------- convenience ---------------- */
export async function generateERD(userPrompt: string, model: CanonicalModel) {
  const provider = getProviderFor(model);
  return provider.generate(userPrompt, model);
}
