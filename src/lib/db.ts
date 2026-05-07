import { DatabaseSync } from "node:sqlite";
import type { AnalysisRecord } from "./types.js";

const COLUMNS = `id, code, name, report_type, sentiment_score,
  operation_advice, trend_prediction, analysis_summary,
  ideal_buy, secondary_buy, stop_loss, take_profit, created_at`;

const A_SHARE_RE = /^[036]\d+$/;
const BUY_ADVICE = new Set(["买入", "加仓"]);
const SELL_ADVICE = new Set(["卖出", "减仓"]);

function formatRecord(record: AnalysisRecord): string {
  return `${record.created_at} #${record.id} [${record.code}] ${record.name ?? "未知"}`;
}

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
  const recentSeen = new Map<string, AnalysisRecord>();
  const tradeSeen = new Map<string, AnalysisRecord>();
  const buySignals: AnalysisRecord[] = [];
  const sellSignals: AnalysisRecord[] = [];

  for (const record of raw) {
    if (!A_SHARE_RE.test(record.code) && !recentSeen.has(record.code)) {
      recentSeen.set(record.code, record);
    }

    if (excludeRecordIds.has(record.id)) {
      console.log(`[跳过] ${formatRecord(record)} -> 已下单`);
      continue;
    }

    if (A_SHARE_RE.test(record.code)) {
      console.log(`[跳过] ${formatRecord(record)} -> 暂不支持 A 股交易`);
      continue;
    }

    if (tradeSeen.has(record.code)) {
      const kept = tradeSeen.get(record.code);
      console.log(`[跳过] ${formatRecord(record)} -> 已被更新报告#${kept?.id}覆盖`);
      continue;
    }

    tradeSeen.set(record.code, record);

    const advice = record.operation_advice ?? "";

    if (BUY_ADVICE.has(advice)) {
      if (record.ideal_buy == null) {
        console.log(`[跳过] ${formatRecord(record)} -> 买入/加仓但缺少 ideal_buy`);
        continue;
      }
      buySignals.push(record);
      continue;
    }

    if (SELL_ADVICE.has(advice)) {
      if (record.take_profit == null) {
        console.log(`[跳过] ${formatRecord(record)} -> 卖出/减仓但缺少 take_profit`);
        continue;
      }
      sellSignals.push(record);
      continue;
    }

    console.log(`[跳过] ${formatRecord(record)} -> 操作建议“${advice || "-"}”不是交易信号`);
  }

  return {
    buySignals,
    sellSignals,
    recentReports: [...recentSeen.values()],
  };
}
