import { DatabaseSync } from "node:sqlite";
import type { AnalysisAction, AnalysisRecord } from "./types.js";

const BASE_COLUMNS = `id, code, name, report_type, sentiment_score,
  operation_advice, trend_prediction, analysis_summary,
  ideal_buy, secondary_buy, stop_loss, take_profit, created_at`;

const TREND_BUY = new Set(["看多", "强烈看多"]);
const TREND_SELL = new Set(["看空", "强烈看空"]);
const TREND_OVERRIDABLE_ADVICE = new Set(["", "持有", "观望"]);
const STRUCTURED_ACTIONS = new Set<AnalysisAction>([
  "buy",
  "add",
  "reduce",
  "sell",
  "hold",
  "watch",
  "avoid",
  "alert",
]);
const BUY_ACTIONS = new Set<AnalysisAction>(["buy", "add"]);
const SELL_ACTIONS = new Set<AnalysisAction>(["reduce", "sell"]);

const A_SHARE_RE = /^[036]\d+$/;

// ── 时间窗口 ──────────────────────────────────────────────────────────────

/** 主信号窗口 (小时)。通过 WINDOW_HOURS 环境变量设置 */
export const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || "4");

/** 用于止损/止盈恢复的扩展窗口 */
const SLTP_WINDOW_HOURS = 24;

// ── 原始获取 ──────────────────────────────────────────────────────────────

type RawAnalysisRecord = Omit<AnalysisRecord, "action">;

function fetchRaw(dbPath: string, hours: number): RawAnalysisRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT ${selectColumns(db)}
         FROM analysis_history
         WHERE created_at >= datetime('now', '-${hours} hours')
         ORDER BY created_at DESC`,
      )
      .all() as unknown as RawAnalysisRecord[];
  } finally {
    db.close();
  }
}

/**
 * Fetch the most recent record with stop_loss/take_profit for a given symbol.
 * Searches without time window limit — for long-held positions.
 */
function fetchLatestSlTpRecord(dbPath: string, code: string): AnalysisRecord | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT ${selectColumns(db)}
         FROM analysis_history
         WHERE code = ? AND (stop_loss IS NOT NULL OR take_profit IS NOT NULL)
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .all(code) as unknown as RawAnalysisRecord[];
    return rows.length > 0 ? normalizeRecord(rows[0]) : null;
  } finally {
    db.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === columnName);
}

function selectColumns(db: DatabaseSync): string {
  const rawResultColumn = tableHasColumn(db, "analysis_history", "raw_result")
    ? "raw_result"
    : "NULL AS raw_result";
  return `${BASE_COLUMNS}, ${rawResultColumn}`;
}

function parseStructuredAction(rawResult: string | null): AnalysisAction | null {
  if (!rawResult) return null;

  try {
    const parsed = JSON.parse(rawResult) as { action?: unknown };
    if (typeof parsed.action !== "string") return null;
    const action = parsed.action.trim().toLowerCase();
    return STRUCTURED_ACTIONS.has(action as AnalysisAction) ? (action as AnalysisAction) : null;
  } catch {
    return null;
  }
}

function parseLegacyAction(record: RawAnalysisRecord): AnalysisAction | null {
  const advice = record.operation_advice ?? "";
  const trend = record.trend_prediction ?? "";

  if (advice === "买入") return "buy";
  if (advice === "加仓") return "add";
  if (advice === "减仓") return "reduce";
  if (advice === "卖出") return "sell";
  if (TREND_OVERRIDABLE_ADVICE.has(advice)) {
    if (TREND_BUY.has(trend)) return "buy";
    if (TREND_SELL.has(trend)) return "sell";
  }
  if (advice === "持有") return "hold";
  if (advice === "观望") return "watch";
  return null;
}

function normalizeRecord(record: RawAnalysisRecord): AnalysisRecord {
  return {
    ...record,
    action: parseStructuredAction(record.raw_result) ?? parseLegacyAction(record),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch all records from the main window, deduplicate by code (keep latest),
 * and split into buy/sell signals. No excludeRecordIds — dedup is now based
 * on portfolio comparison.
 */
export function queryAll(dbPath: string): {
  buySignals: AnalysisRecord[];
  sellSignals: AnalysisRecord[];
  recentReports: AnalysisRecord[];
} {
  const raw = fetchRaw(dbPath, WINDOW_HOURS);
  const recentSeen = new Map<string, AnalysisRecord>();
  const tradeSeen = new Map<string, AnalysisRecord>();
  const buySignals: AnalysisRecord[] = [];
  const sellSignals: AnalysisRecord[] = [];

  for (const rawRecord of raw) {
    const record = normalizeRecord(rawRecord);
    // Build recent reports list (all symbols except A-shares)
    if (!A_SHARE_RE.test(record.code) && !recentSeen.has(record.code)) {
      recentSeen.set(record.code, record);
    }

    if (A_SHARE_RE.test(record.code)) {
      continue;
    }

    if (tradeSeen.has(record.code)) {
      continue;
    }

    tradeSeen.set(record.code, record);

    const action = record.action;
    if (action) {
      if (BUY_ACTIONS.has(action)) {
        if (record.ideal_buy == null) {
          continue;
        }
        buySignals.push(record);
        continue;
      }

      if (SELL_ACTIONS.has(action)) {
        sellSignals.push(record);
      }
    }
  }

  return {
    buySignals,
    sellSignals,
    recentReports: [...recentSeen.values()],
  };
}

/**
 * Fetch a single record by its primary key id.
 */
export function queryRecordById(dbPath: string, id: number): AnalysisRecord | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(`SELECT ${selectColumns(db)} FROM analysis_history WHERE id = ?`)
      .all(id) as unknown as RawAnalysisRecord[];
    return rows.length > 0 ? normalizeRecord(rows[0]) : null;
  } finally {
    db.close();
  }
}

/**
 * SL/TP lookup for a given symbol. Uses a 24h window first,
 * then falls back to the most recent record with SL/TP (no time limit).
 */
export function querySlTpRecord(dbPath: string, code: string): AnalysisRecord | null {
  // 1. Try 24h window
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT ${selectColumns(db)}
         FROM analysis_history
         WHERE code = ?
           AND created_at >= datetime('now', '-${SLTP_WINDOW_HOURS} hours')
           AND (stop_loss IS NOT NULL OR take_profit IS NOT NULL)
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .all(code) as unknown as RawAnalysisRecord[];
    if (rows.length > 0) return normalizeRecord(rows[0]);
  } finally {
    db.close();
  }

  // 2. Fallback: most recent record with SL/TP (no time limit)
  return fetchLatestSlTpRecord(dbPath, code);
}
