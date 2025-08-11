import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { DiagramPayload } from "../../schemas/diagram.schema";
import { DIAGRAM_RESPONSE_SCHEMA } from "./diagram.genai-schema"; // <-- ensure filename matches

export interface ERDProvider {
  name: "gpt5" | "gemini";
  generate(prompt: string): Promise<string | object>;
}

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

export const SYSTEM_PROMPT = `You are an ERD generator.

Return ONLY a JSON object with EXACTLY these top-level keys: "title", "nodes", "edges".
No markdown, no code fences, no commentary.

Node:
- { id, position:{x:number,y:number}, type:"databaseSchema",
    data:{ label:string, schema:[ {id,title,type,key?("PK"|"FK")} ] } }

Edge:
- { id, source, target, sourceHandle, targetHandle, type:"superCurvyEdge",
    markerStart ∈ {"one-start","many-start","zero-to-one-start","zero-to-many-start","zero-start"},
    markerEnd   ∈ {"one-end","many-end","zero-to-one-end","zero-to-many-end","zero-end"},
    data:{} }  // data MUST exist (can be empty)

Handles MUST end with -left or -right and follow "<table>-<field>-(left|right)".
Foreign keys MUST exist in node schemas and be wired by edges.`;

/* ---------------- OpenAI provider (compat with older SDKs) ---------------- */
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini-2024-07-18";

class OpenAIProvider implements ERDProvider {
  name = "gpt5" as const;
  private client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

  async generate(userPrompt: string) {
    console.log("[OpenAI] request →", {
      model: OPENAI_MODEL,
      hasKey: !!process.env.OPENAI_API_KEY,
    });
    const t0 = Date.now();
    const resp = await this.client.responses.create({
      model: OPENAI_MODEL,
      instructions: SYSTEM_PROMPT,
      input: userPrompt,
    });
    const text = resp.output_text ?? "";
    console.log("[OpenAI] response ←", { ms: Date.now() - t0, len: text.length });
    if (!text) throw new Error("Empty response from OpenAI");
    return text;
  }
}

/* ----------
class GeminiProvider implements ERDProvider {
  name = "gemini" as const;
  private ai = new GoogleGenAI({}); // uses GEMINI_API_KEY

  async generate(userPrompt: string) {
    console.log("[Gemini] request →", { model: GEMINI_MODEL, hasKey: !!process.env.GEMINI_API_KEY });
    const t0 = Date.now();
    const response = await this.ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: userPrompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: DIAGRAM_RESPONSE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const text = response.text ?? "";
    console.log("[Gemini] response ←", { ms: Date.now() - t0, len: text.length });
    if (!text) throw new Error("Empty response from Gemini");
    return text;
  }
}------ Gemini provider (@google/genai) ---------------- */
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

class GeminiProvider implements ERDProvider {
  name = "gemini" as const;
  private ai = new GoogleGenAI({}); // uses GEMINI_API_KEY

  async generate(userPrompt: string) {
    console.log("[Gemini] request →", {
      model: GEMINI_MODEL,
      hasKey: !!process.env.GEMINI_API_KEY,
    });
    const t0 = Date.now();
    const response = await this.ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: userPrompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: DIAGRAM_RESPONSE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const text = response.text ?? "";
    console.log("[Gemini] response ←", { ms: Date.now() - t0, len: text.length });
    if (!text) throw new Error("Empty response from Gemini");
    return text;
  }
}

/* ---------------- factory ---------------- */
export function getProvider(model: "gpt5" | "gemini"): ERDProvider {
  return model === "gemini" ? new GeminiProvider() : new OpenAIProvider();
}
