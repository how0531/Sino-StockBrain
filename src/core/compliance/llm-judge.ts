/**
 * Compliance Layer 2 — LLM judge.
 *
 * Calls a chat model with the rubric + digest and parses structured JSON
 * back. Fail-graceful: when the chat fn throws / returns malformed JSON,
 * the judge returns `{ available: false }` so the aggregator falls through
 * to Layer 1 alone. We never let a flaky LLM corrupt a verdict.
 *
 * The chat fn is INJECTED rather than imported directly. Production code
 * passes `gateway.chat` from `src/core/ai/gateway.ts`; tests pass a stub
 * that returns fixed JSON. This is the same pattern think/index.ts uses
 * for its LLMClient — keeps the judge unit-testable without an API key.
 */

import type { Violation, Verdict } from './rubric.ts';
import { RUBRIC_TEXT_ZH } from './rubric.ts';

/** Minimal chat interface — a subset of gateway.chat's contract. The
 *  handler binds this to the real gateway via a small adapter (see
 *  compliance-filter.ts:resolveChatFn). */
export type JudgeChatFn = (opts: {
  system: string;
  user: string;
  maxTokens: number;
  abortSignal?: AbortSignal;
}) => Promise<{ text: string }>;

export interface LlmJudgeResult {
  available: boolean;
  /** Set when `available=true` AND the JSON parsed successfully. */
  verdict?: Verdict;
  violations?: Violation[];
  confidence?: number;
  /** Operator-facing diagnostic when the judge couldn't run. */
  reason?: string;
}

const SYSTEM_PROMPT = `你是台灣金融合規審查員。審查內部分析師 digest 是否適合對外發送給散戶 / 機構客戶。
應用台灣投顧法規嚴格標準。
返回 JSON only，不要 markdown code fence，不要前後文字。`;

/** Run the LLM judge.
 *
 *  Failure modes:
 *   - chatFn === undefined → `{ available: false, reason: 'chat fn not provided' }`
 *   - chatFn throws → `{ available: false, reason: <message> }`
 *   - JSON parse fails → `{ available: false, reason: 'malformed JSON' }`
 *   - JSON shape mismatch → `{ available: false, reason: 'unexpected shape' }`
 *
 *  When available=true, callers can trust the returned verdict/violations
 *  shape — we validate before returning. */
export async function runLlmJudge(
  digest: string,
  chatFn: JudgeChatFn | undefined,
  opts: { maxTokens?: number; abortSignal?: AbortSignal } = {},
): Promise<LlmJudgeResult> {
  if (!chatFn) {
    return { available: false, reason: 'chat fn not provided (gateway unavailable)' };
  }

  let raw: string;
  try {
    const response = await chatFn({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(digest),
      maxTokens: opts.maxTokens ?? 2048,
      abortSignal: opts.abortSignal,
    });
    raw = response.text;
  } catch (e) {
    return { available: false, reason: `chat call failed: ${(e as Error).message}` };
  }

  return parseJudgeOutput(raw);
}

/** Pure: parse the LLM's JSON output into a typed verdict, or report the
 *  parse failure. Exported for unit tests. */
export function parseJudgeOutput(raw: string): LlmJudgeResult {
  const stripped = stripFenceAndCommentary(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return {
      available: false,
      reason: `malformed JSON: ${(e as Error).message}; raw head=${raw.slice(0, 80)}`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { available: false, reason: 'unexpected JSON shape (not an object)' };
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== 'pass' && verdict !== 'review' && verdict !== 'fail') {
    return { available: false, reason: `unexpected verdict: ${String(verdict)}` };
  }
  const rawViolations = Array.isArray(obj.violations) ? obj.violations : [];
  const violations: Violation[] = [];
  for (const v of rawViolations) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.type !== 'string' || typeof r.quote !== 'string') continue;
    violations.push({
      type: r.type as Violation['type'],
      severity: (r.severity as Violation['severity']) ?? 'warning',
      quote: r.quote,
      location: typeof r.location === 'string' ? r.location : undefined,
      suggested_rewrite:
        typeof r.suggested_rewrite === 'string' ? r.suggested_rewrite : undefined,
      caught_by: 'llm',
    });
  }
  const confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : undefined;
  return { available: true, verdict, violations, confidence };
}

function buildUserPrompt(digest: string): string {
  return `${RUBRIC_TEXT_ZH}\n\n# 待審查 DIGEST\n\n---\n${digest}\n---\n\n返回 JSON only。`;
}

/** Some models wrap JSON in \`\`\`json fences or prepend explanatory text
 *  even when told not to. Strip both. */
function stripFenceAndCommentary(raw: string): string {
  let s = raw.trim();
  // Strip leading text before first { (commentary).
  const firstBrace = s.indexOf('{');
  if (firstBrace > 0) s = s.slice(firstBrace);
  // Strip trailing text after the matching closing }.
  const lastBrace = s.lastIndexOf('}');
  if (lastBrace >= 0 && lastBrace < s.length - 1) s = s.slice(0, lastBrace + 1);
  // Strip code fences if any survived.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return s.trim();
}
