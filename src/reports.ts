import { fetchRecentReports, WINDOW_HOURS } from "./lib/db.js";
import type { AnalysisRecord } from "./lib/types.js";

function printReports(reports: AnalysisRecord[]): void {
  console.log(`\n📊 最近 ${WINDOW_HOURS} 小时分析报告 (共 ${reports.length} 条)\n`);
  console.log("─".repeat(100));

  for (const r of reports) {
    console.log(`🔹 [${r.code}] ${r.name ?? "未知"} | ${r.report_type ?? "-"} | ${r.created_at}`);
    console.log(
      `   情绪评分: ${r.sentiment_score ?? "-"} | 操作建议: ${r.operation_advice ?? "-"} | 趋势: ${r.trend_prediction ?? "-"}`,
    );
    console.log(
      `   理想买入: ${r.ideal_buy ?? "-"} | 次选买入: ${r.secondary_buy ?? "-"} | 止损: ${r.stop_loss ?? "-"} | 止盈: ${r.take_profit ?? "-"}`,
    );
    if (r.analysis_summary) {
      console.log(`   摘要: ${r.analysis_summary}`);
    }
    console.log("─".repeat(100));
  }
}

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error("错误: 请在 .env 中设置 DB_PATH（stock_analysis.db 文件路径）");
  process.exit(1);
}
const reports = fetchRecentReports(dbPath);
printReports(reports);
