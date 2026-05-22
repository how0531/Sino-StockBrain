#!/usr/bin/env bun
/**
 * gen-concept-themes.ts — Layer B of #2. Materialise the HOT 題材 concept groups
 * (NOT the broad GICS-style industry buckets) from `concept-groups.json` into
 * lightweight `themes/<slug>.md` membership pages, so `gbrain extract links`
 * builds 個股 <-> 族群 edges. The graph then knows "誰跟誰同一掛".
 *
 * Selection (題材, not industry bucket):
 *   - tag contains a 題材 keyword (THEME_KEYWORDS), AND
 *   - not in EXCLUDE_TAGS (noisy sub-buckets), AND
 *   - member count within [MIN_MEMBERS, MAX_MEMBERS] (the ceiling drops any
 *     broad industry bucket that sneaks past the keyword filter).
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

/** 題材 keywords — a tag qualifies if it contains any of these. Curatable. */
const THEME_KEYWORDS = [
  'CoWoS', '矽光子', 'CPO', 'HBM', 'ABF', '載板', '先進封裝', '重電', '散熱',
  '液冷', '低軌', '衛星', '機器人', '被動元件', '連接器', '矽智財', '碳化矽',
  '氮化鎵', '軍工', '無人機', '伺服器', '玻璃基板', 'Mini LED', 'Micro LED',
  '光通訊', '矽晶圓', '減重', '矽光', '第三代半導體', 'AI 伺服器', '矽晶',
];

/** Noisy sub-buckets / mislabelled tags to skip even if keyword-matched. */
const EXCLUDE_TAGS = new Set<string>([
  '觸控面板-衛星定位系統', '通信網路-主/被動元件', '記憶體產業',
  '記憶體設備產業', '記憶體模組',
]);

/** Tags a hand-curated seed theme already owns — skip to avoid duplicate pages. */
const SEED_SKIP = new Set<string>(['被動元件', 'CoWoS-L']);

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 80; // ceiling: drop broad industry buckets (100+).

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
  if (g.codes.length < MIN_MEMBERS || g.codes.length > MAX_MEMBERS) return false;
  return THEME_KEYWORDS.some((k) => tag.includes(k));
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
