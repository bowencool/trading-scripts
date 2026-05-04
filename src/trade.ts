import { QuoteContext, TradeContext } from "longbridge";
import { buildConfig } from "./lib/auth.js";
import { toLongbridgeSymbol } from "./lib/symbols.js";
import { fetchBuySignals, fetchRecentReports } from "./lib/db.js";
import { executeSignal } from "./lib/executor.js";
import { getSubmittedRecordIds } from "./lib/tracker.js";
import type { AnalysisRecord, TradeSignal } from "./lib/types.js";

function printReports(reports: AnalysisRecord[]): void {
  console.log(`\n📊 最近 24 小时分析报告 (共 ${reports.length} 条)\n`);
  console.log("─".repeat(100));

  for (const r of reports) {
    console.log(`🔹 [${r.code}] ${r.name ?? "未知"} | ${r.report_type ?? "-"} | ${r.created_at}`);
    console.log(
      `   情绪评分: ${r.sentiment_score ?? "-"} | 操作建议: ${r.operation_advice ?? "-"} | 趋势: ${r.trend_prediction ?? "-"}`
    );
    console.log(
      `   理想买入: ${r.ideal_buy ?? "-"} | 次选买入: ${r.secondary_buy ?? "-"} | 止损: ${r.stop_loss ?? "-"} | 止盈: ${r.take_profit ?? "-"}`
    );
    if (r.analysis_summary) {
      console.log(`   摘要: ${r.analysis_summary}`);
    }
    console.log("─".repeat(100));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isTradeMode = args.includes("--trade");
  const isForce = args.includes("--force");

  const dbPath = process.env.DB_PATH || "./stock_analysis.db";

  // Always show recent reports
  const reports = fetchRecentReports(dbPath);
  printReports(reports);

  // If trade mode, run trading
  if (isTradeMode) {
    const clientId = process.env.CLIENT_ID;
    if (!clientId) {
      console.error("错误: 请在 .env 中设置 CLIENT_ID（Longbridge OAuth client ID）");
      process.exit(1);
    }

    const priceThresholdPct = Number(process.env.PRICE_THRESHOLD_PCT || "2");
    const maxPositionValue = Number(process.env.MAX_POSITION_VALUE || "10000");

    console.log("\n🔐 正在连接 Longbridge...");
    const config = await buildConfig(clientId);

    const submittedIds = getSubmittedRecordIds();
    const records = fetchBuySignals(dbPath, [...submittedIds]);

    const signals: TradeSignal[] = [];
    for (const record of records) {
      const symbol = toLongbridgeSymbol(record.code);
      if (!symbol) {
        console.warn(`[SKIP] 无法映射代码 "${record.code}" 到 Longbridge symbol`);
        continue;
      }
      signals.push({
        record,
        symbol,
        side: "Buy",
        targetPrice: record.ideal_buy!,
        stopLoss: record.stop_loss,
        takeProfit: record.take_profit,
      });
    }

    console.log(`\n找到 ${signals.length} 个买入信号待处理\n`);

    if (signals.length === 0) {
      console.log("没有符合条件的交易信号。");
      return;
    }

    const quoteCtx = QuoteContext.new(config);
    const tradeCtx = TradeContext.new(config);
    const execConfig = { quoteCtx, tradeCtx, force: isForce, maxPositionValue, priceThresholdPct };
    for (const signal of signals) {
      await executeSignal(execConfig, signal);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
