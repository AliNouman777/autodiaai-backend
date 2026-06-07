// src/utils/redirect.ts
export function resolveSafeRedirect(frontendUrl: string, candidate?: string): string {
  try {
    if (!candidate) return new URL("/diagram", frontendUrl).toString();
    if (candidate.startsWith("/") && !candidate.startsWith("//")) {
      return new URL(candidate, frontendUrl).toString();
    }
  } catch {}
  return new URL("/diagram", frontendUrl).toString();
}
