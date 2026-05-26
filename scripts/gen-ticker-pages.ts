#!/usr/bin/env bun
/**
 * gen-ticker-pages.ts — ④ "last mile". Auto-generate a lightweight ticker node
 * for every listed stock in ticker-master.json. Once every stock is a node,
 * BOTH edge classes resolve: news→個股 (market-wide alias map) AND 族群→個股
 * (the theme pages). The graph spans the whole market.
 *
 * 族群 linking (P2a — full concept lattice):
 *   Each ticker lists EVERY concept group it belongs to that has a theme page
 *   on disk, as `[[themes/<slug>]]`. We mirror the theme pages by existence —
 *   a code links to a group iff `themes/<slug>.md` exists (so gen-concept-themes
 *   must run FIRST). This auto-includes the seed slugs (被動元件→passive-components,
 *   CoWoS-L→cowos) and any sub-4-member hot theme that was hand/seed-created,
 *   without re-deriving the [4,80] selection here. Multi-group stocks (e.g. 國巨
 *   in MLCC/濾波器/蘋果/被動元件/電容器/電感器/電阻器) bridge neighbourhoods —
 *   that's the "weak chain" topology.
 *
 * Idempotency:
 *   - generated stubs (`generated: true`) are OVERWRITTEN so a re-run refreshes
 *     their 族群 list after the theme set grows.
 *   - hand-curated pages (no `generated: true`) are SKIPPED — never clobbered.
 *
 * Re-run after refreshing data files / regenerating themes:
 *   bun run scripts/gen-concept-themes.ts [<brain_dir>]   # themes first
 *   bun run scripts/gen-ticker-pages.ts   [<brain_dir>]   # then tickers
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BRAIN_DIR = process.argv[2] || 'E:\\SinoBrain-data';
const ENTITIES = join(import.meta.dir, '..', 'src', 'core', 'entities');

interface ConceptGroup { tag: string; codes: string[]; }
interface Row { name: string; abbr: string; en: string; market: string; industry: string; }

const groups: ConceptGroup[] = JSON.parse(readFileSync(join(ENTITIES, 'concept-groups.json'), 'utf8'));
const master: Record<string, Row> = JSON.parse(readFileSync(join(ENTITIES, 'ticker-master.json'), 'utf8'));

// Tags a hand-curated seed theme owns — map to the seed slug, not slugifyTag.
const SEED_MAP: Record<string, string> = { 被動元件: 'passive-components', 'CoWoS-L': 'cowos' };

function slugifyTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[\s/]+/g, '-').replace(/[^a-z0-9一-鿿-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Theme pages that actually exist on disk (gen-concept-themes.ts ran first).
// A ticker only links to a 族群 whose page exists, so no dangling links.
const themesDir = join(BRAIN_DIR, 'themes');
const existingThemeSlugs = new Set<string>(
  existsSync(themesDir)
    ? readdirSync(themesDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    : [],
);

// code -> resolvable {slug, tag}[] for every group whose theme page exists.
const code2themes = new Map<string, { slug: string; tag: string }[]>();
for (const g of groups) {
  const tag = g.tag.trim();
  const slug = SEED_MAP[tag] ?? slugifyTag(tag);
  if (!slug || !existingThemeSlugs.has(slug)) continue;
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

/** Is this an auto-generated stub (safe to overwrite) vs a hand-curated page? */
function isGeneratedStub(raw: string): boolean {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  return !!fm && /^generated:\s*true\b/m.test(fm[1]!);
}

function main() {
  const dir = join(BRAIN_DIR, 'tickers');
  mkdirSync(dir, { recursive: true });
  let created = 0;
  let refreshed = 0;
  let skippedHand = 0;
  for (const [code, m] of Object.entries(master)) {
    const path = join(dir, `${code}.md`);
    if (existsSync(path)) {
      if (!isGeneratedStub(readFileSync(path, 'utf8'))) {
        skippedHand++; // hand-curated — never clobber
        continue;
      }
      writeFileSync(path, renderPage(code, m), 'utf8');
      refreshed++;
      continue;
    }
    writeFileSync(path, renderPage(code, m), 'utf8');
    created++;
  }
  const linked = [...code2themes.keys()].filter((c) => master[c]).length;
  console.log(
    `ticker pages — created: ${created}, refreshed: ${refreshed}, skipped (hand-curated): ${skippedHand}`,
  );
  console.log(`theme pages on disk: ${existingThemeSlugs.size}; stocks with >=1 族群 link: ${linked}`);
}

main();
