#!/usr/bin/env bun
/**
 * Week-4 demo runner — invokes the four-handler pipeline directly without
 * needing a worker daemon. Useful for:
 *   - Verifying the pipeline e2e on a fresh checkout
 *   - Showing analysts what the daily output looks like
 *   - Generating fixture data for unit tests / digest skill iteration
 *
 * What it does:
 *   1. Stub a minimal MinionJobContext (signal/log/data only — the four
 *      handlers don't touch the inbox/progress/tokens slots).
 *   2. Run twse-daily-quotes → twse-institutional-flow → news-ingest →
 *      market-heat in sequence against the mock data sources.
 *   3. Print the resulting heat-score report to stdout.
 *
 * Hermetic: mock data is deterministic per (ticker, date), so output is
 * reproducible. Pick a weekday (2026-05-20 is a Wednesday) or pass a date
 * as argv[2].
 *
 * Usage:
 *   bun run scripts/demo-week4-pipeline.ts                # default date
 *   bun run scripts/demo-week4-pipeline.ts 2026-05-21     # custom date
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { twseDailyQuotesHandler } from '../src/core/minions/handlers/twse-daily-quotes.ts';
import { twseInstitutionalFlowHandler } from '../src/core/minions/handlers/twse-institutional-flow.ts';
import { newsIngestHandler } from '../src/core/minions/handlers/news-ingest.ts';
import { marketHeatHandler } from '../src/core/minions/handlers/market-heat.ts';

const BRAIN_DIR = resolve(process.cwd());
const DATE = process.argv[2] ?? '2026-05-20';

function stubCtx(name: string, data: Record<string, unknown>): MinionJobContext {
  const ac = new AbortController();
  return {
    id: Math.floor(Math.random() * 100000),
    name,
    data,
    attempts_made: 1,
    signal: ac.signal,
    shutdownSignal: ac.signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async (msg) => {
      const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
      process.stderr.write(`  [${name}] ${text}\n`);
    },
    isActive: async () => true,
    readInbox: async () => [],
  };
}

const stages: Array<{
  name: string;
  fn: (ctx: MinionJobContext) => Promise<unknown>;
}> = [
  { name: 'twse-daily-quotes', fn: twseDailyQuotesHandler },
  { name: 'twse-institutional-flow', fn: twseInstitutionalFlowHandler },
  { name: 'news-ingest', fn: newsIngestHandler },
  { name: 'market-heat', fn: marketHeatHandler },
];

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Sino-StockBrain Wave-4 Pipeline Demo');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  brain_dir: ${BRAIN_DIR}`);
console.log(`  date:      ${DATE}\n`);

const t0 = Date.now();
for (const stage of stages) {
  const stageStart = Date.now();
  process.stdout.write(`→ ${stage.name.padEnd(28)} `);
  try {
    const result = await stage.fn(stubCtx(stage.name, {
      brain_dir: BRAIN_DIR,
      date: DATE,
    }));
    const elapsed = Date.now() - stageStart;
    const summary = summarizeResult(stage.name, result);
    console.log(`✓ ${elapsed}ms  ${summary}`);
  } catch (e) {
    console.log(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}

console.log(`\n  Total: ${Date.now() - t0}ms`);
console.log('═══════════════════════════════════════════════════════════════\n');

// Show the heat report.
const reportPath = resolve(BRAIN_DIR, 'playbooks', 'heat', `${DATE}.md`);
if (existsSync(reportPath)) {
  console.log(`Heat report: ${reportPath}\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(readFileSync(reportPath, 'utf8'));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
} else {
  console.error(`Heat report not found at ${reportPath}`);
  process.exit(1);
}

function summarizeResult(name: string, result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  switch (name) {
    case 'twse-daily-quotes':
      return `rows=${r.rows_fetched} written=${r.rows_written}`;
    case 'twse-institutional-flow':
      return `rows=${r.rows_fetched} written=${r.rows_written}`;
    case 'news-ingest':
      return `articles=${r.articles_fetched} written=${r.articles_written} replacements=${r.total_wikify_replacements}`;
    case 'market-heat':
      return `tickers=${r.tickers_scored} → ${r.output_path}`;
    default:
      return '';
  }
}
