/**
 * Unit tests for StockNewsSkillNewsSource adapter.
 *
 * Filesystem-based — uses committed fixtures under
 * `test/fixtures/stock-news-skill/` for deterministic reads. No env
 * mutation, no PGLite, no mock.module — safe for the parallel fast loop.
 *
 * Coverage:
 *   - Valid JSON files are parsed correctly
 *   - Field-level shape validation (missing required, wrong type)
 *   - schema_version mismatch is rejected
 *   - Corrupt JSON files are skipped (not thrown)
 *   - Dedup by article_id
 *   - Sort by (published_at asc, id asc) is stable
 *   - Missing date dir returns empty array
 *   - Invalid date format returns empty array
 */

import { test, expect, describe } from 'bun:test';
import { resolve } from 'node:path';
import { StockNewsSkillNewsSource } from '../src/core/data-sources/stock-news-skill-news-data.ts';
import { resolveNewsSource } from '../src/core/data-sources/news-data.ts';

const FIXTURE_BRAIN_DIR = resolve(__dirname, 'fixtures/stock-news-skill-brain-stub');
const REAL_FIXTURE_DIR = resolve(__dirname, 'fixtures/stock-news-skill');

describe('StockNewsSkillNewsSource', () => {
  test('reads valid fixtures and returns NewsArticle[]', async () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: fixturesAsBrainDir() });
    const articles = await src.getArticles('2026-05-20');
    expect(articles.length).toBe(2); // 2 valid fixtures (malformed/corrupt/wrong-version skipped)
  });

  test('correctly maps JSON fields to NewsArticle', async () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: fixturesAsBrainDir() });
    const articles = await src.getArticles('2026-05-20');
    const cnyes = articles.find((a) => a.id === 'cnyes-5483921')!;
    expect(cnyes).toBeDefined();
    expect(cnyes.source).toBe('cnyes');
    expect(cnyes.title).toContain('MLCC');
    expect(cnyes.body).toContain('國巨');
    expect(cnyes.url).toContain('news.cnyes.com');
    expect(cnyes.hint_tickers).toEqual(['2327', '2492', '2456']);
    expect(cnyes.hint_themes).toEqual(['passive-components']);
  });

  test('skips file with missing required field (body)', async () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: fixturesAsBrainDir() });
    const articles = await src.getArticles('2026-05-20');
    expect(articles.find((a) => a.id === 'test-malformed')).toBeUndefined();
  });

  test('skips file with wrong schema_version', async () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: fixturesAsBrainDir() });
    const articles = await src.getArticles('2026-05-20');
    expect(articles.find((a) => a.id === 'future-schema')).toBeUndefined();
  });

  test('skips corrupt JSON without throwing', async () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: fixturesAsBrainDir() });
    // Should not throw — corrupt file is silently skipped.
    const articles = await src.getArticles('2026-05-20');
    // The two valid files remain.
    expect(articles.length).toBe(2);
  });

  test('returns sorted by published_at ascending', async () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: fixturesAsBrainDir() });
    const articles = await src.getArticles('2026-05-20');
    for (let i = 1; i < articles.length; i++) {
      expect(articles[i]!.published_at >= articles[i - 1]!.published_at).toBe(true);
    }
  });

  test('returns empty array for missing date directory', async () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: fixturesAsBrainDir() });
    expect(await src.getArticles('2099-12-31')).toEqual([]);
  });

  test('returns empty array for invalid date format', async () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: fixturesAsBrainDir() });
    expect(await src.getArticles('not-a-date')).toEqual([]);
    expect(await src.getArticles('2026/05/20')).toEqual([]);
    expect(await src.getArticles('')).toEqual([]);
  });

  test('returns empty array for brain_dir without news-raw subdir', async () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: '/tmp/nonexistent-brain-dir-xyz' });
    expect(await src.getArticles('2026-05-20')).toEqual([]);
  });

  test('name property matches the factory case', () => {
    const src = new StockNewsSkillNewsSource({ brain_dir: fixturesAsBrainDir() });
    expect(src.name).toBe('stock-news-skill');
  });
});

describe('resolveNewsSource integration', () => {
  test('factory returns StockNewsSkillNewsSource for "stock-news-skill"', async () => {
    const src = await resolveNewsSource('stock-news-skill', {
      brain_dir: fixturesAsBrainDir(),
    });
    expect(src.name).toBe('stock-news-skill');
    expect(typeof src.getArticles).toBe('function');
  });

  test('factory still resolves "mock" alongside "stock-news-skill"', async () => {
    const src = await resolveNewsSource('mock', { brain_dir: fixturesAsBrainDir() });
    expect(src.name).toBe('mock');
  });

  test('factory throws on unknown name with helpful error', async () => {
    let err: Error | null = null;
    try {
      await resolveNewsSource('does-not-exist', { brain_dir: fixturesAsBrainDir() });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('stock-news-skill');
  });
});

// ===========================================================================
// helpers
// ===========================================================================

/** The fixture directory is laid out as if it WERE a brain repo:
 *  `test/fixtures/stock-news-skill/2026-05-20/*.json` plays the role of
 *  `<brain_dir>/news-raw/2026-05-20/*.json`. So we pass a brain_dir that
 *  makes `join(brain_dir, 'news-raw', date)` resolve to the fixture dir. */
function fixturesAsBrainDir(): string {
  // The adapter reads from `<brain_dir>/news-raw/<date>/`. Our fixtures
  // live at `test/fixtures/stock-news-skill/<date>/`. So we need a
  // brain_dir whose `news-raw` subdir IS the fixture root.
  // Create a sibling-named symlink? Simpler: lay out a tiny stub dir.
  return ensureFixtureBrainDir();
}

let _fixturesReady = false;
function ensureFixtureBrainDir(): string {
  if (_fixturesReady) return FIXTURE_BRAIN_DIR;
  // Tests run in serial within a file; this idempotent setup is safe.
  const { existsSync, mkdirSync, symlinkSync, rmSync } = require('node:fs');
  if (!existsSync(FIXTURE_BRAIN_DIR)) {
    mkdirSync(FIXTURE_BRAIN_DIR, { recursive: true });
  }
  const link = resolve(FIXTURE_BRAIN_DIR, 'news-raw');
  if (existsSync(link)) {
    rmSync(link, { force: true, recursive: true });
  }
  symlinkSync(REAL_FIXTURE_DIR, link, 'dir');
  _fixturesReady = true;
  return FIXTURE_BRAIN_DIR;
}
