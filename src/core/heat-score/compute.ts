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
 *   - No anti-correlation handling. If foreign buys + dealer sells exactly
 *     cancel, this scores 0 institutional. Real flow analysis would split
 *     them out — defer to next iteration.
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
  const institutional = scoreInstitutionalFlow(inputs.net_intensity);
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

/** Institutional flow signal. `net_intensity` is already normalised to
 *  fraction-of-volume in [-1, 1] typical range. Take absolute value and
 *  scale up so 5% net intensity ≈ 0.46, 10% ≈ 0.76, 20%+ saturates. */
export function scoreInstitutionalFlow(netIntensity?: number): number {
  if (netIntensity === undefined || !Number.isFinite(netIntensity)) return 0;
  return clamp01(Math.tanh(Math.abs(netIntensity) * 10));
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
    parts.push(`三大法人${sign}強度 ${(contrib.net_intensity_abs * 100).toFixed(2)}%`);
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
