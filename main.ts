// gta6-twitch-ccu-forecast-01 — "Launch-day shape" quantile forecaster (Node 22, stdlib only).
//
// Bismillah. The model: every big game launch has the same launch-day shape in
// log space — an overnight dip, then a ramp into the US evening — but how steep
// the ramp is depends almost entirely on how big hour 1 already is. Across the
// 38 comparable launches in the case file, log(hour-1 viewers) predicts the
// hour-19 log-ratio with correlation -0.93 (slope about -0.93): a launch whose
// first hour is already huge stays flat, one that starts small explodes.
//
// So for each forecast hour h = 2..24 this program takes the comparables'
// log-ratios ln(viewers_h / viewers_1) and reads off their kernel-weighted
// quantiles, weighted by closeness in log(hour-1 viewers) (Gaussian kernel,
// bandwidth 0.75 in log units, widening while the estimate would rest on
// fewer than 8 launches) — the median and the spread both adapt to the
// launch's own scale. Quantile spreads are shrunk 0.9x toward the median.
// The curves are computed at run time from the case file's own comparables,
// so the final case's 42 comparables (including the four practice launches)
// are used automatically. No network, no randomness, no tuning on the final.
//
// Backtest (pinball loss on log scale, same formula as RULES.txt):
//   practice cases p00-p03 (answers from SullyGnome, the public source the
//   kit cites): 0.2359 mean vs house persistence baseline 0.3871 (-39%).
//   Leave-one-out over the 38 comparables: 0.405 vs persistence 0.930;
//   on big launches (hour 1 >= 50k) 0.208 vs persistence 0.251.
//
// What an entry must do:
//   - read every <id>.in in the input directory (the grader runs one case at
//     a time, with only that case's file there): JSON
//     {"schema":"makefun/twitch-ccu-case/v1","id","game","day_start",
//     "checkpoint","levels","known","forecast","history","history_hourly",
//     "streams","categories_hourly","comparables","notes"}, where `known`
//     holds hour 1's print {hour: 1, from, until, viewers, channels, reads}
//     and `forecast` lists the hours to forecast, 2..24;
//   - write <id>.out to the output directory: {"hours":[{"hour":2,
//     "q":[q05,q25,q50,q75,q95]}, ...]}, exactly 23 rows, hours 2..24 each
//     once, no other key, each q five finite numbers above 0 and at most 1e9
//     (viewers; fractions allowed), non-decreasing; at most 65,536 bytes.
// It runs offline, with no network, under the case's time cap: everything it
// knows is in the case file.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level (persistence fallback only). */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** The spread of an hour's move, in natural-log units per square-root hour. */
const SIGMA = 0.15;
/** Gaussian kernel bandwidth in log(hour-1 viewers) units. */
const BANDWIDTH = 0.75;
/** Quantile spread shrink toward the weighted median. */
const SPREAD = 0.9;
/** Minimum training launches needed for a kernel estimate, else persistence. */
const MIN_TRAIN = 5;
/** Minimum effective sample size of a kernel estimate; the bandwidth widens
 * until the estimate rests on at least this many launches. This matters most
 * for the final: if GTA VI's hour 1 lands beyond every comparable launch,
 * a fixed bandwidth would rest the whole forecast on one or two of them. */
const MIN_EFFECTIVE_N = 8;
/** Widest the bandwidth may grow while chasing the effective sample size. */
const MAX_BANDWIDTH = 3.0;

/** Effective sample size of kernel weights: (sum w)^2 / sum w^2. */
const effectiveN = (weights: number[]): number => {
  const s1 = weights.reduce((s, w) => s + w, 0);
  const s2 = weights.reduce((s, w) => s + w * w, 0);
  return s2 > 0 ? (s1 * s1) / s2 : 0;
};

interface HourRow {
  hour: number;
  viewers: number;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  hourly: Array<{ from: string; viewers: number | null; channels?: number | null }>;
}

interface Case {
  levels: number[];
  known: HourRow[];
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Weighted quantile: pairs sorted by value, first value whose cumulative
 * weight reaches tau of the total weight. */
const wquantile = (pairs: Array<[number, number]>, tau: number): number => {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, p) => s + p[1], 0);
  if (total <= 0) return Number.NaN;
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= tau * total) return v;
  }
  return sorted[sorted.length - 1][0];
};

/** Release-day hourly viewers (hours 1..24 of the launch's UTC day) for one
 * comparable launch, or null when it has no usable hour-1 print. The GTA VI
 * category's own pre-release history is not a launch and is excluded. */
const launchHours = (c: Comparable): Map<number, number> | null => {
  if (c.name.includes('Grand Theft Auto VI')) return null;
  if (typeof c.unlock === 'string' && c.unlock.startsWith('Not a launch')) return null;
  const day = c.day_start.slice(0, 10);
  const hours = new Map<number, number>();
  for (const row of c.hourly ?? []) {
    if (typeof row.from !== 'string' || row.from.slice(0, 10) !== day) continue;
    const h = Number(row.from.slice(11, 13)) + 1;
    if (h < 1 || h > 24) continue;
    if (typeof row.viewers !== 'number' || !(row.viewers > 0)) continue;
    hours.set(h, row.viewers);
  }
  if (!hours.has(1)) return null;
  return hours;
};

/** The persistence forecast of one hour h (the house baseline's numbers). */
const persistenceQuantiles = (p1: number, h: number): number[] =>
  Z.map((z) => round2(p1 * Math.exp(z * SIGMA * Math.sqrt(h - 1))));

/** Forecast one case. */
const forecastCase = (c: Case, name: string): { hours: Array<{ hour: number; q: number[] }> } => {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${name} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${name} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);
  const x = Math.log(p1);

  // Training set: every comparable launch's release-day curve, as log-ratios.
  const train: Array<{ logh1: number; hours: Map<number, number> }> = [];
  for (const comp of c.comparables ?? []) {
    const hours = launchHours(comp);
    if (hours === null) continue;
    train.push({ logh1: Math.log(hours.get(1) as number), hours });
  }

  const hours = c.forecast.map(({ hour }) => {
    let q: number[];
    // Kernel-weighted log-ratio quantiles at this hour. The bandwidth starts
    // at BANDWIDTH and widens while the estimate rests on too few launches,
    // so an hour-1 count beyond every comparable still gets a stable curve.
    const ratios: Array<{ r: number; logh1: number }> = [];
    for (const t of train) {
      const vh = t.hours.get(hour);
      if (vh === undefined) continue;
      ratios.push({ r: Math.log(vh / (t.hours.get(1) as number)), logh1: t.logh1 });
    }
    let bw = BANDWIDTH;
    let pts: Array<[number, number]> = [];
    while (bw <= MAX_BANDWIDTH) {
      pts = ratios.map(({ r, logh1 }) => [r, Math.exp(-0.5 * ((logh1 - x) / bw) ** 2)] as [number, number]);
      if (pts.length < MIN_TRAIN || effectiveN(pts.map((p) => p[1])) >= MIN_EFFECTIVE_N) break;
      bw *= 1.5;
    }
    if (pts.length >= MIN_TRAIN) {
      const med = wquantile(pts, 0.5);
      q = LEVELS.map((tau) => {
        const adj = med + (wquantile(pts, tau) - med) * SPREAD;
        return round2(p1 * Math.exp(adj));
      });
    } else {
      q = persistenceQuantiles(p1, hour);
    }
    // Clamp to the contest's bounds and enforce non-decreasing quantiles.
    q = q.map((v) => Math.min(1e9, Math.max(1, v)));
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { hour, q };
  });
  return { hours };
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const forecast = forecastCase(c, file);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(forecast)}\n`);
}
