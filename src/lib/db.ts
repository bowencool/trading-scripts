import { DatabaseSync } from "node:sqlite";
import type { AnalysisRecord } from "./types.js";

export function fetchBuySignals(
  dbPath: string,
  excludeRecordIds: number[]
): AnalysisRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const excludeClause =
    excludeRecordIds.length > 0
      ? `AND id NOT IN (${excludeRecordIds.join(",")})`
      : "";

  const reports = db.prepare(`
    SELECT
      id, code, name, report_type, sentiment_score,
      operation_advice, trend_prediction, analysis_summary,
      ideal_buy, secondary_buy, stop_loss, take_profit, created_at
    FROM analysis_history
    WHERE created_at >= datetime('now', '-24 hours')
      AND operation_advice LIKE '%买入%'
      AND ideal_buy IS NOT NULL
      AND code NOT GLOB '[036][0-9][0-9][0-9][0-9][0-9]'
      ${excludeClause}
    ORDER BY created_at DESC
  `).all() as unknown as AnalysisRecord[];

  db.close();
  return reports;
}

export function fetchRecentReports(dbPath: string): AnalysisRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const reports = db.prepare(`
    SELECT
      id, code, name, report_type, sentiment_score,
      operation_advice, trend_prediction, analysis_summary,
      ideal_buy, secondary_buy, stop_loss, take_profit, created_at
    FROM analysis_history
    WHERE created_at >= datetime('now', '-24 hours')
      AND code NOT GLOB '[036][0-9][0-9][0-9][0-9][0-9]'
    ORDER BY created_at DESC
  `).all() as unknown as AnalysisRecord[];

  db.close();
  return reports;
}
