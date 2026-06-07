export function parseDurationToMs(input: string | undefined, fallbackMs: number): number {
  if (!input) return fallbackMs;
  const m = String(input)
    .trim()
    .match(/^(\d+)\s*([smhd])$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const mult =
    m[2].toLowerCase() === "s"
      ? 1_000
      : m[2].toLowerCase() === "m"
        ? 60_000
        : m[2].toLowerCase() === "h"
          ? 3_600_000
          : 86_400_000;
  return n * mult;
}
