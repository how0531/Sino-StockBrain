/**
 * Compliance Layer 1 — deterministic regex pass.
 *
 * Why a separate layer (not just LLM): regex catches the most-common
 * violation patterns at sub-millisecond cost with zero LLM dependency.
 * In normal operation 80%+ of fails are caught here BEFORE we burn a
 * Sonnet call. When the LLM isn't available (no API key, network down),
 * this layer alone produces a usable verdict.
 *
 * Pure function — exported standalone so tests don't need a handler stub
 * or a mocked gateway.
 */

import type { Violation } from './rubric.ts';
import { BANNED_PATTERNS } from './rubric.ts';

/** Run the deterministic regex pass over the digest text.
 *
 *  Each `BANNED_PATTERNS` entry is scanned with its own RegExp (`g` flag).
 *  We track unique matches per pattern so the same offending sentence
 *  doesn't produce ten near-duplicate violations.
 *
 *  Returns matches in document order — analysts read top-to-bottom. */
export function runDeterministicPass(digestText: string): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>(); // dedup key: `${type}:${quote}`

  for (const rule of BANNED_PATTERNS) {
    // Clone the regex so we don't share lastIndex state across calls.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(digestText)) !== null) {
      const quote = extractQuoteContext(digestText, m.index, m[0].length);
      const key = `${rule.type}:${quote}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        type: rule.type,
        severity: rule.severity,
        quote,
        location: locateSection(digestText, m.index),
        suggested_rewrite: rule.suggested_rewrite,
        caught_by: 'deterministic',
      });
    }
  }

  // Document-order sort (regex iteration may interleave). Use the first
  // occurrence of each quote as the anchor.
  return out.sort((a, b) => {
    const ia = digestText.indexOf(a.quote);
    const ib = digestText.indexOf(b.quote);
    return ia - ib;
  });
}

/** Return the full sentence (between Chinese period 。 / newline / .) that
 *  contains the match. Helps the suggested_rewrite be paste-ready. */
function extractQuoteContext(text: string, matchStart: number, matchLen: number): string {
  // Look backward for sentence boundary.
  let start = matchStart;
  while (start > 0) {
    const c = text[start - 1];
    if (c === '\n' || c === '。' || c === '！' || c === '？' || c === '.') break;
    start--;
  }
  // Look forward.
  let end = matchStart + matchLen;
  while (end < text.length) {
    const c = text[end];
    if (c === '\n' || c === '。' || c === '！' || c === '？') {
      end++;
      break;
    }
    end++;
  }
  return text.slice(start, end).trim();
}

/** Best-effort: which `## Section` heading does this offset live under?
 *  Returns the trimmed heading text or "(unsection'd)". */
function locateSection(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const m = before.match(/(?:^|\n)(#{1,6})\s+([^\n]+)(?!.*\n#{1,6})/s);
  if (!m) return "(unsection'd)";
  // Find the LAST heading before offset.
  let last = "(unsection'd)";
  const re = /(?:^|\n)(#{1,6})\s+([^\n]+)/g;
  let h: RegExpExecArray | null;
  while ((h = re.exec(before)) !== null) {
    last = h[2]!.trim();
  }
  return last;
}
