/** VBA-compatible helpers, used by the parity engine. */

/** VBA Round(): banker's rounding (half to even). */
export function vbaRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** VBA Mod: operands rounded to integers, result takes the sign of the dividend (same as JS %). */
export function vbaMod(a: number, b: number): number {
  const r = vbaRound(a) % vbaRound(b);
  return r === 0 ? 0 : r; // normalise -0
}

export const QUALITY_ADJ: Record<string, number> = { A: 0, B: -0.05, C: -0.1 };
export const QUANTITY_ADJ: Record<string, number> = { A: 0, B: 0.025, C: 0.05 };
