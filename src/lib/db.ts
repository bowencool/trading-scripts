import { DatabaseSync } from "node:sqlite";
import type { AnalysisRecord } from "./types.js";

const SELECT_COLUMNS = `
  id, code, name, report_type, sentiment_score,
  operation_advice, trend_prediction, analysis_summary,
  ideal_buy, secondary_buy, stop_loss, take_profit, created_at`;

const BASE_CTE = `
  WITH ranked AS (
    SELECT
      id, code, name, report_type, sentiment_score,
      operation_advice, trend_prediction, analysis_summary,
      ideal_buy, secondary_buy, stop_loss, take_profit, created_at,
      ROW_NUMBER() OVER (PARTITION BY code ORDER BY created_at DESC) AS rn
    FROM analysis_history
    WHERE created_at >= datetime('now', '-12 hours')
      AND code NOT GLOB '[036][0-9][0-9][0-9][0-9][0-9]'`;

function queryWithExclusion(
  db: DatabaseSync,
  excludeRecordIds: number[],
  whereClause: string,
): AnalysisRecord[] {
  const placeholders = excludeRecordIds.map(() => "?").join(",");
  const excludeClause = excludeRecordIds.length > 0 ? `AND id NOT IN (${placeholders})` : "";

  const stmt = db.prepare(`
    ${BASE_CTE}
      ${whereClause}
      ${excludeClause}
  )
  SELECT ${SELECT_COLUMNS}
  FROM ranked WHERE rn = 1
  ORDER BY created_at DESC
`);
  return (excludeRecordIds.length > 0
    ? stmt.all(...excludeRecordIds)
    : stmt.all()) as unknown as AnalysisRecord[];
}

/**
 * Open DB once, run all queries, then close. This avoids repeated open/close cycles
 * when fetching buy signals, sell signals, and recent reports in sequence.
 */
export function queryAll(
  dbPath: string,
  excludeRecordIds: number[],
): {
  buySignals: AnalysisRecord[];
  sellSignals: AnalysisRecord[];
  recentReports: AnalysisRecord[];
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const buySignals = queryWithExclusion(
      db,
      excludeRecordIds,
      "AND operation_advice IN ('买入', '加仓')\n          AND ideal_buy IS NOT NULL",
    );
    const sellSignals = queryWithExclusion(
      db,
      excludeRecordIds,
      "AND operation_advice IN ('卖出', '减仓')\n          AND take_profit IS NOT NULL",
    );
    const recentReports = queryWithExclusion(db, [], "");
    return { buySignals, sellSignals, recentReports };
  } finally {
    db.close();
  }
}

/** Convenience wrapper for callers that only need recent reports. */
export function fetchRecentReports(dbPath: string): AnalysisRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return queryWithExclusion(db, [], "");
  } finally {
    db.close();
  }
}
