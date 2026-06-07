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
  const parsed = ZErdLoose.safeParse(obj);
  if (!parsed.success) {
    const first = parsed.error.issues?.[0];
    const where = first?.path?.length ? first.path.join(".") + " " : "";
    throw new Error(`Invalid diagram JSON: ${where}${first?.message || "validation failed"}`);
  }
  return normalizeErd(parsed.data);
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
