/**
 * NewsSource adapter for **user-provided research reports**. Reads the same
 * schema-v1 JSON as `stock-news-skill-news-data.ts` from
 * `<brain_dir>/news-raw/<YYYY-MM-DD>/*.json`, but FILTERS to records whose
 * `source_name` starts with `user-research` or `internal-memo` — so
 * `gbrain jobs submit news-ingest --source user-research` cleanly handles
 * only research reports, not third-party news that lives in the same dir.
 *
 * See `docs/research-reports.md` for the user-facing contract; entries are
 * created by `scripts/ingest-research.ts` (markdown / txt → schema-v1 JSON).
 *
 * Beyond the prefix filter, the read / validate / dedup behaviour mirrors
 * the stock-news-skill adapter so the rest of the news pipeline (wikify,
 * fanout cap, disclaimer strip) Just Works.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NewsArticle, NewsSource, ResolveNewsOpts } from './news-data.ts';

const SCHEMA_VERSION = 1;
const ALLOW_PREFIXES = ['user-research', 'internal-memo'];

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
  raw_html?: string;
  fetched_at?: string;
}

function allowed(sourceName: string): boolean {
  return ALLOW_PREFIXES.some((p) => sourceName.startsWith(p));
}

export class UserResearchNewsSource implements NewsSource {
  readonly name = 'user-research';
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
        raw = JSON.parse(readFileSync(filePath, 'utf8')) as RawArticleJson;
      } catch (e) {
        process.stderr.write(`[user-research-adapter] skip ${entry}: ${(e as Error).message}\n`);
        continue;
      }

      const validated = validateRaw(raw, entry);
      if (!validated) continue;
      if (!allowed(validated.source_name)) continue; // not a research report

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

    articles.sort((a, b) => {
      const ta = a.published_at.localeCompare(b.published_at);
      if (ta !== 0) return ta;
      return a.id.localeCompare(b.id);
    });

    return articles;
  }
}

function validateRaw(raw: unknown, filename: string): RawArticleJson | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    process.stderr.write(`[user-research-adapter] skip ${filename}: not an object\n`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r.schema_version !== SCHEMA_VERSION) return null; // silently skip wrong schema (we share dir with news)
  const required: Array<keyof RawArticleJson> = ['article_id', 'source_name', 'published_at', 'title', 'body'];
  for (const k of required) {
    if (typeof r[k] !== 'string' || !r[k]) return null;
  }
  return r as unknown as RawArticleJson;
}
