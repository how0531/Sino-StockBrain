/**
 * `news-ingest` job handler.
 *
 * Pulls finance news through the `NewsSource` adapter, runs `wikify()` over
 * each article body so naked company names become `[[tickers/XXXX]]`
 * wikilinks, and writes one markdown file per article under
 * `<brain_dir>/news/<YYYY-MM-DD>/<slug>.md`.
 *
 * Why this is the graph's secret weapon: once the article body is wikified,
 * `gbrain sync`'s auto-link extractor (link-extraction.ts) finds every
 * `[[tickers/2327]]` reference, writes a `mentions` edge from the news
 * page to the ticker page, and (if missing) creates the ticker page stub.
 * No LLM call, no schema migration, the network grows itself.
 *
 * Mock vs real: defaults to `source=mock`. When you connect a real RSS
 * feed (cnyes, commercial-times, vendor), add an adapter to
 * `src/core/data-sources/` and a case in `resolveNewsSource()`.
 *
 * LLM-assisted resolution (path-2): a `--params '{"rewriter":"llm"}'` flag
 * is reserved for the next iteration. Path-1 (deterministic alias map)
 * lands here. The alias map at `src/core/entities/ticker-aliases.ts`
 * covers ~95% of cases the demo needs.
 *
 * Trust model: NOT in PROTECTED_JOB_NAMES — no LLM cost yet, no RCE
 * surface (read-only adapter call + disk write inside brain_dir).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { NewsArticle } from '../../data-sources/news-data.ts';
import { resolveNewsSource } from '../../data-sources/news-data.ts';
import { wikify } from '../../entities/ticker-aliases.ts';

export interface NewsIngestParams {
  brain_dir: string;
  date?: string;
  source?: string;
  /** Reserved for next iteration: 'alias-map' (default) | 'llm'. */
  rewriter?: string;
}

export interface NewsIngestResult {
  status: 'ok' | 'skipped';
  reason?: string;
  date: string;
  source: string;
  rewriter: string;
  articles_fetched: number;
  articles_written: number;
  total_wikify_replacements: number;
  output_dir: string;
  /** Aggregate ticker → mention-count across all articles written this run.
   *  Useful for spot-checking the wikify pass and for downstream salience. */
  ticker_mentions: Record<string, number>;
}

export async function newsIngestHandler(
  ctx: MinionJobContext,
): Promise<NewsIngestResult> {
  const params = validateParams(ctx.data);
  const date = resolveDate(params.date ?? 'today');
  const sourceName = params.source ?? 'mock';
  const rewriter = params.rewriter ?? 'alias-map';

  if (rewriter !== 'alias-map') {
    // LLM rewriter not wired yet — reserved for next iteration. Fail loud
    // rather than silently running with a different code path.
    throw new UnrecoverableError(
      `news-ingest: rewriter "${rewriter}" not implemented yet. ` +
      `Use rewriter="alias-map" (default) or omit the param.`,
    );
  }

  const outputDir = join(params.brain_dir, 'news', date);
  mkdirSync(outputDir, { recursive: true });

  await ctx.log(
    `[news-ingest] source=${sourceName} date=${date} rewriter=${rewriter}`,
  );

  const newsSource = await resolveNewsSource(sourceName, {
    brain_dir: params.brain_dir,
  });
  const articles = await newsSource.getArticles(date);

  let written = 0;
  let totalReplacements = 0;
  const tickerMentions: Record<string, number> = {};

  for (const article of articles) {
    if (ctx.signal.aborted) throw new Error('aborted');

    const slug = articleSlug(article);
    const filePath = join(outputDir, `${slug}.md`);
    if (existsSync(filePath)) continue;

    const wikifiedTitle = wikify(article.title);
    const wikifiedBody = wikify(article.body);

    // Aggregate stats (title + body replacements together).
    totalReplacements += wikifiedTitle.stats.total_replacements;
    totalReplacements += wikifiedBody.stats.total_replacements;
    const matchedThisArticle = new Set<string>();
    for (const [ticker, count] of wikifiedTitle.stats.matched) {
      tickerMentions[ticker] = (tickerMentions[ticker] ?? 0) + count;
      matchedThisArticle.add(ticker);
    }
    for (const [ticker, count] of wikifiedBody.stats.matched) {
      tickerMentions[ticker] = (tickerMentions[ticker] ?? 0) + count;
      matchedThisArticle.add(ticker);
    }

    // The source's hint_tickers (e.g. stock-news-skill's ground-truth code
    // tagging) are authoritative — far more reliable than fuzzy body matching,
    // and they cover names the alias map doesn't. Turn them into BODY
    // wikilinks so the auto-link extractor builds edges (frontmatter lists do
    // NOT create edges), and count them toward mention stats. Skip codes the
    // body/title wikify already linked so we don't double-count or double-link.
    const hintSlugs: string[] = [];
    for (const raw of article.hint_tickers ?? []) {
      const slug = raw.trim().toLowerCase();
      if (!slug || !/^[a-z0-9]+$/.test(slug)) continue;
      if (matchedThisArticle.has(slug) || hintSlugs.includes(slug)) continue;
      hintSlugs.push(slug);
      tickerMentions[slug] = (tickerMentions[slug] ?? 0) + 1;
    }
    let bodyOut = wikifiedBody.text;
    if (hintSlugs.length > 0) {
      bodyOut +=
        '\n\n相關個股：' + hintSlugs.map((s) => `[[tickers/${s}]]`).join(' ');
    }

    writeFileSync(
      filePath,
      renderArticleMarkdown(article, wikifiedTitle.text, bodyOut, date),
      'utf8',
    );
    written++;
  }

  // Per-day summary — Top mentioned tickers for the day.
  const summaryPath = join(outputDir, '_summary.md');
  writeFileSync(
    summaryPath,
    renderSummary(articles, written, tickerMentions, date, sourceName),
    'utf8',
  );

  await ctx.log(
    `[news-ingest] wrote ${written}/${articles.length} articles, ` +
    `${totalReplacements} wikify replacements across ` +
    `${Object.keys(tickerMentions).length} unique tickers`,
  );

  return {
    status: 'ok',
    date,
    source: sourceName,
    rewriter,
    articles_fetched: articles.length,
    articles_written: written,
    total_wikify_replacements: totalReplacements,
    output_dir: outputDir,
    ticker_mentions: tickerMentions,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validateParams(data: Record<string, unknown>): NewsIngestParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError('news-ingest: missing required param "brain_dir"');
  }
  if (data.date !== undefined && typeof data.date !== 'string') {
    throw new UnrecoverableError('news-ingest: "date" must be a string');
  }
  if (data.source !== undefined && typeof data.source !== 'string') {
    throw new UnrecoverableError('news-ingest: "source" must be a string');
  }
  if (data.rewriter !== undefined && typeof data.rewriter !== 'string') {
    throw new UnrecoverableError('news-ingest: "rewriter" must be a string');
  }
  return {
    brain_dir: data.brain_dir,
    date: data.date as string | undefined,
    source: data.source as string | undefined,
    rewriter: data.rewriter as string | undefined,
  };
}

function resolveDate(input: string): string {
  if (input === 'today') {
    const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const y = tw.getFullYear();
    const m = String(tw.getMonth() + 1).padStart(2, '0');
    const d = String(tw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new UnrecoverableError(`news-ingest: invalid date "${input}"`);
  }
  return input;
}

/** Stable, filesystem-safe slug from article id. Mock ids are already safe. */
function articleSlug(article: NewsArticle): string {
  return article.id.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function renderArticleMarkdown(
  article: NewsArticle,
  wikifiedTitle: string,
  wikifiedBody: string,
  date: string,
): string {
  return `---
type: news_article
slug: news/${date}/${articleSlug(article)}
article_id: "${article.id}"
source: ${article.source}
published_at: ${article.published_at}
url: ${article.url ?? ''}
hint_tickers: ${formatYamlList(article.hint_tickers)}
hint_themes: ${formatYamlList(article.hint_themes)}
---

# ${wikifiedTitle}

${wikifiedBody}
`;
}

function renderSummary(
  articles: NewsArticle[],
  written: number,
  tickerMentions: Record<string, number>,
  date: string,
  sourceName: string,
): string {
  const ranked = Object.entries(tickerMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const mentionLines = ranked
    .map(([t, n]) => `- [[tickers/${t}]] — 提及 ${n} 次`)
    .join('\n');

  const articleLines = articles
    .map((a) => `- [[news/${date}/${articleSlug(a)}]] ${a.title}`)
    .join('\n');

  return `---
type: news_summary
slug: news/${date}/_summary
date: ${date}
source: ${sourceName}
articles_fetched: ${articles.length}
articles_written: ${written}
unique_tickers_mentioned: ${Object.keys(tickerMentions).length}
---

# 新聞 Summary — ${date}

- 抓取文章數：${articles.length}
- 寫入：${written}
- 涉及個股數：${Object.keys(tickerMentions).length}

## Top 提及個股

${mentionLines || '(empty)'}

## Articles

${articleLines || '(empty)'}
`;
}

function formatYamlList(items?: string[]): string {
  if (!items || items.length === 0) return '[]';
  return '[' + items.map((s) => `"${s}"`).join(', ') + ']';
}
