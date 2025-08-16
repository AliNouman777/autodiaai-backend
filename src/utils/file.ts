// src/utils/file.ts
export function sanitizeFilename(name: string, fallback = "diagram") {
  const base = (name || fallback)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return base || fallback;
}
