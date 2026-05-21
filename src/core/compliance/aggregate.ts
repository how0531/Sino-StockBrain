/**
 * Compliance verdict aggregator — combines Layer 1 (deterministic) and
 * Layer 2 (LLM judge) into a single ComplianceVerdict.
 *
 * Decision logic:
 *   1. Any `critical` violation from EITHER layer → 'fail'
 *   2. Any `warning` violation → 'review'
 *   3. Layer 2 verdict is 'fail' or 'review' → use it (LLM saw context
 *      that regex missed — defer to its severity)
 *   4. Else 'pass'
 *
 * Why bias toward the stricter verdict: false positives cost an analyst
 * a manual review; false negatives cost a regulatory incident. Asymmetric
 * cost → bias the aggregator toward catching.
 *
 * Pure function, no I/O. Audit writes live in audit.ts.
 */

import type {
  ComplianceVerdict,
  Verdict,
  Violation,
} from './rubric.ts';
import type { LlmJudgeResult } from './llm-judge.ts';

export interface AggregateInputs {
  layer1: Violation[];
  layer2: LlmJudgeResult;
  digestHash: string;
}

export function aggregateVerdict(inputs: AggregateInputs): ComplianceVerdict {
  const { layer1, layer2, digestHash } = inputs;

  // Dedup violations across layers — if regex and LLM both caught the same
  // sentence, keep the regex one (it has the deterministic suggested_rewrite).
  const merged = dedupViolations(layer1, layer2.violations ?? []);

  const hasCritical = merged.some((v) => v.severity === 'critical');
  const hasWarning = merged.some((v) => v.severity === 'warning');

  let verdict: Verdict;
  if (hasCritical) {
    verdict = 'fail';
  } else if (hasWarning) {
    verdict = 'review';
  } else if (layer2.available && (layer2.verdict === 'fail' || layer2.verdict === 'review')) {
    // LLM saw context that regex missed but didn't surface as a structured
    // violation. Defer to its verdict.
    verdict = layer2.verdict;
  } else {
    verdict = 'pass';
  }

  return {
    verdict,
    violations: merged,
    layer1_violations: layer1.length,
    layer2_violations: layer2.violations?.length ?? 0,
    llm_available: layer2.available,
    llm_confidence: layer2.confidence,
    digest_hash: digestHash,
  };
}

/** Layer-1 wins on duplicate quotes (regex carries the canonical
 *  suggested_rewrite). Two quotes are "same" if either is a substring of
 *  the other after whitespace normalisation. */
function dedupViolations(layer1: Violation[], layer2: Violation[]): Violation[] {
  const norm = (s: string): string => s.replace(/\s+/g, '').trim();
  const out: Violation[] = [...layer1];
  for (const v2 of layer2) {
    const n2 = norm(v2.quote);
    const dup = out.find((v1) => {
      const n1 = norm(v1.quote);
      return n1 === n2 || n1.includes(n2) || n2.includes(n1);
    });
    if (!dup) out.push(v2);
  }
  return out;
}
