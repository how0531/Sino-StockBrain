/**
 * Compliance audit JSONL — every filter run appends one line to
 * `~/.gbrain/audit/compliance-YYYY-Www.jsonl`. Matches the pattern of
 * `shell-audit.ts`, `supervisor-audit.ts`, `rerank-audit.ts`.
 *
 * Audit is REGULATORY evidence. If a digest with a buy/sell rec slips out
 * to a retail client, the audit trail is what proves the filter ran +
 * what verdict it produced. Therefore:
 *   - Best-effort write (mkdir + append). Failure to write is logged but
 *     never blocks the filter — losing the audit is bad, blocking the
 *     pipeline is worse (analyst can re-run later, but a missed deadline
 *     is unrecoverable).
 *   - ISO-week rotation to keep files browsable.
 *   - We log the digest_hash, NOT the digest body — privacy + size. The
 *     digest itself stays in `playbooks/digests/<date>.md`; the audit
 *     points at it.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ComplianceVerdict } from './rubric.ts';

export interface ComplianceAuditRecord {
  ts: string;        // ISO 8601 UTC
  date: string;      // digest date (YYYY-MM-DD)
  digest_path: string;
  digest_hash: string;
  verdict: ComplianceVerdict['verdict'];
  layer1_violations: number;
  layer2_violations: number;
  llm_available: boolean;
  llm_confidence?: number;
  output_path?: string; // where the approved digest was written (pass) or violations file (fail/review)
}

export function logComplianceVerdict(record: ComplianceAuditRecord): void {
  try {
    const dir = resolveAuditDir();
    mkdirSync(dir, { recursive: true });
    const fname = computeIsoWeekName();
    appendFileSync(join(dir, fname), JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    // Best-effort. Print to stderr so operators can spot it in worker logs,
    // but never throw — losing one audit line ≠ blocking the filter.
    process.stderr.write(
      `[compliance-audit] failed to write audit log: ${(e as Error).message}\n`,
    );
  }
}

function resolveAuditDir(): string {
  const override = process.env.GBRAIN_AUDIT_DIR;
  if (override) return override;
  const home = process.env.GBRAIN_HOME ?? join(homedir(), '.gbrain');
  return join(home, 'audit');
}

/** ISO 8601 week-numbered filename, e.g. `compliance-2026-W21.jsonl`. */
export function computeIsoWeekName(now: Date = new Date()): string {
  // ISO 8601: Thursday-anchored, weeks 1-53.
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `compliance-${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}.jsonl`;
}
