import { DatabaseSync } from "node:sqlite";
import type { AnalysisRecord } from "./types.js";

const COLUMNS = `id, code, name, report_type, sentiment_score,
  operation_advice, trend_prediction, analysis_summary,
  ideal_buy, secondary_buy, stop_loss, take_profit, created_at`;

const A_SHARE_RE = /^[036]\d+$/;
const BUY_ADVICE = new Set(["买入", "加仓"]);
const SELL_ADVICE = new Set(["卖出", "减仓"]);

// ── Raw fetch ─────────────────────────────────────────────────────────────────

/** Configurable time window (hours) for fetching records. Set via WINDOW_HOURS env var. */
export const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || "4");

/** Raw fetch: all analysis_history records from the last N hours, no filtering. */
function fetchRaw(dbPath: string): AnalysisRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT ${COLUMNS}
         FROM analysis_history
         WHERE created_at >= datetime('now', '-${WINDOW_HOURS} hours')
         ORDER BY created_at DESC`,
      )
      .all() as unknown as AnalysisRecord[];
  } finally {
    db.close();
  }
}

// ── In-memory filtering ───────────────────────────────────────────────────────

/** Keep only the latest record per code; exclude A-shares and submitted IDs. */
export function deduplicate(
  records: AnalysisRecord[],
  excludeIds: Set<number> = new Set(),
): AnalysisRecord[] {
  const seen = new Map<string, AnalysisRecord>();
  for (const r of records) {
    if (excludeIds.has(r.id)) continue;
    if (A_SHARE_RE.test(r.code)) continue;
    if (!seen.has(r.code)) seen.set(r.code, r);
  }
  return [...seen.values()];
}

export function filterBuySignals(records: AnalysisRecord[]): AnalysisRecord[] {
  return records.filter((r) => BUY_ADVICE.has(r.operation_advice ?? "") && r.ideal_buy != null);
}

export function filterSellSignals(records: AnalysisRecord[]): AnalysisRecord[] {
  return records.filter((r) => SELL_ADVICE.has(r.operation_advice ?? "") && r.take_profit != null);
}

/**
 * Risk/reward ratio: (take_profit - ideal_buy) / (ideal_buy - stop_loss).
 * Returns null when not computable (missing fields or non-positive risk).
 */
export function computeRiskReward(r: AnalysisRecord): number | null {
  if (r.ideal_buy == null || r.stop_loss == null || r.take_profit == null) return null;
  const risk = r.ideal_buy - r.stop_loss;
  if (risk <= 0) return null;
  return (r.take_profit - r.ideal_buy) / risk;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open DB once, fetch all records from last 4 hours, then apply in-memory
 * deduplication and filtering. Keeps SQL minimal — all business logic lives
 * in TypeScript so it's easy to iterate on signal rules.
 */
export function queryAll(
  dbPath: string,
  excludeRecordIds: Set<number>,
): {
  buySignals: AnalysisRecord[];
  sellSignals: AnalysisRecord[];
  recentReports: AnalysisRecord[];
} {
  const raw = fetchRaw(dbPath);
  const recentReports = deduplicate(raw);
  const filtered = deduplicate(raw, excludeRecordIds);
  return {
    buySignals: filterBuySignals(filtered),
    sellSignals: filterSellSignals(filtered),
    recentReports,
  };
}

/** Convenience wrapper for callers that only need recent reports. */
export function fetchRecentReports(dbPath: string): AnalysisRecord[] {
  return deduplicate(fetchRaw(dbPath));
}
