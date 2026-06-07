// src/services/diagrams/ai.ts
import * as nodeCrypto from "node:crypto";
import aicacheModel from "../../models/aicache.model";
import { normalizeErd } from "../../schemas/erd-ai";
import { getProviderFor, type CanonicalModel } from "../ai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, { attempts = 3, baseDelayMs = 400 } = {}) {
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
      const backoff = baseDelayMs * 2 ** i + Math.random() * 100;
      if (process.env.DEBUG) console.warn(`[AI] retry after ${backoff}ms due to ${status}`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function withTimeout<T>(p: Promise<T>, ms = 180000) {
  let t: any;
  try {
    return await Promise.race([
      p,
      new Promise<never>(
        (_, rej) => (t = setTimeout(() => rej(new Error("AI request timed out")), ms)),
      ),
    ]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Gemini-only execution. Returns:
 *  - { nodes, edges, message? } OR
 *  - { ops, message? }
 */
export async function hedgedGenerate(prompt: string, primary: CanonicalModel) {
  const provider = getProviderFor(primary);
  const run = () => provider.generate(prompt, primary);
  return withTimeout(withRetry(run));
}

/* ---- cache helper (legacy full ERD) ---- */
function makeKey(model: string, prompt: string, diagramVersion?: number) {
  const norm = prompt.trim().replace(/\s+/g, " ");
  const v = typeof diagramVersion === "number" ? `::v${diagramVersion}` : "";
  return `${model}${v}::` + nodeCrypto.createHash("sha256").update(norm).digest("hex");
}

/**
 * Legacy full-ERD path with aicache.
 * Keeps behavior but now only uses Gemini under the hood.
 */
export async function generateFromPrompt({
  prompt,
  model,
  titleOverride,
  diagramVersion,
}: {
  prompt: string;
  model: CanonicalModel;
  titleOverride?: string;
  diagramVersion?: number;
}) {
  const key = makeKey(model, prompt, diagramVersion);
  const hit = await aicacheModel.findOne({ key }).lean();
  if (hit) {
    const payload = hit.payload;
    const title =
      typeof payload?.title === "string" && payload.title.trim()
        ? payload.title.trim()
        : "Untitled Diagram";
    const strict = normalizeErd({ nodes: payload?.nodes ?? [], edges: payload?.edges ?? [] });
    return {
      title: titleOverride || title,
      nodes: strict.nodes,
      edges: strict.edges,
      prompt,
      model,
      message: payload?.message, // if you ever cached it
    };
  }

  const result = await hedgedGenerate(prompt, model);
  const strict = normalizeErd({ nodes: result.nodes ?? [], edges: result.edges ?? [] });
  const out = {
    title: titleOverride || "Untitled Diagram",
    nodes: strict.nodes,
    edges: strict.edges,
    message: result.message,
  };

  await aicacheModel.create({ key, raw: JSON.stringify(out), payload: out });
  return { ...out, prompt, model };
}
