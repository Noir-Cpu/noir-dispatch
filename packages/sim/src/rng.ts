/** mulberry32: tiny seeded PRNG so a run with the same seed makes the same decisions. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hiExclusive: number) => Math.floor(lo + (hiExclusive - lo) * next()),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    /** Poisson-distributed count with the given mean (Knuth; fine for small means). */
    poisson: (mean: number) => {
      const L = Math.exp(-mean);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= next();
      } while (p > L);
      return k - 1;
    },
  };
}
export type Rng = ReturnType<typeof rng>;

/** Nearest-rank percentile; NaN for an empty sample. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
