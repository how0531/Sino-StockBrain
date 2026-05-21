/**
 * `rss-news-fetch` job handler — the concrete, runnable implementation of
 * the stock-news-skill SENSE layer for RSS-based sources.
 *
 * Does real HTTP + real RSS parsing + writes schema-v1 JSON to
 * `<brain_dir>/news-raw/<date>/<source>-<id>.json` — exactly the contract
 * the StockNewsSkillNewsSource adapter consumes. So the full chain is:
 *
 *   rss-news-fetch  →  news-raw/*.json  →  (adapter)  →  news-ingest  →  news/*.md
 *
 * Two input modes:
 *   - `rss_url`:  fetch a live feed over HTTP (use on an open network).
 *   - `rss_file`: read a local XML file (offline dev / tests / recorded feeds).
 * Exactly one must be set.
 *
 * Why both modes: the source's own machine has open network to finance
 * feeds; CI / sandboxes don't. `rss_file` lets the exact same parsing +
 * write path be tested deterministically against a recorded feed.
 *
 * Trust model: NOT in PROTECTED_JOB_NAMES. HTTP GET + disk write only.
 * No LLM. The fetched content is upstream's voice — the compliance-filter
 * downstream gates anything client-facing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import {
  parseRss,
  pubDateToIso,
  pubDateToTaipeiDate,
  deriveArticleId,
  type RssItem,
} from '../../data-sources/rss-parse.ts';

const FETCH_TIMEOUT_MS = 20_000;
const SCHEMA_VERSION = 1;

export interface RssNewsFetchParams {
  brain_dir: string;
  /** Live RSS feed URL. Mutually exclusive with rss_file. */
  rss_url?: string;
  /** Local RSS XML file path. Mutually exclusive with rss_url. */
  rss_file?: string;
  /** Source label written into each article (cnyes, commercial-times, ...). */
  source_name: string;
  /** Optional date filter — only keep articles published on this TPE date. */
  date?: string;
}

export interface RssNewsFetchResult {
  status: 'ok' | 'skipped';
  reason?: string;
  source_name: string;
  items_parsed: number;
  files_written: number;
  files_skipped_existing: number;
  dates_touched: string[];
}

export async function rssNewsFetchHandler(
  ctx: MinionJobContext,
): Promise<RssNewsFetchResult> {
  const params = validateParams(ctx.data);

  // Load the XML — from URL (live) or file (offline).
  let xml: string;
  if (params.rss_url) {
    await ctx.log(`[rss-news-fetch] GET ${params.rss_url}`);
    xml = await fetchXml(params.rss_url, ctx.signal);
  } else {
    await ctx.log(`[rss-news-fetch] read file ${params.rss_file}`);
    xml = readFileSync(params.rss_file!, 'utf8');
  }

  const items = parseRss(xml);
  await ctx.log(`[rss-news-fetch] parsed ${items.length} items from ${params.source_name}`);

  let written = 0;
  let skipped = 0;
  const datesTouched = new Set<string>();

  for (const item of items) {
    if (ctx.signal.aborted) throw new Error('aborted');

    const tpeDate = pubDateToTaipeiDate(item.pubDate);
    // Optional date filter.
    if (params.date && tpeDate !== params.date) continue;

    const articleId = deriveArticleId(item);
    const dir = join(params.brain_dir, 'news-raw', tpeDate);
    mkdirSync(dir, { recursive: true });

    const fileName = `${params.source_name}-${articleId}.json`;
    const filePath = join(dir, fileName);

    // Idempotent: skip if already fetched.
    if (existsSync(filePath)) {
      skipped++;
      continue;
    }

    const json = buildSchemaV1(item, params.source_name, articleId);
    atomicWrite(filePath, json);
    written++;
    datesTouched.add(tpeDate);
  }

  await ctx.log(
    `[rss-news-fetch] wrote ${written}, skipped ${skipped} existing, ` +
    `dates=${[...datesTouched].join(',')}`,
  );

  return {
    status: 'ok',
    source_name: params.source_name,
    items_parsed: items.length,
    files_written: written,
    files_skipped_existing: skipped,
    dates_touched: [...datesTouched].sort(),
  };
}

// ===========================================================================
// helpers
// ===========================================================================

function buildSchemaV1(item: RssItem, sourceName: string, articleId: string): string {
  const record = {
    schema_version: SCHEMA_VERSION,
    article_id: articleId,
    source_name: sourceName,
    published_at: pubDateToIso(item.pubDate),
    title: item.title,
    body: item.description,
    url: item.link || undefined,
    fetched_at: new Date().toISOString(),
  };
  return JSON.stringify(record, null, 2) + '\n';
}

/** Atomic write: tmp file + rename, so a partial write never leaves a
 *  half-written JSON the adapter would choke on. */
function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

async function fetchXml(url: string, signal: AbortSignal): Promise<string> {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  const onAbort = () => timeoutCtrl.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      signal: timeoutCtrl.signal,
      headers: { 'User-Agent': 'sino-stockbrain/0.1 (+rss-news-fetch)' },
    });
    if (!res.ok) {
      throw new Error(`RSS fetch returned HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function validateParams(data: Record<string, unknown>): RssNewsFetchParams {
  if (typeof data.brain_dir !== 'string' || !data.brain_dir) {
    throw new UnrecoverableError('rss-news-fetch: missing required param "brain_dir"');
  }
  if (typeof data.source_name !== 'string' || !data.source_name) {
    throw new UnrecoverableError('rss-news-fetch: missing required param "source_name"');
  }
  if (!/^[a-z0-9_-]+$/.test(data.source_name)) {
    throw new UnrecoverableError(
      'rss-news-fetch: "source_name" must be [a-z0-9_-]+ (used in filenames)',
    );
  }
  const hasUrl = typeof data.rss_url === 'string' && data.rss_url;
  const hasFile = typeof data.rss_file === 'string' && data.rss_file;
  if (hasUrl === hasFile) {
    throw new UnrecoverableError(
      'rss-news-fetch: exactly one of "rss_url" or "rss_file" is required',
    );
  }
  if (hasUrl && !/^https?:\/\//.test(data.rss_url as string)) {
    throw new UnrecoverableError('rss-news-fetch: "rss_url" must be http(s)://');
  }
  if (data.date !== undefined && typeof data.date !== 'string') {
    throw new UnrecoverableError('rss-news-fetch: "date" must be a string');
  }
  return {
    brain_dir: data.brain_dir,
    rss_url: data.rss_url as string | undefined,
    rss_file: data.rss_file as string | undefined,
    source_name: data.source_name,
    date: data.date as string | undefined,
  };
}
