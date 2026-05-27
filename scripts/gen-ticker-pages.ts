#!/usr/bin/env bun
/**
 * gen-ticker-pages.ts — auto-generate wiki-style ticker pages for every listed
 * stock. After ticker-profiles.json landed alongside the slim master, this
 * generator promotes the per-ticker page from a one-line stub to a full
 * factual entry:
 *
 *   公司基本資料 / 主要業務 / 所屬族群 / 觀察點 Catalysts / 大事年表
 *
 * All sections are sourced from structured data (cmoney 公司基本資料 +
 * statementdog concept groups), so NO LLM is invoked here. Narrative sections
 * (e.g. "近期動態" summarising news flow) are intentionally left out — those
 * belong to a separate LLM pass that must run through compliance-filter.
 *
 * 族群 linking — each ticker lists every concept group it belongs to that has
 * a theme page on disk, as `[[themes/<slug>]]`. Mirror by existence — code →
 * group iff `themes/<slug>.md` exists, so gen-concept-themes MUST run first.
 *
 * Idempotency:
 *   - `generated: true` pages are OVERWRITTEN (a re-run refreshes the data).
 *   - hand-curated pages (frontmatter without `generated: true`) are SKIPPED.
 *
 * Re-run sequence:
 *   bun run scripts/gen-concept-themes.ts [<brain_dir>]   # themes first
 *   bun run scripts/gen-ticker-pages.ts   [<brain_dir>]   # then tickers
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BRAIN_DIR = process.argv[2] || 'E:\\SinoBrain-data';
const ENTITIES = join(import.meta.dir, '..', 'src', 'core', 'entities');

interface ConceptGroup { tag: string; codes: string[]; }
interface Row { name: string; abbr: string; en: string; market: string; industry: string; }
interface Profile {
  full_name?: string; industry?: string; industry_position?: string;
  business?: string; focus?: string; listed_date?: string;
  chairman?: string; ceo?: string; spokesperson?: string;
  employees?: number; capital_million?: number; export_ratio?: number;
  website?: string; isin?: string;
}

interface MonthlyRevenue {
  ticker: string;
  year_month: string;       // YYYYMM
  revenue: number;          // 元
  yoy_pct: number;
  mom_pct: number;
  cum_yoy_pct: number;
  ttm_yoy_pct: number;
  three_month_yoy_pct: number;
  announce_date: string;    // YYYY-MM-DD
}

interface ConsensusEPS {
  ticker: string;
  year_month: string;
  ttm_eps: number | null;
  current_year_eps: number | null;
  next_year_eps: number | null;
  current_year_growth_pct: number | null;
  next_year_growth_pct: number | null;
  analyst_count: number | null;
  analyst_count_next: number | null;
  pe_low: number | null;
  pe_high: number | null;
  updated_date: string;
}

const groups: ConceptGroup[] = JSON.parse(readFileSync(join(ENTITIES, 'concept-groups.json'), 'utf8'));
const master: Record<string, Row> = JSON.parse(readFileSync(join(ENTITIES, 'ticker-master.json'), 'utf8'));
const PROFILES_PATH = join(ENTITIES, 'ticker-profiles.json');
const profiles: Record<string, Profile> = existsSync(PROFILES_PATH)
  ? JSON.parse(readFileSync(PROFILES_PATH, 'utf8'))
  : {};

/** Latest fundamentals/<kind>/<YYYY-MM>/_index.json, optional. The handlers
 *  write this alongside _summary.md on every run. Missing → section skipped. */
function loadLatestIndex<T>(kind: 'revenue' | 'eps'): { ymDir: string; byTicker: Record<string, T> } | null {
  const dir = join(BRAIN_DIR, 'fundamentals', kind);
  if (!existsSync(dir)) return null;
  const months = readdirSync(dir).filter((f) => /^\d{4}-\d{2}$/.test(f)).sort();
  if (!months.length) return null;
  const ymDir = months[months.length - 1]!;
  const indexPath = join(dir, ymDir, '_index.json');
  if (!existsSync(indexPath)) return null;
  const data = JSON.parse(readFileSync(indexPath, 'utf8'));
  return { ymDir, byTicker: data.by_ticker ?? {} };
}
const latestRevenue = loadLatestIndex<MonthlyRevenue>('revenue');
const latestEPS = loadLatestIndex<ConsensusEPS>('eps');

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

/** YAML-safe double-quoted string (handles ":" "\\" `"` in CJK fields like 總裁:魏哲家). */
function yq(v: string): string {
  return JSON.stringify(v);
}

/** "NT$ 2,593 億" — capital_million is the cmoney column "實收資本額(百萬)". */
function fmtCapital(million?: number): string {
  if (!million || million <= 0) return '';
  const yi = million / 100;
  if (yi >= 1) return `NT$ ${Math.round(yi).toLocaleString('en')} 億`;
  return `NT$ ${Math.round(million).toLocaleString('en')} 百萬`;
}

function fmtPct(p?: number): string {
  if (p === undefined || p === null || Number.isNaN(p)) return '';
  return `${Math.round(p)}%`;
}

/** 元 → 億 (NT$ X 億). Compact: rounds to whole 億 above 100, 1dp below. */
function fmtRevYi(yuan?: number): string {
  if (!yuan || yuan <= 0) return '';
  const yi = yuan / 1e8;
  if (yi >= 100) return `NT$ ${Math.round(yi).toLocaleString('en')} 億`;
  return `NT$ ${yi.toFixed(1)} 億`;
}

/** Signed pct with 1dp ("+17.5%" / "-1.1%"); empty when missing/NaN. */
function fmtPctSigned(p?: number): string {
  if (p === undefined || p === null || Number.isNaN(p)) return '';
  const s = p > 0 ? '+' : '';
  return `${s}${p.toFixed(1)}%`;
}

/** Frontmatter lines that exist only when the profile has data — keeps the
 *  YAML compact and lets downstream `key in frontmatter` mean something. */
function buildFrontmatter(code: string, m: Row, p: Profile): string {
  const lines: string[] = [
    'type: ticker',
    `slug: tickers/${code}`,
    `title: ${yq(`${m.name} (${code})`)}`,
    `ticker: "${code}"`,
    `name: ${yq(m.name)}`,
    `exchange: ${exch(m.market)}`,
    'market: TW',
    `industry: ${yq(m.industry || p.industry || '')}`,
  ];
  if (p.full_name) lines.push(`full_name: ${yq(p.full_name)}`);
  if (p.industry_position) lines.push(`industry_position: ${yq(p.industry_position)}`);
  if (p.listed_date) lines.push(`listed_date: ${p.listed_date}`);
  if (p.isin) lines.push(`isin: ${p.isin}`);
  if (p.website) lines.push(`website: ${yq(p.website)}`);
  lines.push('generated: true');
  return lines.join('\n');
}

function renderPage(code: string, m: Row): string {
  const p: Profile = profiles[code] ?? {};
  const themes = code2themes.get(code) ?? [];
  const themeLine = themes.length
    ? themes.map((t) => `[[themes/${t.slug}]] (${t.tag})`).join('、')
    : '（暫無題材族群歸屬，可能未在 statementdog 概念股清單上）';

  // Lead — prefer 產業地位 (the gold one-liner), fall back to 營業焦點, else generic.
  const lead = p.industry_position || p.focus || `${m.industry || '上市公司'}（自動生成節點）`;

  // 公司基本資料 — assemble line by line so missing fields drop cleanly.
  const basicLines: string[] = [];
  if (p.full_name) basicLines.push(`- 公司全名：${p.full_name}`);
  basicLines.push(`- 產業：${m.industry || p.industry || '—'}`);
  if (p.listed_date) basicLines.push(`- 上市日期：${p.listed_date}`);
  const exec: string[] = [];
  if (p.chairman) exec.push(`董事長：${p.chairman}`);
  if (p.ceo && p.ceo !== p.chairman) exec.push(`總經理：${p.ceo}`);
  if (exec.length) basicLines.push(`- ${exec.join('　·　')}`);
  if (p.spokesperson) basicLines.push(`- 發言人：${p.spokesperson}`);
  const capLine: string[] = [];
  const cap = fmtCapital(p.capital_million);
  if (cap) capLine.push(`實收資本額：${cap}`);
  if (p.employees && p.employees > 0) capLine.push(`員工 ${p.employees.toLocaleString('en')} 人`);
  const pct = fmtPct(p.export_ratio);
  if (pct) capLine.push(`外銷比重 ${pct}`);
  if (capLine.length) basicLines.push(`- ${capLine.join('　·　')}`);
  if (p.website) basicLines.push(`- 網址：${p.website}`);

  // 主要業務 — cmoney 經營項目 + 營業焦點. If both absent, omit section.
  const businessParts: string[] = [];
  if (p.business) businessParts.push(`> ${p.business}`);
  if (p.focus && p.focus !== p.industry_position) {
    businessParts.push(`\n營業焦點：${p.focus}`);
  }

  // 大事年表 — auto only the listing event; hand-curated milestones append later.
  const timeline: string[] = [];
  if (p.listed_date) {
    const venue = m.market === '2' ? '上櫃' : '上市';
    timeline.push(`- ${p.listed_date}　${venue}掛牌`);
  }

  const sections: string[] = [];
  sections.push(`# ${m.name} (${code})`);
  sections.push(`\n> ${lead}`);
  if (basicLines.length) {
    sections.push(`\n## 公司基本資料\n\n${basicLines.join('\n')}`);
  }
  if (businessParts.length) {
    sections.push(`\n## 主要業務\n\n${businessParts.join('\n')}`);
  }

  // 財務脈動 — combines monthly revenue + analyst-consensus EPS in one section.
  // Both are monthly snapshots but different cadences (公告 ~10th vs analyst
  // refresh), so the header lists both timestamps. Bold the headline numbers
  // (current-month YoY for revenue, next-year forecast for EPS).
  const rev = latestRevenue?.byTicker[code];
  const e = latestEPS?.byTicker[code];
  if (rev || e) {
    const lines: string[] = [];
    const stamps: string[] = [];
    if (rev && latestRevenue) stamps.push(`月營收 ${latestRevenue.ymDir}（公告 ${rev.announce_date}）`);
    if (e && latestEPS) stamps.push(`機構 EPS 預估 ${latestEPS.ymDir}（更新 ${e.updated_date}）`);
    lines.push(`> ${stamps.join('　·　')}`, '');

    if (rev && latestRevenue) {
      lines.push('**營收**');
      const yi = fmtRevYi(rev.revenue);
      if (yi) lines.push(`- 單月 ${yi}　YoY **${fmtPctSigned(rev.yoy_pct)}**　MoM ${fmtPctSigned(rev.mom_pct)}`);
      lines.push(`- 累計(YTD) YoY ${fmtPctSigned(rev.cum_yoy_pct) || '—'}　·　近 12 月(TTM) YoY ${fmtPctSigned(rev.ttm_yoy_pct) || '—'}`);
      lines.push('');
    }
    if (e && latestEPS) {
      lines.push('**EPS（機構預估，括弧內為覆蓋家數）**');
      const ttm = e.ttm_eps != null ? `${e.ttm_eps.toFixed(2)} 元` : '—';
      const cy = e.current_year_eps != null ? `${e.current_year_eps.toFixed(2)} 元` : '—';
      const ny = e.next_year_eps != null ? `${e.next_year_eps.toFixed(2)} 元` : '—';
      const cyg = e.current_year_growth_pct != null ? fmtPctSigned(e.current_year_growth_pct) : '';
      const nyg = e.next_year_growth_pct != null ? fmtPctSigned(e.next_year_growth_pct) : '';
      const ac = e.analyst_count ?? 0;
      const acN = e.analyst_count_next ?? 0;
      lines.push(`- 近 4 季 EPS（實際）：${ttm}　·　今年機構估：${cy}${cyg ? `（${cyg}，${ac} 家）` : ''}`);
      lines.push(`- **明年機構估：${ny}**${nyg ? `（${nyg}，${acN} 家）` : ''}`);
      if (e.pe_low != null && e.pe_high != null) {
        lines.push(`- 本益比區間：${e.pe_low.toFixed(1)}x – ${e.pe_high.toFixed(1)}x`);
      }
      lines.push('');
    }

    const refs: string[] = [];
    if (rev && latestRevenue) refs.push(`[[fundamentals/revenue/${latestRevenue.ymDir}/${code}]]`);
    if (e && latestEPS) refs.push(`[[fundamentals/eps/${latestEPS.ymDir}/${code}]]`);
    if (refs.length) lines.push(`詳見 ${refs.join('、')}`);

    sections.push(`\n## 財務脈動\n\n${lines.join('\n')}`);
  }

  sections.push(`\n## 所屬族群\n\n${themeLine}`);
  sections.push(
    `\n## 觀察點 Catalysts\n\n` +
      `- 每月 10 日前：月營收公告\n` +
      `- 季度法說會（通常 1/4/7/10 月）\n` +
      (themes.length
        ? `- 所屬題材觸發：${themes.slice(0, 3).map((t) => `[[themes/${t.slug}]]`).join('、')}`
        : `- 同產業（${m.industry || '—'}）動態`),
  );
  if (timeline.length) {
    sections.push(`\n## 大事年表\n\n${timeline.join('\n')}`);
  }
  sections.push(
    `\n---\n*此頁由 \`gen-ticker-pages.ts\` 自動生成；要客製化請從 frontmatter 移除 \`generated: true\` 後手動編輯，重生時不會被覆蓋。*`,
  );

  return `---\n${buildFrontmatter(code, m, p)}\n---\n\n${sections.join('\n')}\n`;
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
