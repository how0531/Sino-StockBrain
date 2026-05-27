#!/usr/bin/env bun
/**
 * ingest-research.ts — turn a user-provided research report file into a
 * schema-v1 news-raw JSON so the existing news-ingest pipeline (wikify +
 * graph) picks it up.
 *
 * Two writes per ingest:
 *   1. ORIGINAL preserved → <brain_dir>/research-reports/<YYYY-MM-DD>/<slug>.md
 *      (db_tracked — your handwritten reports live in git)
 *   2. SCHEMA-V1 emitted  → <brain_dir>/news-raw/<YYYY-MM-DD>/research-<slug>.json
 *      (db_only — news-ingest converts this into news/<date>/<slug>.md)
 *
 * After ingest, the user should run:
 *   gbrain jobs submit news-ingest --follow \
 *     --params '{"brain_dir":"...","date":"<date>","source":"<source_name>"}'
 *
 * Then `gbrain import + extract links` (or reimport-graph-pages) so the graph
 * builds the ticker ↔ report edges.
 *
 * Input formats:
 *   .md / .markdown — body = full file (frontmatter parsed for metadata)
 *   .txt            — body = full file
 *   .pdf            — NOT yet implemented; pre-convert with `pdftotext` or
 *                     use the brain-pdf skill (prints a clear error).
 *
 * Metadata is layered: file frontmatter (if any) → CLI flags override → defaults.
 *
 * Usage:
 *   bun run scripts/ingest-research.ts <file>
 *     [--brain-dir=<dir>]
 *     [--title="..."]
 *     [--tickers=2330,2454]
 *     [--firm="..."]  [--analyst="..."]
 *     [--rec=Buy|Hold|Sell|Neutral]
 *     [--tp=180]   (target price, TWD)
 *     [--report-date=YYYY-MM-DD]
 *     [--report-url=...]
 *     [--tags=memory,AI]
 *     [--source=user-research]
 *     [--published-at=2026-05-28T14:30:00+08:00]
 *     [--dry-run]
 *
 * See docs/research-reports.md for the schema spec.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const DEFAULT_BRAIN_DIR = 'E:\\SinoBrain-data';
const DEFAULT_SOURCE = 'user-research';

interface CliArgs {
  file: string;
  brainDir: string;
  title?: string;
  tickers?: string[];
  firm?: string;
  analyst?: string;
  rec?: string;
  targetPrice?: number;
  reportDate?: string;
  reportUrl?: string;
  tags?: string[];
  source: string;
  publishedAt?: string;
  dryRun: boolean;
}

interface ReportRecord {
  schema_version: 1;
  article_id: string;
  source_name: string;
  published_at: string;
  title: string;
  body: string;
  url?: string;
  hint_tickers?: string[];
  fetched_at?: string;
  report_kind?: string;
  analyst_firm?: string;
  analyst_name?: string;
  recommendation?: string;
  target_price?: number;
  report_date?: string;
  report_url?: string;
  tags?: string[];
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0]!.startsWith('--')) {
    die('first argument must be the report file path');
  }
  const a: CliArgs = {
    file: argv[0]!,
    brainDir: DEFAULT_BRAIN_DIR,
    source: DEFAULT_SOURCE,
    dryRun: false,
  };
  for (const arg of argv.slice(1)) {
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    const val = eq > 0 ? arg.slice(eq + 1) : '';
    switch (key) {
      case '--brain-dir': a.brainDir = val; break;
      case '--title': a.title = val; break;
      case '--tickers': a.tickers = val.split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--firm': a.firm = val; break;
      case '--analyst': a.analyst = val; break;
      case '--rec': a.rec = val; break;
      case '--tp': a.targetPrice = parseFloat(val); break;
      case '--report-date': a.reportDate = val; break;
      case '--report-url': a.reportUrl = val; break;
      case '--tags': a.tags = val.split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--source': a.source = val; break;
      case '--published-at': a.publishedAt = val; break;
      case '--dry-run': a.dryRun = true; break;
      default: die(`unknown flag: ${arg}`);
    }
  }
  return a;
}

function die(msg: string): never {
  console.error(`[ingest-research] ${msg}`);
  process.exit(1);
}

/** Parse YAML-ish frontmatter. We only handle the simple shapes you'd put in
 *  a research markdown: scalar `key: value` and inline-array `key: [a, b]`.
 *  Block-arrays (`key:\n - a\n - b`) intentionally NOT supported — keep your
 *  research frontmatter flat. Returns body + metadata. */
function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const fm = m[1]!;
  const body = m[2]!;
  const meta: Record<string, unknown> = {};
  for (const line of fm.split(/\r?\n/)) {
    const mm = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!mm) continue;
    const key = mm[1]!;
    let v: string = mm[2]!.trim();
    // strip wrapping quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // inline-array
    if (v.startsWith('[') && v.endsWith(']')) {
      meta[key] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(v)) { meta[key] = parseFloat(v); continue; }
    if (v === '') continue;
    meta[key] = v;
  }
  return { meta, body };
}

/** Lowercased, hyphenated, alphanum + CJK kept. Anything else drops. */
function slugify(s: string): string {
  return s.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9一-鿿-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 80) || 'report';
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function isoNow(): string {
  const d = new Date();
  // ISO with +08:00 (TW). Approximate: convert UTC to +08 by adding 8h.
  const tw = new Date(d.getTime() + 8 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${tw.getUTCFullYear()}-${pad(tw.getUTCMonth() + 1)}-${pad(tw.getUTCDate())}T${pad(tw.getUTCHours())}:${pad(tw.getUTCMinutes())}:${pad(tw.getUTCSeconds())}+08:00`;
}

function dateOf(iso: string): string { return iso.slice(0, 10); }

function loadBody(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === '.pdf') {
    die(`PDF ingest not yet implemented. Pre-convert with: pdftotext "${file}" "${file.replace(/\.pdf$/i, '.txt')}" and re-run on the .txt`);
  }
  if (!['.md', '.markdown', '.txt'].includes(ext)) {
    die(`unsupported extension "${ext}" — accept .md, .markdown, .txt (use pdftotext for PDFs)`);
  }
  return readFileSync(file, 'utf-8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.file) || !statSync(args.file).isFile()) {
    die(`file not found: ${args.file}`);
  }

  const raw = loadBody(args.file);
  const { meta, body } = splitFrontmatter(raw);

  // CLI flags override frontmatter; frontmatter is the default layer.
  const get = <T>(cliKey: keyof CliArgs, metaKey: string): T | undefined =>
    (args[cliKey] ?? meta[metaKey]) as T | undefined;

  const title = (get<string>('title', 'title') ?? basename(args.file, extname(args.file))).trim();
  if (!title) die('title is required (CLI --title or frontmatter "title:")');

  const publishedAt = get<string>('publishedAt', 'published_at') ?? isoNow();
  const dateStr = dateOf(publishedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    die(`published_at must be ISO 8601 starting with YYYY-MM-DD; got "${publishedAt}"`);
  }

  const tickers = (get<unknown>('tickers', 'hint_tickers') as string[] | string | undefined);
  const hintTickers = Array.isArray(tickers)
    ? tickers.map(String).filter(Boolean)
    : typeof tickers === 'string'
    ? tickers.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const sourceName = (get<string>('source', 'source_name') ?? DEFAULT_SOURCE).trim();
  if (!sourceName.startsWith('user-research') && !sourceName.startsWith('internal-memo')) {
    die(`source_name must start with "user-research" or "internal-memo"; got "${sourceName}"`);
  }

  // Two slug shapes: the ORIGINAL on-disk file keeps a human-readable slug
  // (may contain CJK so you can `ls research-reports/` and recognise the
  // report). The schema-v1 article_id is ASCII-only — news-ingest strips
  // CJK from article_id when building the wikified slug, which produced
  // ugly `research-20260528-abf-------...` slugs that downstream rejected.
  const slug = slugify(get<string>('title', 'slug') ?? title);
  const articleId = `research-${dateStr.replace(/-/g, '')}-${fnv1a(args.file + title)}`;

  const record: ReportRecord = {
    schema_version: 1,
    article_id: articleId,
    source_name: sourceName,
    published_at: publishedAt,
    title,
    body: body.trim(),
  };
  if (hintTickers.length) record.hint_tickers = hintTickers;
  if (get<string>('reportUrl', 'report_url')) record.report_url = String(get('reportUrl', 'report_url'));
  record.fetched_at = isoNow();
  record.report_kind = (meta.report_kind as string | undefined) ?? 'user-research';
  const firm = get<string>('firm', 'analyst_firm'); if (firm) record.analyst_firm = String(firm);
  const an = get<string>('analyst', 'analyst_name'); if (an) record.analyst_name = String(an);
  const rec = get<string>('rec', 'recommendation'); if (rec) record.recommendation = String(rec);
  const tp = get<unknown>('targetPrice', 'target_price');
  if (tp !== undefined && tp !== '' && !Number.isNaN(Number(tp))) record.target_price = Number(tp);
  const rd = get<string>('reportDate', 'report_date'); if (rd) record.report_date = String(rd);
  const tags = get<unknown>('tags', 'tags');
  const tagList = Array.isArray(tags) ? tags.map(String) : (typeof tags === 'string' ? tags.split(',').map((s) => s.trim()).filter(Boolean) : []);
  if (tagList.length) record.tags = tagList;

  // Paths
  const originalsDir = join(args.brainDir, 'research-reports', dateStr);
  const originalsPath = join(originalsDir, `${slug}.md`);
  const rawDir = join(args.brainDir, 'news-raw', dateStr);
  const rawPath = join(rawDir, `research-${slug}.json`);

  if (args.dryRun) {
    console.log('===== DRY RUN =====');
    console.log(`would write original: ${originalsPath}`);
    console.log(`would write rawjson:  ${rawPath}`);
    console.log(`record:\n${JSON.stringify(record, null, 2)}`);
    return;
  }

  mkdirSync(originalsDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });

  // Preserve original verbatim (with frontmatter if any).
  writeFileSync(originalsPath, raw, 'utf-8');
  // Atomic-ish write for the schema-v1 (since news-ingest will read this).
  writeFileSync(rawPath, JSON.stringify(record, null, 2), 'utf-8');

  console.log(`[ingest-research] ${title}`);
  console.log(`  original  → ${originalsPath}`);
  console.log(`  schema-v1 → ${rawPath}`);
  console.log(`  source    = ${sourceName}`);
  console.log(`  date      = ${dateStr}`);
  if (hintTickers.length) console.log(`  tickers   = ${hintTickers.join(', ')}`);
  console.log('');
  console.log('Next: feed this into the graph:');
  console.log(`  bun run src/cli.ts jobs submit news-ingest --follow \\`);
  console.log(`    --params '{"brain_dir":"${args.brainDir.replace(/\\/g, '/')}","date":"${dateStr}","source":"${sourceName}"}'`);
}

main();
