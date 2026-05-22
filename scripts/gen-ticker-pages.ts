#!/usr/bin/env bun
/**
 * gen-ticker-pages.ts — ④ "last mile". Auto-generate a lightweight ticker node
 * for every listed stock in ticker-master.json that doesn't already have a page
 * (hand-curated watchlist pages are protected by skip-if-exists). Once every
 * stock is a node, BOTH edge classes resolve: news→個股 (from the market-wide
 * alias map) AND 族群→個股 (Layer B theme pages). The graph jumps from 16 stocks
 * to the whole market.
 *
 * Each page carries 產業 + 所屬族群 ([[themes/...]]) so membership is
 * bidirectional. 題材 slugs mirror gen-concept-themes.ts; the two seed-owned tags
 * (被動元件 / CoWoS-L) map to the hand seed slugs (passive-components / cowos).
 *
 * Re-run after refreshing the data files:
 *   bun run scripts/gen-ticker-pages.ts [<brain_dir>]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BRAIN_DIR = process.argv[2] || 'E:\\SinoBrain-data';
const ENTITIES = join(import.meta.dir, '..', 'src', 'core', 'entities');

interface ConceptGroup { tag: string; codes: string[]; }
interface Row { name: string; abbr: string; en: string; market: string; industry: string; }

const groups: ConceptGroup[] = JSON.parse(readFileSync(join(ENTITIES, 'concept-groups.json'), 'utf8'));
const master: Record<string, Row> = JSON.parse(readFileSync(join(ENTITIES, 'ticker-master.json'), 'utf8'));

// --- mirror gen-concept-themes.ts selection so 族群 links resolve to real pages ---
const THEME_KEYWORDS = ['CoWoS', '矽光子', 'CPO', 'HBM', 'ABF', '載板', '先進封裝', '重電', '散熱', '液冷', '低軌', '衛星', '機器人', '被動元件', '連接器', '矽智財', '碳化矽', '氮化鎵', '軍工', '無人機', '伺服器', '玻璃基板', 'Mini LED', 'Micro LED', '光通訊', '矽晶圓', '減重', '矽光', '第三代半導體', 'AI 伺服器', '矽晶'];
const EXCLUDE_TAGS = new Set(['觸控面板-衛星定位系統', '通信網路-主/被動元件', '記憶體產業', '記憶體設備產業', '記憶體模組']);
const SEED_SKIP = new Set(['被動元件', 'CoWoS-L']);
const SEED_MAP: Record<string, string> = { 被動元件: 'passive-components', 'CoWoS-L': 'cowos' };
const MIN = 2;
const MAX = 80;

function slugifyTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[\s/]+/g, '-').replace(/[^a-z0-9一-鿿-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function isGenTheme(g: ConceptGroup): boolean {
  const t = g.tag.trim();
  if (EXCLUDE_TAGS.has(t) || SEED_SKIP.has(t)) return false;
  if (g.codes.length < MIN || g.codes.length > MAX) return false;
  return THEME_KEYWORDS.some((k) => t.includes(k));
}

// code -> resolvable {slug, tag}[] (25 generated themes + 2 seed-mapped)
const code2themes = new Map<string, { slug: string; tag: string }[]>();
for (const g of groups) {
  const tag = g.tag.trim();
  let slug: string | null = null;
  if (SEED_MAP[tag]) slug = SEED_MAP[tag];
  else if (isGenTheme(g)) slug = slugifyTag(tag);
  if (!slug) continue;
  for (const code of g.codes) {
    const arr = code2themes.get(code) ?? [];
    arr.push({ slug, tag });
    code2themes.set(code, arr);
  }
}

function exch(market: string): string {
  return market === '2' ? 'TPEX' : 'TWSE';
}

function renderPage(code: string, m: Row): string {
  const themes = code2themes.get(code) ?? [];
  const themeLine = themes.length
    ? themes.map((t) => `[[themes/${t.slug}]] (${t.tag})`).join('、')
    : '（暫無題材族群歸屬）';
  return `---
type: ticker
slug: tickers/${code}
title: "${m.name} (${code})"
ticker: "${code}"
name: "${m.name}"
exchange: ${exch(m.market)}
market: TW
industry: "${m.industry}"
generated: true
---

# ${m.name} (${code})

> 自動生成的個股節點（來源：cmoney 上市櫃公司基本資料 + statementdog 族群）。
> 基本面、籌碼、催化劑、投資觀點請人工或後續 pipeline 補在這之上。

**產業**：${m.industry || '—'}

**所屬族群**：${themeLine}
`;
}

function main() {
  const dir = join(BRAIN_DIR, 'tickers');
  mkdirSync(dir, { recursive: true });
  let written = 0;
  let skipped = 0;
  for (const [code, m] of Object.entries(master)) {
    const path = join(dir, `${code}.md`);
    if (existsSync(path)) {
      skipped++;
      continue;
    }
    writeFileSync(path, renderPage(code, m), 'utf8');
    written++;
  }
  console.log(`ticker pages written: ${written}, skipped (exists): ${skipped}`);
}

main();
