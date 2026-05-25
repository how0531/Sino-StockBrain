/**
 * Unit tests for src/core/heat-score/compute.ts.
 *
 * Pure-function tests — no env mutation, no mock.module, no PGLite. Safe
 * to run as part of the parallel fast loop. Pinned coverage:
 *   - All three signal scorers (volume / institutional / news) with their
 *     edge cases (zero, undefined, NaN, saturation)
 *   - Volume z-score vs ratio-fallback boundary at history >= 10
 *   - Weighted-sum math + custom weight override
 *   - Bound enforcement (heat_score always in [0, 1])
 *   - Determinism (same input → same output)
 *   - Rationale string contains the expected signal mentions
 *   - rankByHeat ordering + alphabetical tiebreaker + non-mutation
 *
 * Intentionally NOT covered here (separate concern):
 *   - The market-heat handler's I/O layer (disk read / write). That's a
 *     handler-level concern; tested via the demo script + a future
 *     handler-specific integration test.
 */

import { test, expect, describe } from 'bun:test';
import {
  computeHeatScore,
  rankByHeat,
  scoreVolumeAnomaly,
  scoreInstitutionalFlow,
  scoreNewsDensity,
  DEFAULT_WEIGHTS,
  type HeatScoreOutput,
  type HeatWeights,
} from '../src/core/heat-score/compute.ts';

// ===========================================================================
// scoreVolumeAnomaly
// ===========================================================================

describe('scoreVolumeAnomaly', () => {
  test('zero volume returns 0', () => {
    expect(scoreVolumeAnomaly(0)).toBe(0);
    expect(scoreVolumeAnomaly(0, [1_000_000, 2_000_000])).toBe(0);
  });

  test('no history with positive volume returns 0 (no signal possible)', () => {
    // ratio against self is 1, tanh((1-1) * 0.8) = 0
    expect(scoreVolumeAnomaly(1_000_000)).toBe(0);
  });

  test('short history (<10) uses ratio fallback against median', () => {
    const history = [1_000_000, 1_100_000, 900_000]; // median = 1M
    // ratio = 2.0 → tanh((2-1) * 0.8) = tanh(0.8) ≈ 0.664
    const score = scoreVolumeAnomaly(2_000_000, history);
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThan(0.75);
  });

  test('long history with clear volume spike returns score > 0.9', () => {
    // Tight history: mean=1M, std≈50k. Today's spike to 1.4M ⇒ ~8σ.
    const history = Array.from({ length: 30 }, (_, i) =>
      1_000_000 + (i % 2 === 0 ? 50_000 : -50_000),
    );
    const score = scoreVolumeAnomaly(1_400_000, history);
    expect(score).toBeGreaterThan(0.9);
  });

  test('zero-variance history falls through to ratio fallback', () => {
    const flat = new Array(20).fill(1_000_000);
    const score = scoreVolumeAnomaly(2_000_000, flat);
    expect(score).toBeGreaterThan(0); // fallback fires, doesn't divide by 0
  });

  test('signal is bounded at [0, 1]', () => {
    const history = new Array(30).fill(1_000_000);
    // Absurdly large spike
    expect(scoreVolumeAnomaly(1_000_000_000_000, history)).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// scoreInstitutionalFlow
// ===========================================================================

describe('scoreInstitutionalFlow (de-saturated magnitude + streak bonus)', () => {
  test('undefined returns 0', () => {
    expect(scoreInstitutionalFlow(undefined)).toBe(0);
  });

  test('zero returns 0', () => {
    expect(scoreInstitutionalFlow(0)).toBe(0);
  });

  test('NaN / Infinity returns 0 (defensive)', () => {
    expect(scoreInstitutionalFlow(Number.NaN)).toBe(0);
    expect(scoreInstitutionalFlow(Number.POSITIVE_INFINITY)).toBe(0);
    expect(scoreInstitutionalFlow(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  test('magnitude half-saturates at 12% (no history → magnitude only)', () => {
    // 0.12 / (0.12 + 0.12) = 0.5
    expect(scoreInstitutionalFlow(0.12)).toBeCloseTo(0.5, 4);
  });

  test('5% → ~0.294, 10% → ~0.455 (magnitude only)', () => {
    expect(scoreInstitutionalFlow(0.05)).toBeCloseTo(0.05 / 0.17, 4);
    expect(scoreInstitutionalFlow(0.1)).toBeCloseTo(0.1 / 0.22, 4);
  });

  test('negative intensity treated same as positive (abs value)', () => {
    expect(scoreInstitutionalFlow(-0.05)).toBe(scoreInstitutionalFlow(0.05));
    expect(scoreInstitutionalFlow(-0.2)).toBe(scoreInstitutionalFlow(0.2));
  });

  test('does NOT saturate near 1 without a streak (de-saturation fix)', () => {
    // old tanh(×10) returned >0.99 here; hyperbolic stays well below 1.
    expect(scoreInstitutionalFlow(0.5)).toBeCloseTo(0.5 / 0.62, 4); // ≈0.806
    expect(scoreInstitutionalFlow(0.5)).toBeLessThan(0.85);
    expect(scoreInstitutionalFlow(1.0)).toBeLessThan(0.9);
  });

  test('magnitude is monotonic across the dense 30-50% band', () => {
    const a = scoreInstitutionalFlow(0.3);
    const b = scoreInstitutionalFlow(0.4);
    const c = scoreInstitutionalFlow(0.48);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b); // old formula pegged all three at ~1.0
  });

  test('streak bonus: 5 consecutive same-direction days add +0.24', () => {
    const oneDay = scoreInstitutionalFlow(0.1, []); // streak 1, no bonus
    const fiveDay = scoreInstitutionalFlow(0.1, [0.08, 0.06, 0.05, 0.04]); // streak 5
    expect(fiveDay).toBeGreaterThan(oneDay);
    expect(fiveDay).toBeCloseTo(0.1 / 0.22 + 0.24, 4); // +0.06 × 4
  });

  test('streak bonus caps at +0.30 (5 extra days)', () => {
    const many = new Array(20).fill(0.1); // huge streak
    expect(scoreInstitutionalFlow(0.1, many)).toBeCloseTo(0.1 / 0.22 + 0.3, 4);
  });

  test('opposite-sign prior day breaks the streak (magnitude only)', () => {
    // today +, yesterday − → streak 1, no bonus
    expect(scoreInstitutionalFlow(0.1, [-0.05, 0.08])).toBeCloseTo(0.1 / 0.22, 4);
  });

  test('signal is bounded at [0, 1]', () => {
    expect(scoreInstitutionalFlow(10, new Array(30).fill(10))).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// scoreNewsDensity
// ===========================================================================

describe('scoreNewsDensity', () => {
  test('undefined returns 0', () => {
    expect(scoreNewsDensity(undefined)).toBe(0);
  });

  test('zero mentions returns 0', () => {
    expect(scoreNewsDensity(0)).toBe(0);
  });

  test('negative mentions returns 0 (defensive)', () => {
    expect(scoreNewsDensity(-1)).toBe(0);
  });

  test('1-4 mentions scale linearly 0.2 - 0.8', () => {
    expect(scoreNewsDensity(1)).toBeCloseTo(0.2);
    expect(scoreNewsDensity(2)).toBeCloseTo(0.4);
    expect(scoreNewsDensity(3)).toBeCloseTo(0.6);
    expect(scoreNewsDensity(4)).toBeCloseTo(0.8);
  });

  test('5 mentions = full signal (1.0)', () => {
    expect(scoreNewsDensity(5)).toBe(1);
  });

  test('>5 mentions cap at 1.0 (documented limit)', () => {
    expect(scoreNewsDensity(10)).toBe(1);
    expect(scoreNewsDensity(100)).toBe(1);
  });
});

// ===========================================================================
// computeHeatScore — composite scoring
// ===========================================================================

describe('computeHeatScore', () => {
  test('all inputs zero → heat_score 0', () => {
    const out = computeHeatScore({
      ticker: 'TEST', close: 100, change_pct: 0, volume: 0,
    });
    expect(out.heat_score).toBe(0);
    expect(out.signals.institutional_flow).toBe(0);
    expect(out.signals.volume_anomaly).toBe(0);
    expect(out.signals.news_density).toBe(0);
  });

  test('only institutional signal scales by w_inst weight', () => {
    const out = computeHeatScore({
      ticker: 'TEST', close: 100, change_pct: 0, volume: 0,
      net_intensity: 0.5,
      // long same-direction streak: magnitude 0.806 + bonus 0.30 → clamp 1.0
      net_intensity_history: [0.5, 0.5, 0.5, 0.5, 0.5],
    });
    // heat ≈ 0.45 × 1.0 ≈ 0.45
    expect(out.heat_score).toBeCloseTo(DEFAULT_WEIGHTS.institutional_flow, 2);
  });

  test('only news signal scales by w_news weight', () => {
    const out = computeHeatScore({
      ticker: 'TEST', close: 100, change_pct: 0, volume: 0,
      mention_count: 5, // full news signal
    });
    expect(out.heat_score).toBeCloseTo(DEFAULT_WEIGHTS.news_density, 4);
  });

  test('custom weights override defaults', () => {
    const w: HeatWeights = {
      institutional_flow: 1.0, volume_anomaly: 0, news_density: 0,
    };
    const out = computeHeatScore(
      { ticker: 'TEST', close: 100, change_pct: 0, volume: 0, net_intensity: 0.5,
        net_intensity_history: [0.5, 0.5, 0.5, 0.5, 0.5] },
      w,
    );
    expect(out.heat_score).toBeGreaterThan(0.99);
  });

  test('missing optional signals contribute 0 without breaking math', () => {
    const out = computeHeatScore({
      ticker: 'TEST', close: 100, change_pct: 1, volume: 1_000_000,
      // no net_intensity, no mention_count, no volume_history
    });
    expect(Number.isFinite(out.heat_score)).toBe(true);
    expect(out.heat_score).toBe(0);
  });

  test('deterministic — same inputs produce identical output', () => {
    const inputs = {
      ticker: 'TEST', close: 100, change_pct: 2, volume: 1_500_000,
      net_intensity: 0.08, mention_count: 3,
      volume_history: Array.from({ length: 30 }, (_, i) => 1_000_000 + i * 5_000),
    };
    expect(computeHeatScore(inputs)).toEqual(computeHeatScore(inputs));
  });

  test('heat_score always bounded [0, 1] even with absurd inputs and weights', () => {
    const out = computeHeatScore(
      {
        ticker: 'TEST', close: 100, change_pct: 100, volume: 1e15,
        net_intensity: 1.0, mention_count: 1_000_000,
        volume_history: new Array(30).fill(1),
      },
      { institutional_flow: 100, volume_anomaly: 100, news_density: 100 },
    );
    expect(out.heat_score).toBeLessThanOrEqual(1);
    expect(out.heat_score).toBeGreaterThanOrEqual(0);
  });

  test('rationale mentions all signals above threshold (0.3)', () => {
    const out = computeHeatScore({
      ticker: 'TEST', close: 100, change_pct: 3, volume: 5_000_000,
      net_intensity: 0.15, // > 0.3 signal
      mention_count: 4,    // > 0.3 signal
      volume_history: Array.from({ length: 30 }, (_, i) => 1_000_000 + i * 20_000),
    });
    expect(out.rationale).toContain('法人');
    expect(out.rationale).toContain('成交量');
    expect(out.rationale).toContain('新聞');
  });

  test('rationale degrades to "無顯著訊號" when no signal exceeds threshold', () => {
    const out = computeHeatScore({
      ticker: 'TEST', close: 100, change_pct: 0, volume: 0,
    });
    expect(out.rationale).toContain('無顯著訊號');
  });

  test('contributing metrics carry raw values for transparency', () => {
    const out = computeHeatScore({
      ticker: 'TEST', close: 100, change_pct: 1, volume: 2_000_000,
      net_intensity: 0.12,
      mention_count: 4,
      volume_history: Array.from({ length: 20 }, (_, i) => 1_000_000 + i * 10_000),
    });
    expect(out.contributing.net_intensity_abs).toBeCloseTo(0.12, 2);
    expect(out.contributing.mention_count).toBe(4);
    expect(typeof out.contributing.volume_z_score).toBe('number');
    expect(typeof out.contributing.volume_ratio_vs_median).toBe('number');
  });

  test('round-trip: ticker name preserved in output', () => {
    const out = computeHeatScore({
      ticker: '2330', close: 1100, change_pct: 0, volume: 0,
    });
    expect(out.ticker).toBe('2330');
  });
});

// ===========================================================================
// rankByHeat
// ===========================================================================

describe('rankByHeat', () => {
  test('orders descending by heat_score', () => {
    const scored = ['A', 'B', 'C'].map((t, i) =>
      computeHeatScore({
        ticker: t, close: 100, change_pct: 0, volume: 0,
        net_intensity: 0.05 * (i + 1),
      }),
    );
    const ranked = rankByHeat(scored);
    expect(ranked[0]!.ticker).toBe('C');
    expect(ranked[1]!.ticker).toBe('B');
    expect(ranked[2]!.ticker).toBe('A');
  });

  test('ties broken alphabetically (deterministic)', () => {
    // Three items with identical heat_score
    const tied: HeatScoreOutput[] = ['Z', 'A', 'M'].map((t) => ({
      ticker: t,
      heat_score: 0.5,
      signals: { volume_anomaly: 0.5, institutional_flow: 0.5, news_density: 0.5 },
      contributing: {
        volume_z_score: 0, volume_ratio_vs_median: 1,
        net_intensity_abs: 0, flow_streak_days: 0, mention_count: 0,
      },
      rationale: '',
    }));
    const ranked = rankByHeat(tied);
    expect(ranked.map((r) => r.ticker)).toEqual(['A', 'M', 'Z']);
  });

  test('does not mutate input array', () => {
    const items: HeatScoreOutput[] = [
      { ticker: 'B', heat_score: 0.5, signals: { volume_anomaly: 0, institutional_flow: 0, news_density: 0 }, contributing: { volume_z_score: 0, volume_ratio_vs_median: 1, net_intensity_abs: 0, flow_streak_days: 0, mention_count: 0 }, rationale: '' },
      { ticker: 'A', heat_score: 0.9, signals: { volume_anomaly: 0, institutional_flow: 0, news_density: 0 }, contributing: { volume_z_score: 0, volume_ratio_vs_median: 1, net_intensity_abs: 0, flow_streak_days: 0, mention_count: 0 }, rationale: '' },
    ];
    const before = items.map((i) => i.ticker);
    rankByHeat(items);
    expect(items.map((i) => i.ticker)).toEqual(before);
  });

  test('empty array returns empty', () => {
    expect(rankByHeat([])).toEqual([]);
  });

  test('single element returns that element', () => {
    const one: HeatScoreOutput = {
      ticker: 'X', heat_score: 0.3,
      signals: { volume_anomaly: 0, institutional_flow: 0, news_density: 0 },
      contributing: { volume_z_score: 0, volume_ratio_vs_median: 1, net_intensity_abs: 0, flow_streak_days: 0, mention_count: 0 },
      rationale: '',
    };
    expect(rankByHeat([one])).toEqual([one]);
  });
});
