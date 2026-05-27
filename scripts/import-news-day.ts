#!/usr/bin/env bun
/** One-off helper: import a single news/<date>/ dir into the brain with
 *  brain-root-relative slugs (so [[news/<date>/...]] wikilinks resolve).
 *  Used to graph user-research reports the moment they're ingested. */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { connectWithRetry } from '../src/core/db.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { collectSyncableFiles } from '../src/commands/import.ts';

const ROOT = process.env.BRAIN_ROOT || 'E:\\SinoBrain-data';
const DATE = process.argv[2];
if (!DATE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error('usage: bun run scripts/_import-news-day.ts YYYY-MM-DD');
  process.exit(2);
}
async function main() {
  const cfg = loadConfig();
  if (!cfg) throw new Error('no brain configured');
  const eng = await createEngine(toEngineConfig(cfg));
  await connectWithRetry(eng, toEngineConfig(cfg), {});
  const dir = join(ROOT, 'news', DATE);
  if (!existsSync(dir)) throw new Error(`no dir: ${dir}`);
  const files = collectSyncableFiles(dir, { strategy: 'markdown' });
  let imp = 0, sk = 0;
  for (const f of files) {
    const rel = relative(ROOT, f);
    const r = await importFromFile(eng, f, rel, { noEmbed: true });
    if (r.status === 'imported') imp++; else sk++;
  }
  await eng.disconnect();
  console.log(`news/${DATE}: imported=${imp}, skipped=${sk}`);
}
main();
