/**
 * Compliance rubric — single source of truth for what passes / fails.
 *
 * Designed for Taiwan retail-facing investment commentary, which is the
 * tightest regulatory bar in scope (TWSE / 金管會 has explicit rules against
 * individual-stock buy/sell recommendations by non-licensed actors). The
 * institutional bar can use a relaxed variant (see `RELAXED_RUBRIC`).
 *
 * Two layers of checks reference this file:
 *   - deterministic-pass.ts: regex against `BANNED_PATTERNS` + `MUST_HAVE_CITATIONS`
 *   - llm-judge.ts: passes this rubric to an LLM judge as the prompt body
 *
 * Edits here propagate to both layers — keep additions explicit (one entry
 * per real-world failure mode you've seen).
 */

export type ViolationType =
  | 'buy_sell_recommendation'
  | 'should_action'
  | 'future_prediction_unsourced'
  | 'target_price_uncited'
  | 'absolute_certainty'
  | 'personalized_advice'
  | 'forbidden_phrase'
  | 'missing_disclaimer';

export type Severity = 'critical' | 'warning' | 'info';

export interface Violation {
  type: ViolationType;
  severity: Severity;
  /** Verbatim text that triggered the violation. */
  quote: string;
  /** Section / paragraph hint (best-effort). */
  location?: string;
  /** Concrete rewrite the analyst can paste in. */
  suggested_rewrite?: string;
  /** Which layer caught it. */
  caught_by: 'deterministic' | 'llm';
}

export type Verdict = 'pass' | 'review' | 'fail';

export interface ComplianceVerdict {
  verdict: Verdict;
  violations: Violation[];
  layer1_violations: number;
  layer2_violations: number;
  llm_available: boolean;
  llm_confidence?: number;
  /** SHA-256 of the digest content, for audit trail dedup. */
  digest_hash: string;
}

/** Deterministic-pass patterns. Each entry is one regex + classification.
 *  Ordering: critical first. Severity drives the verdict aggregator. */
export interface BannedPattern {
  type: ViolationType;
  severity: Severity;
  pattern: RegExp;
  suggested_rewrite: string;
}

export const BANNED_PATTERNS: BannedPattern[] = [
  // --- buy/sell recommendations (CRITICAL — TWSE rule violation) ---
  {
    type: 'buy_sell_recommendation',
    severity: 'critical',
    pattern: /建議\s*(買進|賣出|加碼|減碼|逢低|逢高)/g,
    suggested_rewrite: '改寫為事實描述，例：「外資連 3 日買超」、「成交量為 30 日均量 5 倍」',
  },
  {
    type: 'buy_sell_recommendation',
    severity: 'critical',
    pattern: /(可)?(買進|賣出|放空|做多|做空|加碼|減碼|攤平)/g,
    suggested_rewrite: '改用客觀觀察：「市場呈現淨買 / 淨賣」、「機構部位調整」',
  },
  {
    type: 'buy_sell_recommendation',
    severity: 'critical',
    pattern: /適合\s*(進場|介入|布局|出場)/g,
    suggested_rewrite: '刪除主觀判斷，僅敘述事件 / 數據',
  },

  // --- prescriptive personalization ---
  {
    type: 'personalized_advice',
    severity: 'critical',
    pattern: /您?應該?\s*(買|賣|持有|觀望|加碼|減碼)/g,
    suggested_rewrite: '不對特定使用者下指令；改為一般市場觀察',
  },
  {
    type: 'should_action',
    severity: 'warning',
    pattern: /(您|投資人)?(可考慮|可關注|宜留意|宜觀察)/g,
    suggested_rewrite: '改為「值得追蹤的事件」中性敘事',
  },

  // --- absolute certainty (no future is certain) ---
  {
    type: 'absolute_certainty',
    severity: 'warning',
    pattern: /(肯定|必定|絕對|保證|穩賺)/g,
    suggested_rewrite: '刪除絕對化用詞，改用「可能」、「研究機構預期」+ 引用 source',
  },

  // --- future predictions (warning — requires citation) ---
  {
    type: 'future_prediction_unsourced',
    severity: 'warning',
    pattern: /(將|可望|預計)\s*(漲|跌|破|攻)/g,
    suggested_rewrite: '改為條件敘事「若 Q1 毛利率符合指引，可預期…」或引用 [[analyst-notes/...]] 來源',
  },

  // --- price targets without analyst-notes citation ---
  // Note: this is a coarse pre-screen. The LLM judge does the proper
  // "is the target cited" check (sees full sentence context).
  {
    type: 'target_price_uncited',
    severity: 'warning',
    pattern: /目標價\s*(?:NT\$|新台幣|US\$|\$|（[^）]+）)?\s*\d/g,
    suggested_rewrite: '若引用賣方目標價，必須帶 [[analyst-notes/<date>-<ticker>-<broker>]] 連結',
  },
];

/** Phrases that, if present, are HIGH evidence of compliance attention.
 *  E.g. proper hedging language. Useful for confidence scoring. */
export const SAFE_FRAMINGS: RegExp[] = [
  /外資連\s*\d+\s*[日天]\s*(買|賣)超/,
  /成交量為.*?(均量|中位).*?(倍|x|×)/,
  /(法說|釋出|公告).+(指引|資料|數據)/,
  /若.+，可預期/,
  /分析師目標價.+(上修|下修).+\[\[analyst-notes/,
];

/** Phrases REQUIRED on any client-prep output. Missing = warning. */
export const REQUIRED_DISCLAIMER_HINTS: RegExp[] = [
  /本文.*(資訊|參考).*不構成.*(投資|買賣).*建議/,
];

/** The rubric body passed to the LLM judge prompt. Kept human-readable
 *  because it doubles as the spec analysts read. */
export const RUBRIC_TEXT_ZH = `
# 合規審查規則（台灣散戶投資資訊）

## 嚴格禁止（critical — 一條即不通過）

1. **個股買賣建議**：「建議買進」、「建議賣出」、「應加碼」、「適合進場」、「可放空」
2. **個人化指令**：「您應該」、「建議您」、「投資人應」
3. **絕對化用詞**：「肯定會」、「必定」、「保證」、「穩賺」

## 需要 source 才可使用（warning — 改寫或補引用即可）

4. **目標價**：必須帶 \`[[analyst-notes/<date>-<ticker>-<broker>]]\` 連結
5. **未來預測**：「將漲」、「可望突破」需引用 source 或改寫為條件式
6. **評等變動**：「上修評等」需引用研報來源

## 可接受框架（不會被擋）

- 過去式事實：「外資連 3 日買超」、「成交量為 30 日均量 5 倍」
- 已引用目標價：「目標價自 X 上修至 Y（見 [[analyst-notes/...]]）」
- 中性事件預告：「下週法說會將揭露 Q1 毛利率指引」
- 條件式：「若 Q1 毛利率符合指引，可預期…」

## 輸出契約

返回 JSON only，不要有任何前後文字。schema：

\`\`\`json
{
  "verdict": "pass" | "review" | "fail",
  "violations": [
    {
      "type": "buy_sell_recommendation" | "should_action" | "future_prediction_unsourced" |
              "target_price_uncited" | "absolute_certainty" | "personalized_advice" |
              "forbidden_phrase" | "missing_disclaimer",
      "severity": "critical" | "warning" | "info",
      "quote": "<verbatim 違規句子>",
      "location": "<段落或標題提示>",
      "suggested_rewrite": "<具體改寫建議>"
    }
  ],
  "confidence": <0.0-1.0>
}
\`\`\`

決策邏輯：
- 任一 critical violation → verdict = "fail"
- 只有 warning / info → verdict = "review"
- 全部清淨 → verdict = "pass"
`.trim();
