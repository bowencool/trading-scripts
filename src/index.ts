import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "./stock_analysis.db";

interface AnalysisRecord {
  id: number;
  code: string;
  name: string | null;
  report_type: string | null;
  sentiment_score: number | null;
  operation_advice: string | null;
  trend_prediction: string | null;
  analysis_summary: string | null;
  ideal_buy: number | null;
  secondary_buy: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  created_at: string;
}

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const reports = db.prepare(`
    SELECT
      id,
      code,
      name,
      report_type,
      sentiment_score,
      operation_advice,
      trend_prediction,
      analysis_summary,
      ideal_buy,
      secondary_buy,
      stop_loss,
      take_profit,
      created_at
    FROM analysis_history
    WHERE created_at >= datetime('now', '-24 hours')
      AND code NOT GLOB '[036][0-9][0-9][0-9][0-9][0-9]'
    ORDER BY created_at DESC
  `).all() as unknown as AnalysisRecord[];

  console.log(`\n📊 最近 24 小时分析报告 (共 ${reports.length} 条)\n`);
  console.log("─".repeat(100));

  for (const r of reports) {
    console.log(`🔹 [${r.code}] ${r.name ?? "未知"} | ${r.report_type ?? "-"} | ${r.created_at}`);
    console.log(`   情绪评分: ${r.sentiment_score ?? "-"} | 操作建议: ${r.operation_advice ?? "-"} | 趋势: ${r.trend_prediction ?? "-"}`);
    console.log(`   理想买入: ${r.ideal_buy ?? "-"} | 次选买入: ${r.secondary_buy ?? "-"} | 止损: ${r.stop_loss ?? "-"} | 止盈: ${r.take_profit ?? "-"}`);
    if (r.analysis_summary) {
      console.log(`   摘要: ${r.analysis_summary}`);
    }
    console.log("─".repeat(100));
  }

  db.close();
}

main();