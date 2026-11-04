// Deterministic pseudo-randomness for the demo seed: the same inputs always give the same estate.

export function hash(s: string): number {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function rng(seed: string): () => number {
  let a = hash(seed); // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: () => number, weighted: [T, number][]): T => {
  const total = weighted.reduce((n, [, w]) => n + w, 0);
  let x = r() * total;
  for (const [v, w] of weighted) if ((x -= w) < 0) return v;
  return weighted[weighted.length - 1]![0];
};

export const isoDaysBefore = (asOf: string, days: number) => new Date(Date.parse(`${asOf}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
