#!/usr/bin/env bun
/**
 * reimport-graph-pages.ts — scoped re-import of the graph dirs (themes/, tickers/)
 * into the live brain DB, WITHOUT pulling the bulk db_only snapshot dirs
 * (prices/, institutional-flow/ = ~43k files) that `gbrain import <root>` would
 * walk (the walker doesn't honor gbrain.yml db_only).
 *
 * Why not `gbrain import`: slug is derived from path-relative-to-import-root,
 * so we MUST pass relativePath as `themes/<slug>` / `tickers/<slug>` (root-
 * relative) for the wikilinks `[[themes/X]]` to resolve. We walk each graph
 * subdir but compute relativePath against BRAIN_ROOT. noEmbed (no OpenAI key).
 *
 * After this, run:  gbrain extract links --source db   (builds 個股↔族群 edges)
 *
 *   bun run scripts/reimport-graph-pages.ts [<brain_root>]
 */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { connectWithRetry } from '../src/core/db.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { collectSyncableFiles } from '../src/commands/import.ts';

const BRAIN_ROOT = process.argv[2] || 'E:\\SinoBrain-data';
const GRAPH_DIRS = ['themes', 'tickers', 'sectors'];

async function main() {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured (loadConfig returned null). Run: gbrain init');
    process.exit(1);
  }
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await connectWithRetry(engine, engineConfig, {});

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  try {
    for (const sub of GRAPH_DIRS) {
      const dir = join(BRAIN_ROOT, sub);
      if (!existsSync(dir)) continue;
      const files = collectSyncableFiles(dir, { strategy: 'markdown' });
      process.stderr.write(`[reimport] ${sub}/: ${files.length} files\n`);
      for (const filePath of files) {
        const rel = relative(BRAIN_ROOT, filePath); // e.g. themes/機器人.md -> slug themes/機器人
        try {
          const res = await importFromFile(engine, filePath, rel, { noEmbed: true });
          if (res.status === 'imported') imported++;
          else skipped++;
        } catch (e) {
          errors++;
          if (errors <= 10) console.error(`  ERR ${rel}: ${(e as Error).message}`);
        }
      }
    }
  } finally {
    await engine.disconnect();
  }
  console.log(`reimport-graph-pages: imported=${imported}, skipped(unchanged)=${skipped}, errors=${errors}`);
}

main();
