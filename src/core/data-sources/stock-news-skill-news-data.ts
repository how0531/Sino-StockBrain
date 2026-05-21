/**
 * NewsSource adapter — reads raw JSON produced by `stock-news-skill`
 * (or any compatible upstream news collector) and exposes it as a
 * `NewsSource`. The wikify + dedup + frontmatter formatting happens
 * downstream in the `news-ingest` handler — this adapter only does
 * the read + shape-validate step.
 *
 * Contract (the JSON the skill must write):
 *
 *   <brain_dir>/news-raw/<YYYY-MM-DD>/<source>-<article_id>.json
 *
 *   {
 *     "schema_version": 1,
 *     "article_id": "<source-unique-id>",
 *     "source_name": "<upstream-source>",       # cnyes / commercial-times / ...
 *     "published_at": "<ISO 8601>",             # ideally TPE offset
 *     "title": "<headline>",
 *     "body": "<naked text body — wikify happens downstream>",
 *     "url": "<original URL, optional>",
 *     "hint_tickers": ["2330", "NVDA"],         # optional, helps wikify
 *     "hint_themes": ["passive-components"],    # optional
 *     "raw_html": "<optional, kept for re-extraction>",
 *     "fetched_at": "<ISO 8601>"
 *   }
 *
 * Schema versioning: the adapter accepts schema_version === 1 only.
 * Bump the version + add migration logic when the shape changes.
 *
 * Robustness contract: malformed files are SKIPPED with a stderr log,
 * never thrown. The pipeline runs daily — one bad file shouldn't kill
 * the whole day's ingest.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NewsArticle, NewsSource, ResolveNewsOpts } from './news-data.ts';

const SCHEMA_VERSION = 1;

interface RawArticleJson {
  schema_version: number;
  article_id: string;
  source_name: string;
  published_at: string;
  title: string;
  body: string;
  url?: string;
  hint_tickers?: string[];
  hint_themes?: string[];
  // Fields we accept but don't propagate — kept for future use:
  raw_html?: string;
  fetched_at?: string;
}

export class StockNewsSkillNewsSource implements NewsSource {
  readonly name = 'stock-news-skill';
  private readonly brainDir: string;

  constructor(opts: ResolveNewsOpts) {
    this.brainDir = opts.brain_dir;
  }

  async getArticles(date: string): Promise<NewsArticle[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];

    const dir = join(this.brainDir, 'news-raw', date);
    if (!existsSync(dir)) return [];

    const articles: NewsArticle[] = [];
    const seenIds = new Set<string>();

    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const filePath = join(dir, entry);

      let raw: RawArticleJson | null;
      try {
        const text = readFileSync(filePath, 'utf8');
        raw = JSON.parse(text) as RawArticleJson;
      } catch (e) {
        process.stderr.write(
          `[stock-news-skill-adapter] skip ${entry}: ${(e as Error).message}\n`,
        );
        continue;
      }

      const validated = validateRaw(raw, entry);
      if (!validated) continue;

      // Dedup by article_id (last-write-wins would be wrong — first wins
      // is fine because readdirSync output is OS-sorted, deterministic enough).
      if (seenIds.has(validated.article_id)) continue;
      seenIds.add(validated.article_id);

      articles.push({
        id: validated.article_id,
        published_at: validated.published_at,
        source: validated.source_name,
        title: validated.title,
        body: validated.body,
        url: validated.url,
        hint_tickers: validated.hint_tickers,
        hint_themes: validated.hint_themes,
      });
    }

    // Stable sort: published_at ascending → article_id tiebreaker for
    // reproducibility across runs / OSes.
    articles.sort((a, b) => {
      const ta = a.published_at.localeCompare(b.published_at);
      if (ta !== 0) return ta;
      return a.id.localeCompare(b.id);
    });

    return articles;
  }
}

/** Validate one JSON record. Returns the typed object on success, null on
 *  failure (after logging the reason). */
function validateRaw(raw: unknown, filename: string): RawArticleJson | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    process.stderr.write(`[stock-news-skill-adapter] skip ${filename}: not an object\n`);
    return null;
  }
  const r = raw as Record<string, unknown>;

  if (r.schema_version !== SCHEMA_VERSION) {
    process.stderr.write(
      `[stock-news-skill-adapter] skip ${filename}: schema_version=${String(r.schema_version)} ` +
      `(expected ${SCHEMA_VERSION})\n`,
    );
    return null;
  }

  const required: Array<keyof RawArticleJson> = [
    'article_id', 'source_name', 'published_at', 'title', 'body',
  ];
  for (const k of required) {
    if (typeof r[k] !== 'string' || !r[k]) {
      process.stderr.write(
        `[stock-news-skill-adapter] skip ${filename}: missing/empty "${k}"\n`,
      );
      return null;
    }
  }

  if (r.url !== undefined && typeof r.url !== 'string') {
    process.stderr.write(`[stock-news-skill-adapter] skip ${filename}: "url" must be string\n`);
    return null;
  }
  if (r.hint_tickers !== undefined && !isStringArray(r.hint_tickers)) {
    process.stderr.write(
      `[stock-news-skill-adapter] skip ${filename}: "hint_tickers" must be string[]\n`,
    );
    return null;
  }
  if (r.hint_themes !== undefined && !isStringArray(r.hint_themes)) {
    process.stderr.write(
      `[stock-news-skill-adapter] skip ${filename}: "hint_themes" must be string[]\n`,
    );
    return null;
  }

  return r as unknown as RawArticleJson;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
