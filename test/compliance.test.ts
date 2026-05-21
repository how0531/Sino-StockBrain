/**
 * Compliance filter unit tests — pure-function coverage of:
 *   - runDeterministicPass (regex layer)
 *   - parseJudgeOutput (LLM JSON parser)
 *   - aggregateVerdict (verdict combination)
 *
 * The handler I/O layer is covered by the demo runner + manual e2e.
 * No mock.module, no env mutation, no PGLite — safe for fast loop.
 */

import { test, expect, describe } from 'bun:test';
import { runDeterministicPass } from '../src/core/compliance/deterministic-pass.ts';
import { parseJudgeOutput, runLlmJudge } from '../src/core/compliance/llm-judge.ts';
import { aggregateVerdict } from '../src/core/compliance/aggregate.ts';
import type { Violation } from '../src/core/compliance/rubric.ts';

// ===========================================================================
// runDeterministicPass
// ===========================================================================

describe('runDeterministicPass', () => {
  test('clean digest passes with zero violations', () => {
    const text = `
# Daily Digest 2026-05-20

外資連 3 日買超 [[tickers/2330]] 5 萬張。
成交量為 30 日均量 5 倍。
下週法說會將揭露 Q1 毛利率指引。
`;
    expect(runDeterministicPass(text)).toEqual([]);
  });

  test('catches "建議買進" as critical', () => {
    const text = '我建議買進台積電，現在是好時機。';
    const violations = runDeterministicPass(text);
    expect(violations.length).toBeGreaterThan(0);
    const crit = violations.find((v) => v.severity === 'critical');
    expect(crit).toBeDefined();
    expect(crit!.type).toBe('buy_sell_recommendation');
    expect(crit!.caught_by).toBe('deterministic');
  });

  test('catches "應加碼" as critical', () => {
    const text = '投資人應加碼半導體板塊。';
    const violations = runDeterministicPass(text);
    expect(violations.some((v) => v.severity === 'critical')).toBe(true);
  });

  test('catches "目標價 1500" as warning (uncited)', () => {
    const text = '券商目標價 1500 元。';
    const violations = runDeterministicPass(text);
    // Should catch the uncited target price.
    expect(violations.some((v) => v.type === 'target_price_uncited')).toBe(true);
  });

  test('catches "肯定會漲" as warning (absolute certainty)', () => {
    const text = '台積電下週肯定會漲。';
    const violations = runDeterministicPass(text);
    expect(violations.some((v) => v.type === 'absolute_certainty')).toBe(true);
  });

  test('catches "您應該買" as critical (personalized advice)', () => {
    const text = '您應該買進這檔股票。';
    const violations = runDeterministicPass(text);
    expect(violations.some((v) => v.type === 'personalized_advice')).toBe(true);
  });

  test('catches future-prediction-unsourced', () => {
    const text = '台積電將漲到 1200 元。';
    const violations = runDeterministicPass(text);
    expect(violations.some((v) => v.type === 'future_prediction_unsourced')).toBe(true);
  });

  test('dedups same violation type across same quote', () => {
    const text = '建議買進台積電。建議買進台積電。';
    const violations = runDeterministicPass(text);
    // Two sentences, but they're identical text → should dedup to 1.
    expect(violations.filter((v) => v.type === 'buy_sell_recommendation').length).toBe(1);
  });

  test('quote includes the full sentence (paste-ready)', () => {
    const text = '本週外資積極買盤。建議買進台積電。然後…';
    const v = runDeterministicPass(text)[0]!;
    expect(v.quote).toContain('建議買進');
    expect(v.quote).toContain('台積電'); // full sentence
  });

  test('location tracks the nearest preceding heading', () => {
    const text = `# Top 5

## 1. 台積電

建議買進台積電。
`;
    const v = runDeterministicPass(text)[0]!;
    expect(v.location).toContain('台積電');
  });

  test('multiple distinct violations are all returned', () => {
    const text = '建議買進台積電。您應該加碼。肯定會漲。';
    const violations = runDeterministicPass(text);
    const types = new Set(violations.map((v) => v.type));
    expect(types.has('buy_sell_recommendation')).toBe(true);
    expect(types.has('personalized_advice')).toBe(true);
    expect(types.has('absolute_certainty')).toBe(true);
  });

  test('violations returned in document order', () => {
    const text = '肯定會漲。然後建議買進。最後您應該加碼。';
    const violations = runDeterministicPass(text);
    const positions = violations.map((v) => text.indexOf(v.quote));
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });
});

// ===========================================================================
// parseJudgeOutput
// ===========================================================================

describe('parseJudgeOutput', () => {
  test('valid JSON parses', () => {
    const raw = JSON.stringify({
      verdict: 'pass',
      violations: [],
      confidence: 0.95,
    });
    const result = parseJudgeOutput(raw);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe('pass');
    expect(result.violations).toEqual([]);
    expect(result.confidence).toBe(0.95);
  });

  test('strips ```json code fence wrapper', () => {
    const raw = '```json\n{"verdict":"pass","violations":[]}\n```';
    const result = parseJudgeOutput(raw);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe('pass');
  });

  test('strips leading commentary before {', () => {
    const raw = 'Sure, here is the JSON:\n{"verdict":"fail","violations":[]}';
    const result = parseJudgeOutput(raw);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe('fail');
  });

  test('malformed JSON returns available=false with reason', () => {
    const raw = 'not json at all';
    const result = parseJudgeOutput(raw);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('malformed');
  });

  test('unexpected verdict value returns available=false', () => {
    const raw = JSON.stringify({ verdict: 'looks_good', violations: [] });
    const result = parseJudgeOutput(raw);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('verdict');
  });

  test('parses violations array with all fields', () => {
    const raw = JSON.stringify({
      verdict: 'fail',
      violations: [
        {
          type: 'buy_sell_recommendation',
          severity: 'critical',
          quote: '建議買進台積電',
          location: 'Top 5 → 2330',
          suggested_rewrite: '改為「外資連 3 日買超」',
        },
      ],
      confidence: 0.88,
    });
    const result = parseJudgeOutput(raw);
    expect(result.available).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations![0]!.type).toBe('buy_sell_recommendation');
    expect(result.violations![0]!.caught_by).toBe('llm');
    expect(result.violations![0]!.suggested_rewrite).toContain('外資');
  });

  test('skips violations missing required fields', () => {
    const raw = JSON.stringify({
      verdict: 'review',
      violations: [
        { type: 'buy_sell_recommendation' }, // missing quote
        { quote: 'foo' }, // missing type
        { type: 'absolute_certainty', quote: '肯定會漲' }, // good
      ],
    });
    const result = parseJudgeOutput(raw);
    expect(result.available).toBe(true);
    expect(result.violations).toHaveLength(1);
  });

  test('clamps confidence to [0, 1]', () => {
    const raw1 = JSON.stringify({ verdict: 'pass', violations: [], confidence: 1.5 });
    expect(parseJudgeOutput(raw1).confidence).toBe(1);
    const raw2 = JSON.stringify({ verdict: 'pass', violations: [], confidence: -0.3 });
    expect(parseJudgeOutput(raw2).confidence).toBe(0);
  });

  test('handles non-object JSON (array, primitive)', () => {
    expect(parseJudgeOutput('[]').available).toBe(false);
    expect(parseJudgeOutput('"pass"').available).toBe(false);
    expect(parseJudgeOutput('42').available).toBe(false);
  });
});

// ===========================================================================
// runLlmJudge (with injected chatFn)
// ===========================================================================

describe('runLlmJudge', () => {
  test('returns available=false when chatFn is undefined', async () => {
    const result = await runLlmJudge('digest', undefined);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('not provided');
  });

  test('returns available=false when chatFn throws', async () => {
    const stub = async () => {
      throw new Error('network down');
    };
    const result = await runLlmJudge('digest', stub);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('network down');
  });

  test('parses successful chat response', async () => {
    const stub = async () => ({
      text: JSON.stringify({
        verdict: 'pass',
        violations: [],
        confidence: 0.9,
      }),
    });
    const result = await runLlmJudge('digest', stub);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe('pass');
  });

  test('chatFn receives the rubric in user prompt', async () => {
    let capturedUser = '';
    const stub = async (opts: { user: string }) => {
      capturedUser = opts.user;
      return { text: '{"verdict":"pass","violations":[]}' };
    };
    await runLlmJudge('## test digest', stub);
    expect(capturedUser).toContain('合規審查規則');
    expect(capturedUser).toContain('## test digest');
  });
});

// ===========================================================================
// aggregateVerdict
// ===========================================================================

describe('aggregateVerdict', () => {
  const emptyLayer2 = { available: false, reason: 'test' };

  test('zero violations → pass', () => {
    const v = aggregateVerdict({ layer1: [], layer2: emptyLayer2, digestHash: 'abc' });
    expect(v.verdict).toBe('pass');
  });

  test('any critical layer-1 → fail', () => {
    const layer1: Violation[] = [
      {
        type: 'buy_sell_recommendation', severity: 'critical',
        quote: 'q', caught_by: 'deterministic',
      },
    ];
    const v = aggregateVerdict({ layer1, layer2: emptyLayer2, digestHash: 'abc' });
    expect(v.verdict).toBe('fail');
  });

  test('only warning layer-1 → review', () => {
    const layer1: Violation[] = [
      {
        type: 'absolute_certainty', severity: 'warning',
        quote: 'q', caught_by: 'deterministic',
      },
    ];
    const v = aggregateVerdict({ layer1, layer2: emptyLayer2, digestHash: 'abc' });
    expect(v.verdict).toBe('review');
  });

  test('layer-2 critical even when layer-1 clean → fail', () => {
    const layer2 = {
      available: true,
      verdict: 'fail' as const,
      violations: [
        {
          type: 'should_action' as const, severity: 'critical' as const,
          quote: 'q', caught_by: 'llm' as const,
        },
      ],
    };
    const v = aggregateVerdict({ layer1: [], layer2, digestHash: 'abc' });
    expect(v.verdict).toBe('fail');
  });

  test('layer-2 verdict respected when no structured violations', () => {
    // LLM saw something off but didn't list a structured violation.
    const layer2 = {
      available: true,
      verdict: 'review' as const,
      violations: [],
      confidence: 0.7,
    };
    const v = aggregateVerdict({ layer1: [], layer2, digestHash: 'abc' });
    expect(v.verdict).toBe('review');
  });

  test('dedupes same-quote violations across layers (regex wins)', () => {
    const layer1: Violation[] = [
      {
        type: 'buy_sell_recommendation', severity: 'critical',
        quote: '建議買進台積電', caught_by: 'deterministic',
        suggested_rewrite: 'REGEX_REWRITE',
      },
    ];
    const layer2 = {
      available: true,
      verdict: 'fail' as const,
      violations: [
        {
          type: 'buy_sell_recommendation' as const, severity: 'critical' as const,
          quote: '建議買進台積電', caught_by: 'llm' as const,
          suggested_rewrite: 'LLM_REWRITE',
        },
      ],
    };
    const v = aggregateVerdict({ layer1, layer2, digestHash: 'abc' });
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]!.suggested_rewrite).toBe('REGEX_REWRITE');
  });

  test('confidence + flags propagate to verdict', () => {
    const layer2 = {
      available: true,
      verdict: 'pass' as const,
      violations: [],
      confidence: 0.88,
    };
    const v = aggregateVerdict({ layer1: [], layer2, digestHash: 'hash123' });
    expect(v.llm_available).toBe(true);
    expect(v.llm_confidence).toBe(0.88);
    expect(v.digest_hash).toBe('hash123');
  });

  test('layer counts reported separately', () => {
    const layer1: Violation[] = [
      { type: 'absolute_certainty', severity: 'warning', quote: 'a', caught_by: 'deterministic' },
      { type: 'absolute_certainty', severity: 'warning', quote: 'b', caught_by: 'deterministic' },
    ];
    const layer2 = {
      available: true, verdict: 'review' as const,
      violations: [
        { type: 'should_action' as const, severity: 'warning' as const, quote: 'c', caught_by: 'llm' as const },
      ],
    };
    const v = aggregateVerdict({ layer1, layer2, digestHash: 'h' });
    expect(v.layer1_violations).toBe(2);
    expect(v.layer2_violations).toBe(1);
  });
});
