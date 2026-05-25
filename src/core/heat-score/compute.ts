/**
 * Heat-score compute — pure functions that combine three signal streams
 * into a single 0-1 ranking per ticker per day.
 *
 * Formula (weighted sum, all components normalised to 0-1):
 *
 *   heat_score = w_inst × institutional_flow_signal
 *              + w_vol  × volume_anomaly_signal
 *              + w_news × news_density_signal
 *
 * Default weights reflect the user's stated signal priority (institutional
 * flow is the #1 heat signal). They are EXPLICITLY not the right answer —
 * the gbrain calibration system will eventually tune them from outcome data.
 * Documented here so an analyst can replace them with one config edit.
 *
 * Why pure functions, not a class: the handler does I/O (reads disk, writes
 * disk); these functions do math. Keeping them separate lets us unit-test
 * the formula without simulating a Minion job context, and lets the eventual
 * cycle-phase migration (BaseCyclePhase subclass) wrap the same primitives.
 *
 * Limitations (documented, not bugs):
 *   - net_intensity is net (外資+投信) as a fraction of volume; if the two
 *     legs cancel, institutional magnitude is small by design.
 *   - Institutional signal = de-saturated magnitude + consecutive-same-
 *     direction streak bonus (see scoreInstitutionalFlow). The streak needs
 *     prior-day net_intensity history; one day of data ⇒ magnitude only.
 *   - Volume z-score assumes ≥10 history points. Below that, falls back to
 *     a tanh-of-ratio against the latest baseline.
 *   - News density caps at 5 mentions/day. A 20-mention day registers the
 *     same as a 5-mention day. Reasonable for mock; revisit when real
 *     news source is online.
 */

export interface HeatWeights {
  institutional_flow: number;
  volume_anomaly: number;
  news_density: number;
}

export const DEFAULT_WEIGHTS: HeatWeights = {
  institutional_flow: 0.45,
  volume_anomaly: 0.30,
  news_density: 0.25,
};

export interface DailyHeatInputs {
  ticker: string;
  /** Today's close, used for context only — not in score formula. */
  close: number;
  /** Today's daily return percent (signed). */
  change_pct: number;
  /** Today's traded volume (shares). */
  volume: number;
  /** Institutional net flow as fraction of volume (signed, [-1, 1] typical).
   *  Source: institutional-flow snapshot `net_intensity` field. */
  net_intensity?: number;
  /** Prior days' net_intensity (signed), newest-first. Drives the
   *  consecutive-same-direction streak bonus. Source: prior institutional-flow
   *  snapshots. Empty / missing ⇒ magnitude-only institutional signal. */
  net_intensity_history?: number[];
  /** Number of times this ticker was mentioned in today's news set.
   *  Source: news summary `ticker_mentions` map. */
  mention_count?: number;
  /** Past N-day volume series for z-score. Order: newest first.
   *  When fewer than 10 entries, the function falls back to a ratio-based
   *  signal against the median of whatever is provided. */
  volume_history?: number[];
}

export interface SignalBreakdown {
  /** Each normalised to [0, 1]. */
  volume_anomaly: number;
  institutional_flow: number;
  news_density: number;
}

export interface ContributingMetrics {
  volume_z_score: number;
  volume_ratio_vs_median: number;
  net_intensity_abs: number;
  /** Consecutive same-direction (淨買 or 淨賣) days incl. today. 1 = no streak. */
  flow_streak_days: number;
  mention_count: number;
}

export interface HeatScoreOutput {
  ticker: string;
  /** Composite [0, 1]. */
  heat_score: number;
  signals: SignalBreakdown;
  contributing: ContributingMetrics;
  /** Why this ranked where it did, human-readable. */
  rationale: string;
}

/** Compute the per-ticker heat score. All three component signals are
 *  normalised to [0, 1] before weighted sum, so missing inputs (e.g. no
 *  news mentions today) contribute 0 rather than skewing the math. */
export function computeHeatScore(
  inputs: DailyHeatInputs,
  weights: HeatWeights = DEFAULT_WEIGHTS,
): HeatScoreOutput {
  const volumeAnomaly = scoreVolumeAnomaly(inputs.volume, inputs.volume_history);
  const institutional = scoreInstitutionalFlow(inputs.net_intensity, inputs.net_intensity_history);
  const newsDensity = scoreNewsDensity(inputs.mention_count);

  const heat = clamp01(
    weights.institutional_flow * institutional +
      weights.volume_anomaly * volumeAnomaly +
      weights.news_density * newsDensity,
  );

  const contributing: ContributingMetrics = {
    volume_z_score: volumeZScore(inputs.volume, inputs.volume_history),
    volume_ratio_vs_median: volumeRatio(inputs.volume, inputs.volume_history),
    net_intensity_abs: Math.abs(inputs.net_intensity ?? 0),
    flow_streak_days: flowStreak(inputs.net_intensity ?? 0, inputs.net_intensity_history),
    mention_count: inputs.mention_count ?? 0,
  };

  return {
    ticker: inputs.ticker,
    heat_score: round4(heat),
    signals: {
      volume_anomaly: round4(volumeAnomaly),
      institutional_flow: round4(institutional),
      news_density: round4(newsDensity),
    },
    contributing: {
      volume_z_score: round4(contributing.volume_z_score),
      volume_ratio_vs_median: round4(contributing.volume_ratio_vs_median),
      net_intensity_abs: round4(contributing.net_intensity_abs),
      flow_streak_days: contributing.flow_streak_days,
      mention_count: contributing.mention_count,
    },
    rationale: buildRationale(inputs, {
      institutional, volumeAnomaly, newsDensity, heat,
    }, contributing),
  };
}

/** Rank a batch by heat_score descending. Stable: ties break by alphabetical
 *  ticker for reproducibility in dashboards / Digests. */
export function rankByHeat(scored: HeatScoreOutput[]): HeatScoreOutput[] {
  return [...scored].sort((a, b) => {
    if (b.heat_score !== a.heat_score) return b.heat_score - a.heat_score;
    return a.ticker.localeCompare(b.ticker);
  });
}

// ===========================================================================
// signal scorers — each independently testable
// ===========================================================================

/** Volume anomaly signal. Maps |z-score| through tanh so 2σ ≈ 0.96, 3σ ≈ 0.995.
 *  Falls back to bounded ratio when history is short or zero-variance. */
export function scoreVolumeAnomaly(volume: number, history?: number[]): number {
  if (volume <= 0) return 0;
  const z = volumeZScore(volume, history);
  if (Number.isFinite(z) && Math.abs(z) > 0.01) {
    return clamp01(Math.tanh(Math.abs(z) / 2));
  }
  // Fallback: bounded ratio vs median (or vs self when no history).
  const r = volumeRatio(volume, history);
  return clamp01(Math.tanh((r - 1) * 0.8));
}

/** Half-saturation point for the institutional magnitude curve: at this
 *  net-intensity the magnitude sub-signal equals 0.5. 12% chosen so the dense
 *  0–50% band keeps differentiating, instead of the old tanh(×10) pegging
 *  everything above ~25% at 100. */
export const INST_HALF_SATURATION = 0.12;
/** Each consecutive same-direction day beyond the first adds this much to the
 *  institutional signal (persistence / conviction bonus). */
export const STREAK_BONUS_PER_DAY = 0.06;
/** Cap the streak bonus at this many extra days (max bonus = 0.06 × 5 = 0.30). */
export const STREAK_BONUS_CAP_DAYS = 5;

/** Consecutive same-direction days INCLUDING today. `history` is the prior
 *  days' net_intensity, newest-first. A zero or opposite-sign day breaks the
 *  run. Returns 0 when today's flow is zero/flat. */
export function flowStreak(todayNetIntensity: number, history?: number[]): number {
  const sign = Math.sign(todayNetIntensity);
  if (sign === 0) return 0;
  let streak = 1; // today
  if (history) {
    for (const x of history) {
      if (Math.sign(x) === sign) streak++;
      else break;
    }
  }
  return streak;
}

/** Institutional flow signal = de-saturated magnitude + persistence bonus.
 *
 *    magnitude   = |net_intensity| / (|net_intensity| + INST_HALF_SATURATION)
 *                  monotonic, never flat-tops, half-saturates at 12%.
 *    persistence = +STREAK_BONUS_PER_DAY per consecutive same-direction day
 *                  beyond the first (capped) — needs `flowHistory`.
 *
 *  A one-day flow shock scores on magnitude alone (no penalty); sustained
 *  accumulation / distribution earns the streak bonus on top. `net_intensity`
 *  is signed net (外資+投信) as a fraction of volume. Old behaviour was
 *  tanh(|x|×10), which saturated near 1.0 above ~25% and could not rank the
 *  most-active names apart. */
export function scoreInstitutionalFlow(netIntensity?: number, flowHistory?: number[]): number {
  if (netIntensity === undefined || !Number.isFinite(netIntensity) || netIntensity === 0) {
    return 0;
  }
  const abs = Math.abs(netIntensity);
  const magnitude = abs / (abs + INST_HALF_SATURATION);
  const streak = flowStreak(netIntensity, flowHistory);
  const bonus = STREAK_BONUS_PER_DAY * Math.min(Math.max(streak - 1, 0), STREAK_BONUS_CAP_DAYS);
  return clamp01(magnitude + bonus);
}

/** News density signal. Caps at 5 mentions per day. Above that returns 1.
 *  Documented in module header — revisit when real news source is online. */
export function scoreNewsDensity(mentionCount?: number): number {
  if (!mentionCount || mentionCount <= 0) return 0;
  return clamp01(mentionCount / 5);
}

// ===========================================================================
// helpers (private)
// ===========================================================================

function volumeZScore(volume: number, history?: number[]): number {
  if (!history || history.length < 10) return 0;
  const mean = history.reduce((s, x) => s + x, 0) / history.length;
  const variance =
    history.reduce((s, x) => s + (x - mean) * (x - mean), 0) / history.length;
  const std = Math.sqrt(variance);
  if (std <= 0) return 0;
  return (volume - mean) / std;
}

function volumeRatio(volume: number, history?: number[]): number {
  if (!history || history.length === 0) return 1;
  const sorted = [...history].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  if (median <= 0) return 1;
  return volume / median;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function buildRationale(
  inputs: DailyHeatInputs,
  scores: { institutional: number; volumeAnomaly: number; newsDensity: number; heat: number },
  contrib: ContributingMetrics,
): string {
  const parts: string[] = [];
  if (scores.institutional > 0.3) {
    const sign = (inputs.net_intensity ?? 0) >= 0 ? '淨買' : '淨賣';
    let line = `法人(外資+投信)${sign}強度 ${(contrib.net_intensity_abs * 100).toFixed(2)}%`;
    if (contrib.flow_streak_days >= 2) line += `，連 ${contrib.flow_streak_days} 日${sign}`;
    parts.push(line);
  }
  if (scores.volumeAnomaly > 0.3) {
    if (Math.abs(contrib.volume_z_score) > 0.5) {
      parts.push(`成交量 z=${contrib.volume_z_score.toFixed(2)}σ`);
    } else {
      parts.push(`成交量為中位 ${contrib.volume_ratio_vs_median.toFixed(2)}x`);
    }
  }
  if (scores.newsDensity > 0.3) {
    parts.push(`新聞提及 ${contrib.mention_count} 次`);
  }
  if (parts.length === 0) {
    return '無顯著訊號';
  }
  return parts.join('，');
}
