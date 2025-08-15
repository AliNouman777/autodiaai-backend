// src/services/ai.ts
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { DiagramPayload } from "../../schemas/diagram.schema";

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
  generate(userPrompt: string, model: CanonicalModel): Promise<ReturnType<typeof validateDiagram>>;
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

export function validateDiagram(raw: any) {
  const obj = typeof raw === "string" ? tryParseJson(raw) : raw;
  const parsed = (DiagramPayload as any).safeParse(obj);
  if (!parsed.success) {
    if (process.env.DEBUG) {
      const preview = (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 500);
      console.warn("[ERD] Invalid JSON preview:", preview);
      console.warn("[ERD] Issues:", parsed.error.flatten());
    }
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

export const SYSTEM_PROMPT = `You are a helpful and precise assistant that converts natural language descriptions of database models into JSON data for an Entity Relationship Diagram (ERD). Follow the rules strictly.
[... your full SYSTEM_PROMPT content here ...]`;

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
      return validateDiagram(text);
    };

    return withTimeout(withRetry(run));
  }
}

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
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\nUSER REQUEST:\n${userPrompt}` }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
          maxOutputTokens: 4000,
        },
      });

      let text: string | undefined;
      const maybeText = (resp as any).text;
      if (typeof maybeText === "function") {
        text = await maybeText.call(resp);
      } else if (typeof maybeText === "string") {
        text = maybeText;
      } else if (Array.isArray((resp as any).candidates)) {
        const c = (resp as any).candidates[0];
        const parts = c?.content?.parts;
        if (Array.isArray(parts)) {
          text = parts
            .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
            .filter(Boolean)
            .join("\n");
        }
      }

      if (!text || !text.trim()) throw new Error("Empty response from Gemini");
      return validateDiagram(text);
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
    if (process.env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
    if (process.env.OPENROUTER_SITE_NAME) headers["X-Title"] = process.env.OPENROUTER_SITE_NAME;
    return headers;
  }

  async generate(userPrompt: string, model: CanonicalModel) {
    if (!model.startsWith("deepseek/")) {
      throw new Error(`OpenRouterProvider received unsupported model: ${model}`);
    }
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
      return validateDiagram(text);
    };

    return withTimeout(withRetry(run));
  }

  async *generateStream(userPrompt: string, model: CanonicalModel) {
    if (!model.startsWith("deepseek/")) {
      throw new Error(`OpenRouterProvider received unsupported model: ${model}`);
    }

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        model,
        temperature: 0,
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`[OpenRouter] Streaming failed with status ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        if (part.startsWith("data: ")) {
          const data = part.slice(6);
          if (data === "[DONE]") return;
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // ignore malformed
          }
        }
      }
    }
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
