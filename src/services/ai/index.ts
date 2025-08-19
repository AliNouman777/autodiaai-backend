// src/services/ai/index.ts
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

import { SYSTEM_PROMPT } from "../../Constant/ERDPrompt";
import { normalizeErd, ZErdLoose } from "../../schemas/erd-ai";

/** Canonical model IDs you support end-to-end */
export type CanonicalModel =
  | "gpt-5"
  | "gpt-5-mini"
  | "gemini-2.5-flash"
  | "gemini-2.5-flash-lite"
  | "deepseek/deepseek-chat-v3-0324:free";

/** Which SDK/provider a canonical model belongs to */
function providerKindFor(model: CanonicalModel): "openai" | "gemini" | "openrouter" {
  if (model.startsWith("gemini-")) return "gemini";
  if (model.startsWith("deepseek/")) return "openrouter";
  return "openai";
}

/** Common interface all providers implement */
export interface ERDProvider {
  name: "openai" | "gemini" | "openrouter";
  generate(
    userPrompt: string,
    model: CanonicalModel,
  ): Promise<ReturnType<typeof validateAndNormalize>>;
  generateStream?(userPrompt: string, model: CanonicalModel): AsyncGenerator<string, void, unknown>;
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

/** Parse -> validate (loose) -> normalize (strict: markers + handle sides + type) */
export function validateAndNormalize(raw: unknown) {
  const obj = typeof raw === "string" ? tryParseJson(raw) : raw;

  const parsed = ZErdLoose.safeParse(obj);
  if (!parsed.success) {
    const first = parsed.error.issues?.[0];
    const where = first?.path?.length ? first.path.join(".") + " " : "";
    throw new Error(`Invalid diagram JSON: ${where}${first?.message || "validation failed"}`);
  }

  // 🔧 Upgrade to strict (adds/repairs markerStart/markerEnd, fixes handle sides, sets type)
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
  // @google/genai requires passing apiKey in the ctor
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
})();

/* ---------------- OpenAI provider ---------------- */
class OpenAIProvider implements ERDProvider {
  name = "openai" as const;

  async generate(userPrompt: string, model: CanonicalModel) {
    if (!(model === "gpt-5" || model === "gpt-5-mini"))
      throw new Error(`OpenAIProvider received unsupported model: ${model}`);

    const run = async () => {
      const resp = await openAIClient.responses.create({
        model,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_output_tokens: 4000,
      });

      const text = resp.output_text ?? "";
      if (!text) throw new Error("Empty response from OpenAI");
      return validateAndNormalize(text);
    };

    return withTimeout(withRetry(run));
  }
}

/* ---------------- Gemini provider ---------------- */
class GeminiProvider implements ERDProvider {
  name = "gemini" as const;

  async generate(userPrompt: string, model: CanonicalModel) {
    if (!(model === "gemini-2.5-flash" || model === "gemini-2.5-flash-lite"))
      throw new Error(`GeminiProvider received unsupported model: ${model}`);

    const run = async () => {
      const resp = await (geminiClient as any).models.generateContent({
        model,
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
          maxOutputTokens: 4000,
        },
        contents: [
          { role: "user", parts: [{ text: `${SYSTEM_PROMPT}\n\nUSER REQUEST:\n${userPrompt}` }] },
        ],
      });

      let text: string | undefined;
      const maybeText = (resp as any).text;
      if (typeof maybeText === "function") text = await maybeText.call(resp);
      else if (typeof maybeText === "string") text = maybeText;
      else if (resp?.response?.candidates?.[0]?.content?.parts) {
        text = resp.response.candidates[0].content.parts
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .join("\n");
      }

      if (process.env.DEBUG) {
        try {
          console.debug("[Gemini] raw resp (truncated):", JSON.stringify(resp).slice(0, 1500));
        } catch {}
        console.debug("[Gemini] text (first 1500 chars):", (text ?? "").slice(0, 1500));
      }

      if (!text || !text.trim()) throw new Error("Empty response from Gemini");
      return validateAndNormalize(text);
    };

    return withTimeout(withRetry(run));
  }
}

/* ---------------- OpenRouter provider ---------------- */
class OpenRouterProvider implements ERDProvider {
  name = "openrouter" as const;
  private endpoint = "https://openrouter.ai/api/v1/chat/completions";

  private buildHeaders() {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
      "Content-Type": "application/json",
    };
    // Optional attribution headers per OpenRouter’s guidelines
    if (process.env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
    if (process.env.OPENROUTER_SITE_NAME) headers["X-Title"] = process.env.OPENROUTER_SITE_NAME;
    return headers;
  }

  async generate(userPrompt: string, model: CanonicalModel) {
    if (!model.startsWith("deepseek/"))
      throw new Error(`OpenRouterProvider received unsupported model: ${model}`);
    if (!process.env.OPENROUTER_API_KEY && process.env.NODE_ENV !== "test") {
      throw Object.assign(new Error("[OpenRouter] OPENROUTER_API_KEY is missing"), { status: 401 });
    }

    const run = async () => {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model,
          temperature: 0,
          // ✅ ask for JSON
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`[OpenRouter] ${res.status} ${res.statusText} ${errBody}`);
      }

      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c: any) => c.text || "").join("\n")
            : "";

      if (!text.trim()) throw new Error("Empty response from OpenRouter");
      return validateAndNormalize(text);
    };

    return withTimeout(withRetry(run));
  }
}

/* ---------------- factory ---------------- */
const openaiProvider = new OpenAIProvider();
const geminiProvider = new GeminiProvider();
const openrouterProvider = new OpenRouterProvider();

export function getProviderFor(model: CanonicalModel): ERDProvider {
  const kind = providerKindFor(model);
  if (kind === "gemini") return geminiProvider;
  if (kind === "openrouter") return openrouterProvider;
  return openaiProvider;
}

/* ---------------- convenience ---------------- */
export async function generateERD(userPrompt: string, model: CanonicalModel) {
  const provider = getProviderFor(model);
  return provider.generate(userPrompt, model);
}
