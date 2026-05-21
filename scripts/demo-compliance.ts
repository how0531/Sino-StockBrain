#!/usr/bin/env bun
/**
 * Compliance filter demo runner — invokes the compliance-filter handler
 * directly with a digest that contains intentional violations. Used to
 * verify Layer 1 (regex) catches the obvious patterns without needing
 * an Anthropic API key.
 *
 * Usage:
 *   bun run scripts/demo-compliance.ts            # default date 2026-05-20
 *   bun run scripts/demo-compliance.ts 2026-05-21
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { complianceFilterHandler } from '../src/core/minions/handlers/compliance-filter.ts';

const BRAIN_DIR = resolve(process.cwd());
const DATE = process.argv[2] ?? '2026-05-20';

function stubCtx(data: Record<string, unknown>): MinionJobContext {
  const ac = new AbortController();
  return {
    id: Math.floor(Math.random() * 100000),
    name: 'compliance-filter',
    data,
    attempts_made: 1,
    signal: ac.signal,
    shutdownSignal: ac.signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async (msg) => {
      const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
      process.stderr.write(`  ${text}\n`);
    },
    isActive: async () => true,
    readInbox: async () => [],
  };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Sino-StockBrain Compliance Filter Demo');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  brain_dir: ${BRAIN_DIR}`);
console.log(`  date:      ${DATE}\n`);

const t0 = Date.now();
const result = await complianceFilterHandler(stubCtx({
  brain_dir: BRAIN_DIR,
  date: DATE,
  llm: false, // Layer 1 only — no API key needed
}));
const elapsed = Date.now() - t0;

console.log(`\n✓ ${elapsed}ms  verdict=${result.verdict} ` +
  `layer1_violations=${result.layer1_violations} llm_available=${result.llm_available}`);
console.log(`  output: ${result.output_path}\n`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (existsSync(result.output_path)) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(readFileSync(result.output_path, 'utf8'));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
