import { DatabaseSync } from "node:sqlite";
import type { AnalysisRecord } from "./types.js";

export function fetchBuySignals(dbPath: string, excludeRecordIds: number[]): AnalysisRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const placeholders = excludeRecordIds.map(() => "?").join(",");
    const excludeClause = excludeRecordIds.length > 0 ? `AND id NOT IN (${placeholders})` : "";

    const stmt = db.prepare(`
      WITH ranked AS (
        SELECT
          id, code, name, report_type, sentiment_score,
          operation_advice, trend_prediction, analysis_summary,
          ideal_buy, secondary_buy, stop_loss, take_profit, created_at,
          ROW_NUMBER() OVER (PARTITION BY code ORDER BY created_at DESC) AS rn
        FROM analysis_history
        WHERE created_at >= datetime('now', '-12 hours')
          AND (operation_advice LIKE '%买入%' OR operation_advice LIKE '%加仓%')
          AND ideal_buy IS NOT NULL
          AND code NOT GLOB '[036][0-9][0-9][0-9][0-9][0-9]'
          ${excludeClause}
      )
      SELECT id, code, name, report_type, sentiment_score,
             operation_advice, trend_prediction, analysis_summary,
             ideal_buy, secondary_buy, stop_loss, take_profit, created_at
      FROM ranked WHERE rn = 1
      ORDER BY created_at DESC
    `);
    return (excludeRecordIds.length > 0
      ? stmt.all(...excludeRecordIds)
      : stmt.all()) as unknown as AnalysisRecord[];
  } finally {
    db.close();
  }
}

export function fetchSellSignals(dbPath: string, excludeRecordIds: number[]): AnalysisRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const placeholders = excludeRecordIds.map(() => "?").join(",");
    const excludeClause = excludeRecordIds.length > 0 ? `AND id NOT IN (${placeholders})` : "";

    const stmt = db.prepare(`
      WITH ranked AS (
        SELECT
          id, code, name, report_type, sentiment_score,
          operation_advice, trend_prediction, analysis_summary,
          ideal_buy, secondary_buy, stop_loss, take_profit, created_at,
          ROW_NUMBER() OVER (PARTITION BY code ORDER BY created_at DESC) AS rn
        FROM analysis_history
        WHERE created_at >= datetime('now', '-12 hours')
          AND (operation_advice LIKE '%卖出%' OR operation_advice LIKE '%减仓%')
          AND take_profit IS NOT NULL
          AND code NOT GLOB '[036][0-9][0-9][0-9][0-9][0-9]'
          ${excludeClause}
      )
      SELECT id, code, name, report_type, sentiment_score,
             operation_advice, trend_prediction, analysis_summary,
             ideal_buy, secondary_buy, stop_loss, take_profit, created_at
      FROM ranked WHERE rn = 1
      ORDER BY created_at DESC
    `);
    return (excludeRecordIds.length > 0
      ? stmt.all(...excludeRecordIds)
      : stmt.all()) as unknown as AnalysisRecord[];
  } finally {
    db.close();
  }
}

export function fetchRecentReports(dbPath: string): AnalysisRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(`
      WITH ranked AS (
        SELECT
          id, code, name, report_type, sentiment_score,
          operation_advice, trend_prediction, analysis_summary,
          ideal_buy, secondary_buy, stop_loss, take_profit, created_at,
          ROW_NUMBER() OVER (PARTITION BY code ORDER BY created_at DESC) AS rn
        FROM analysis_history
        WHERE created_at >= datetime('now', '-12 hours')
          AND code NOT GLOB '[036][0-9][0-9][0-9][0-9][0-9]'
      )
      SELECT id, code, name, report_type, sentiment_score,
             operation_advice, trend_prediction, analysis_summary,
             ideal_buy, secondary_buy, stop_loss, take_profit, created_at
      FROM ranked WHERE rn = 1
      ORDER BY created_at DESC
    `)
      .all() as unknown as AnalysisRecord[];
  } finally {
    db.close();
  }
}
