/**
 * `compliance-filter` job handler.
 *
 * Reads a draft digest (typically the output of `daily-market-digest` skill),
 * runs both compliance layers, writes one of three outputs:
 *   - verdict='pass'   → `<brain_dir>/client-prep/<date>.md` (approved for push)
 *   - verdict='review' → `<brain_dir>/playbooks/violations/<date>.md` (analyst fixup)
 *   - verdict='fail'   → `<brain_dir>/playbooks/violations/<date>.md` (must not push)
 *
 * Always writes audit JSONL — that's the regulatory evidence the filter ran.
 *
 * Trust model: NOT in PROTECTED_JOB_NAMES. The handler can be invoked by
 * any agent (CLI / MCP / cron). But the LLM judge consumes Anthropic
 * credits, so we make the LLM layer opt-in via `--params '{"llm":true}'`
 * (default: deterministic-only, $0). The autopilot path will enable LLM.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import { runDeterministicPass } from '../../compliance/deterministic-pass.ts';
import {
  runLlmJudge,
  type JudgeChatFn,
  type LlmJudgeResult,
} from '../../compliance/llm-judge.ts';
import { aggregateVerdict } from '../../compliance/aggregate.ts';
import { logComplianceVerdict } from '../../compliance/audit.ts';
import type { ComplianceVerdict, Violation } from '../../compliance/rubric.ts';

export interface ComplianceFilterParams {
  brain_dir: string;
  /** Date corresponding to the digest. */
  date?: string;
  /** Explicit digest path override. If omitted, derived from `<brain_dir>/playbooks/digests/<date>.md`. */
  digest_path?: string;
  /** When true, run the LLM judge (costs Anthropic credits). Default false. */
  llm?: boolean;
  /** Model override for the judge. Defaults to whatever gateway.chat
   *  resolves (config.chat_model). */
  llm_model?: string;
}

export interface ComplianceFilterResult {
  status: 'ok' | 'skipped';
  reason?: string;
  date: string;
  digest_path: string;
  verdict: ComplianceVerdict['verdict'];
  output_path: string;
  layer1_violations: number;
  layer2_violations: number;
  llm_available: boolean;
}

export async function complianceFilterHandler(
  ctx: MinionJobContext,
): Promise<ComplianceFilterResult> {
  const params = validateParams(ctx.data);
  const date = resolveDate(params.date ?? 'today');

  const digestPath =
    params.digest_path ?? join(params.brain_dir, 'playbooks', 'digests', `${date}.md`);

  if (!existsSync(digestPath)) {
    return {
      status: 'skipped',
      reason: `no digest at ${digestPath}; run daily-market-digest first`,
      date,
      digest_path: digestPath,
      verdict: 'fail',
      output_path: '',
      layer1_violations: 0,
      layer2_violations: 0,
      llm_available: false,
    };
  }

  const digestText = readFileSync(digestPath, 'utf8');
  const digestHash = createHash('sha256').update(digestText).digest('hex').slice(0, 16);

  await ctx.log(
    `[compliance-filter] date=${date} hash=${digestHash} llm=${params.llm ?? false}`,
  );

  // Layer 1 — deterministic pass (always run, $0)
  const layer1 = runDeterministicPass(digestText);
  await ctx.log(`[compliance-filter] layer1: ${layer1.length} violations`);

  // Layer 2 — LLM judge (opt-in, costs credits)
  let layer2: LlmJudgeResult = { available: false, reason: 'llm flag not set' };
  if (params.llm) {
    layer2 = await runLlmJudge(digestText, await resolveChatFn(params.llm_model), {
      abortSignal: ctx.signal,
    });
    if (layer2.available) {
      await ctx.log(
        `[compliance-filter] layer2: ${layer2.violations?.length ?? 0} violations, ` +
          `verdict=${layer2.verdict} confidence=${layer2.confidence ?? 'n/a'}`,
      );
    } else {
      await ctx.log(`[compliance-filter] layer2 unavailable: ${layer2.reason}`);
    }
  }

  const verdictResult = aggregateVerdict({ layer1, layer2, digestHash });

  // Write output(s) per verdict.
  let outputPath: string;
  if (verdictResult.verdict === 'pass') {
    outputPath = join(params.brain_dir, 'client-prep', `${date}.md`);
    mkdirSync(join(params.brain_dir, 'client-prep'), { recursive: true });
    writeFileSync(outputPath, renderApprovedDigest(digestText, verdictResult, date), 'utf8');
  } else {
    outputPath = join(params.brain_dir, 'playbooks', 'violations', `${date}.md`);
    mkdirSync(join(params.brain_dir, 'playbooks', 'violations'), { recursive: true });
    writeFileSync(
      outputPath,
      renderViolationsReport(digestPath, digestText, verdictResult, date),
      'utf8',
    );
  }

  // Audit (best-effort).
  logComplianceVerdict({
    ts: new Date().toISOString(),
    date,
    digest_path: digestPath,
    digest_hash: digestHash,
    verdict: verdictResult.verdict,
    layer1_violations: verdictResult.layer1_violations,
    layer2_violations: verdictResult.layer2_violations,
    llm_available: verdictResult.llm_available,
    llm_confidence: verdictResult.llm_confidence,
    output_path: outputPath,
  });

  await ctx.log(
    `[compliance-filter] verdict=${verdictResult.verdict} output=${outputPath}`,
  );

  return {
    status: 'ok',
    date,
    digest_path: digestPath,
    verdict: verdictResult.verdict,
    output_path: outputPath,
    layer1_violations: verdictResult.layer1_violations,
    layer2_violations: verdictResult.layer2_violations,
    llm_available: verdictResult.llm_available,
  };
}

// ===========================================================================
// gateway adapter
// ===========================================================================

/** Bind `gateway.chat` to the JudgeChatFn shape. Returns undefined if the
 *  gateway can't be loaded (test env, missing config, etc.) — judge then
 *  reports "not available" and the filter falls through to Layer 1 alone. */
async function resolveChatFn(model?: string): Promise<JudgeChatFn | undefined> {
  try {
    const { chat } = await import('../../ai/gateway.ts');
    return async ({ system, user, maxTokens, abortSignal }) => {
      const result = await chat({
        ...(model ? { model } : {}),
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens,
        abortSignal,
      });
      return { text: result.text };
    };
  } catch (e) {
    process.stderr.write(
      `[compliance-filter] gateway unavailable: ${(e as Error).message}\n`,
    );
    return undefined;
  }
}

// ===========================================================================
// output renderers
// ===========================================================================

function renderApprovedDigest(
  digestText: string,
  verdict: ComplianceVerdict,
  date: string,
): string {
  const banner = `---
type: client_prep_digest
slug: client-prep/${date}
date: ${date}
status: approved
compliance_verdict: ${verdict.verdict}
compliance_layer1_violations: ${verdict.layer1_violations}
compliance_layer2_violations: ${verdict.layer2_violations}
compliance_llm_available: ${verdict.llm_available}
compliance_digest_hash: ${verdict.digest_hash}
---

<!-- This document was reviewed by sino-stockbrain compliance-filter and approved
     for client-facing distribution. -->

`;
  // Strip the original frontmatter (we replace with the approved one).
  const stripped = digestText.replace(/^---\n[\s\S]*?\n---\n/, '');
  return banner + stripped;
}

function renderViolationsReport(
  digestPath: string,
  _digestText: string,
  verdict: ComplianceVerdict,
  date: string,
): string {
  const violationLines = verdict.violations.length === 0
    ? '_(LLM 提到問題但未結構化列出 — 手動覆查)_'
    : verdict.violations.map((v, i) => renderViolation(v, i + 1)).join('\n\n');

  return `---
type: compliance_violations
slug: playbooks/violations/${date}
date: ${date}
digest_path: ${digestPath}
verdict: ${verdict.verdict}
layer1_violations: ${verdict.layer1_violations}
layer2_violations: ${verdict.layer2_violations}
llm_available: ${verdict.llm_available}
llm_confidence: ${verdict.llm_confidence ?? 'n/a'}
digest_hash: ${verdict.digest_hash}
---

# Compliance Violations — ${date}

**Verdict**: ${verdict.verdict.toUpperCase()}

${verdict.verdict === 'fail'
    ? '> 🚫 **此 digest 不可推送給客戶**。修正下列 violations 並重跑 compliance-filter。'
    : '> ⚠️ **此 digest 需分析師覆查**。修正 warnings 後可重跑。'}

原始草稿：[[playbooks/digests/${date}]]
草稿 hash：\`${verdict.digest_hash}\`

## Violations (${verdict.violations.length})

${violationLines}

## 重跑指令

修正後，重新跑：

\`\`\`bash
gbrain jobs submit compliance-filter \\
  --params '{"brain_dir":"<brain>","date":"${date}","llm":true}'
\`\`\`

## Audit

每次審查結果都寫入 \`~/.gbrain/audit/compliance-YYYY-Www.jsonl\`。
查看本週紀錄：

\`\`\`bash
cat ~/.gbrain/audit/compliance-*.jsonl | jq 'select(.date == "${date}")'
\`\`\`
`;
}

function renderViolation(v: Violation, idx: number): string {
  const sevIcon = v.severity === 'critical' ? '🚫' : v.severity === 'warning' ? '⚠️' : 'ℹ️';
  return `### ${idx}. ${sevIcon} ${v.type} (${v.severity}) — caught by ${v.caught_by}

**位置**: ${v.location ?? '(未定位)'}

**引文**:

> ${v.quote.replace(/\n/g, '\n> ')}

**建議改寫**: ${v.suggested_rewrite ?? '(無建議)'}`;
}

// ===========================================================================
// validators
// ===========================================================================

function validateParams(data: Record<string, unknown>): ComplianceFilterParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError('compliance-filter: missing required param "brain_dir"');
  }
  if (data.date !== undefined && typeof data.date !== 'string') {
    throw new UnrecoverableError('compliance-filter: "date" must be a string');
  }
  if (data.digest_path !== undefined && typeof data.digest_path !== 'string') {
    throw new UnrecoverableError('compliance-filter: "digest_path" must be a string');
  }
  if (data.llm !== undefined && typeof data.llm !== 'boolean') {
    throw new UnrecoverableError('compliance-filter: "llm" must be a boolean');
  }
  if (data.llm_model !== undefined && typeof data.llm_model !== 'string') {
    throw new UnrecoverableError('compliance-filter: "llm_model" must be a string');
  }
  return {
    brain_dir: data.brain_dir,
    date: data.date as string | undefined,
    digest_path: data.digest_path as string | undefined,
    llm: data.llm as boolean | undefined,
    llm_model: data.llm_model as string | undefined,
  };
}

function resolveDate(input: string): string {
  if (input === 'today') {
    const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const y = tw.getFullYear();
    const m = String(tw.getMonth() + 1).padStart(2, '0');
    const d = String(tw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new UnrecoverableError(`compliance-filter: invalid date "${input}"`);
  }
  return input;
}
