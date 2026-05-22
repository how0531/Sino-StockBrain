#!/usr/bin/env bun
/**
 * news-from-skill.ts — bridge the user's local `stock-news-skill` output into
 * SinoBrain's schema-v1 news-raw JSON, so `news-ingest --source stock-news-skill`
 * can wikify it into the graph.
 *
 * The stock-news-skill (a separate, shared Sinopac skill) writes its result to
 * `out/news_result.json` with this shape:
 *
 *   {
 *     "generated_at": "YYYY-MM-DD HH:MM",
 *     "query": {...},
 *     "by_code": { "2330": [ <item>, ... ], ... },   // --codes / --report mode
 *     "keyword_hits": [ <item>, ... ]                // --keyword mode
 *   }
 *
 * where each <item> = { time, title, source, url, summary, body,
 *                       sentiment, confidence, events, code?, name? }.
 *
 * This bridge maps each item to SinoBrain's schema-v1 contract (see
 * skills/stock-news-skill/SKILL.md) and writes one file per article to
 *   <brain_dir>/news-raw/<published-date>/<source>-<article_id>.json
 * atomically, skipping files that already exist (idempotent).
 *
 * It deliberately lives on the SinoBrain side and never touches the skill.
 *
 * Usage:
 *   bun run scripts/news-from-skill.ts                       # defaults below
 *   bun run scripts/news-from-skill.ts --in=<news_result.json> --brain-dir=<dir>
 *   bun run scripts/news-from-skill.ts --dry-run             # preview, write nothing
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';

const DEFAULT_IN =
  'C:\\Users\\012701\\.claude\\skills\\stock-news-skill\\out\\news_result.json';
const DEFAULT_BRAIN_DIR = 'E:\\SinoBrain-data';

interface SkillItem {
  time?: string;
  title?: string;
  source?: string;
  url?: string;
  summary?: string;
  body?: string;
  sentiment?: string;
  confidence?: number;
  events?: string[];
  code?: string;
  name?: string;
}

interface SkillPayload {
  generated_at?: string;
  by_code?: Record<string, SkillItem[]>;
  keyword_hits?: SkillItem[];
}

function parseArgs(argv: string[]) {
  const out = { in: DEFAULT_IN, brainDir: DEFAULT_BRAIN_DIR, dryRun: false };
  for (const a of argv) {
    if (a.startsWith('--in=')) out.in = a.slice('--in='.length);
    else if (a.startsWith('--brain-dir=')) out.brainDir = a.slice('--brain-dir='.length);
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

/** FNV-1a 32-bit hash → 8 hex chars. Stable fallback id when no url. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Derive a filesystem-safe article id from the url's last path segment,
 *  else from a hash of the title. */
function deriveArticleId(url: string | undefined, title: string): string {
  if (url) {
    const noQuery = url.split('?')[0]!.split('#')[0]!.replace(/\/+$/, '');
    const seg = noQuery.split('/').pop() ?? '';
    const cleaned = seg.replace(/[^A-Za-z0-9_-]/g, '');
    // Use the path segment only when it carries a real id (>=4 consecutive
    // digits), e.g. cnyes "5483921", ctee "20260522700439-430201". For urls
    // whose id lives in the query string (moneydj "newsviewer.aspx?a=12345"),
    // the segment is a generic page name -> hash the FULL url so distinct
    // articles get distinct ids instead of all colliding on the page name.
    // Keep the segment only when it's a real, compact id: a 4+ digit run, not
    // a percent-encoded CJK title blob (yahoo encodes the title into the path),
    // and not absurdly long. Lowercase it — gbrain slugs are always lowercase,
    // so an uppercase article_id makes news-ingest write a frontmatter slug
    // that mismatches the path-derived (lowercased) slug and import rejects the
    // page with SLUG_MISMATCH (this exact bug lost ~22 yahoo articles).
    if (/\d{4,}/.test(cleaned) && cleaned.length <= 40 && !seg.includes('%')) {
      return cleaned.toLowerCase();
    }
    return 'h' + fnv1a(url);
  }
  return 'h' + fnv1a(title);
}

/** source label → safe slug segment (the skill already emits lowercase ascii). */
function safeSource(source: string | undefined): string {
  const s = (source ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return s || 'unknown';
}

function isoDate(time: string): string | null {
  // skill `time` is already ISO 8601 with +08:00 → first 10 chars are the date.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(time);
  return m ? m[1]! : null;
}

function atomicWrite(path: string, content: string) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.in)) {
    console.error(`[news-from-skill] input not found: ${args.in}`);
    console.error(`  run the skill first, e.g.:`);
    console.error(`  python -X utf8 <skill>/scripts/news.py --codes=2330 --days=3 --format=json`);
    process.exit(1);
  }

  let payload: SkillPayload;
  try {
    payload = JSON.parse(readFileSync(args.in, 'utf-8'));
  } catch (e) {
    console.error(`[news-from-skill] failed to parse ${args.in}: ${(e as Error).message}`);
    process.exit(1);
  }

  // Flatten by_code (attach the dict key as the ticker hint) + keyword_hits.
  const flat: SkillItem[] = [];
  for (const [code, items] of Object.entries(payload.by_code ?? {})) {
    for (const it of items ?? []) flat.push({ ...it, code: it.code || code });
  }
  for (const it of payload.keyword_hits ?? []) flat.push(it);

  const fetchedAt = payload.generated_at
    ? payload.generated_at.replace(' ', 'T') + ':00+08:00'
    : undefined;

  let written = 0;
  let skippedExists = 0;
  let skippedInvalid = 0;
  const seen = new Set<string>();
  const byDateSource = new Map<string, number>();

  for (const it of flat) {
    const title = (it.title ?? '').trim();
    const body = (it.body ?? it.summary ?? '').trim();
    const time = (it.time ?? '').trim();
    const date = time ? isoDate(time) : null;

    if (!title || !body || !date) {
      skippedInvalid++;
      continue;
    }

    const source = safeSource(it.source);
    const articleId = deriveArticleId(it.url, title);
    const fname = `${source}-${articleId}.json`;
    const dedupKey = `${date}/${fname}`;
    if (seen.has(dedupKey)) {
      skippedExists++;
      continue;
    }
    seen.add(dedupKey);

    const record: Record<string, unknown> = {
      schema_version: 1,
      article_id: articleId,
      source_name: source,
      published_at: time,
      title,
      body,
    };
    if (it.url) record.url = it.url;
    const hintTickers = (it.code ?? '').trim();
    if (hintTickers) record.hint_tickers = [hintTickers];
    if (fetchedAt) record.fetched_at = fetchedAt;
    // Bonus signal from the skill — schema-v1 ignores unknown keys, but we keep
    // it on disk so a future SinoBrain enhancement can carry it into the graph.
    if (it.sentiment) record.sentiment = it.sentiment;
    if (typeof it.confidence === 'number') record.confidence = it.confidence;
    if (it.events && it.events.length) record.events = it.events;

    const dir = join(args.brainDir, 'news-raw', date);
    const path = join(dir, fname);

    byDateSource.set(`${date}/${source}`, (byDateSource.get(`${date}/${source}`) ?? 0) + 1);

    if (args.dryRun) {
      written++;
      continue;
    }
    if (existsSync(path)) {
      skippedExists++;
      continue;
    }
    mkdirSync(dir, { recursive: true });
    atomicWrite(path, JSON.stringify(record, null, 2));
    written++;
  }

  console.error('===== news-from-skill =====');
  console.error(`input:      ${args.in}`);
  console.error(`brain_dir:  ${args.brainDir}`);
  console.error(`mode:       ${args.dryRun ? 'DRY-RUN (no files written)' : 'write'}`);
  console.error(`items:      ${flat.length}`);
  console.error(`written:    ${written}`);
  console.error(`skipped (exists/dupe): ${skippedExists}`);
  console.error(`skipped (missing title/body/date): ${skippedInvalid}`);
  console.error('by date/source:');
  for (const [k, n] of [...byDateSource.entries()].sort()) {
    console.error(`  ${k}: ${n}`);
  }
}

main();
