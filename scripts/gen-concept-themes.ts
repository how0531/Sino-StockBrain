#!/usr/bin/env bun
/**
 * gen-concept-themes.ts — Layer B of #2. Materialise the HOT 題材 concept groups
 * (NOT the broad GICS-style industry buckets) from `concept-groups.json` into
 * lightweight `themes/<slug>.md` membership pages, so `gbrain extract links`
 * builds 個股 <-> 族群 edges. The graph then knows "誰跟誰同一掛".
 *
 * Selection (全部概念族群, not broad industry buckets):
 *   - member count within [MIN_MEMBERS, MAX_MEMBERS]. The floor (4) drops
 *     fragmentary 2-3 stock sub-tags; the ceiling (80) drops the ~11 broad
 *     GICS-style industry buckets (通信網路 107, 光電 106, 機械 106, …).
 *   - not in EXCLUDE_TAGS (noisy mislabelled tags), and not SEED_SKIP (owned
 *     by a hand-curated seed theme).
 *   NO 題材-keyword gate (removed): every statementdog concept group in range
 *   becomes a page, so the 個股↔族群 graph is comprehensive (~330 themes) — the
 *   user wants the full concept lattice, not just the hot themes.
 *
 * Safety:
 *   - skip-if-exists: never clobber hand-curated seed themes
 *     (cowos / ai-infrastructure / passive-components) or a previous run's edits.
 *   - SEED_SKIP: tags that the seed themes already own (avoid duplicate pages).
 *
 * Generated pages carry `generated: true` so they're distinguishable from
 * hand-curated ones. Re-run after refreshing concept-groups.json:
 *   bun run scripts/gen-concept-themes.ts [<brain_dir>]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BRAIN_DIR = process.argv[2] || 'E:\\SinoBrain-data';
const ENTITIES = join(import.meta.dir, '..', 'src', 'core', 'entities');

interface ConceptGroup { tag: string; codes: string[]; }
interface TickerMasterRow { name: string; abbr: string; en: string; market: string; industry: string; }

const groups: ConceptGroup[] = JSON.parse(
  readFileSync(join(ENTITIES, 'concept-groups.json'), 'utf8'),
);
const master: Record<string, TickerMasterRow> = JSON.parse(
  readFileSync(join(ENTITIES, 'ticker-master.json'), 'utf8'),
);

/** Noisy / mislabelled tags to skip. */
const EXCLUDE_TAGS = new Set<string>([
  '觸控面板-衛星定位系統', '通信網路-主/被動元件', '記憶體產業',
  '記憶體設備產業', '記憶體模組',
]);

/** Tags a hand-curated seed theme already owns — skip to avoid duplicate pages. */
const SEED_SKIP = new Set<string>(['被動元件', 'CoWoS-L']);

const MIN_MEMBERS = 4;  // floor: drop fragmentary 2-3 stock sub-tags
const MAX_MEMBERS = 80; // ceiling: drop the ~11 broad GICS industry buckets (>80)

function slugifyTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9一-鿿-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isTheme(g: ConceptGroup): boolean {
  const tag = g.tag.trim();
  if (EXCLUDE_TAGS.has(tag) || SEED_SKIP.has(tag)) return false;
  return g.codes.length >= MIN_MEMBERS && g.codes.length <= MAX_MEMBERS;
}

function renderPage(g: ConceptGroup, slug: string): string {
  const tag = g.tag.trim();
  const lines = g.codes
    .slice()
    .sort()
    .map((code) => {
      const name = master[code]?.name;
      return name ? `- [[tickers/${code}]] (${name})` : `- [[tickers/${code}]]`;
    })
    .join('\n');
  return `---
type: theme
slug: themes/${slug}
title: "${tag}（題材族群）"
status: active
source: cmoney-statementdog
member_count: ${g.codes.length}
generated: true
---

# ${tag}

> 自動生成的題材族群成分頁（來源：cmoney / statementdog）。成分清單供知識圖譜建立
> 「個股 ↔ 族群」關係用；敘事、催化劑、投資觀點請人工補在這之上。

## 成分股（${g.codes.length}）

${lines}
`;
}

function main() {
  const dir = join(BRAIN_DIR, 'themes');
  mkdirSync(dir, { recursive: true });

  let written = 0;
  let skippedExists = 0;
  const made: string[] = [];

  for (const g of groups) {
    if (!isTheme(g)) continue;
    const slug = slugifyTag(g.tag);
    if (!slug) continue;
    const path = join(dir, `${slug}.md`);
    if (existsSync(path)) {
      skippedExists++;
      continue;
    }
    writeFileSync(path, renderPage(g, slug), 'utf8');
    written++;
    made.push(`${slug} (${g.codes.length})`);
  }

  console.log(`themes written: ${written}, skipped (exists): ${skippedExists}`);
  console.log('created:', made.join(', '));
}

main();
