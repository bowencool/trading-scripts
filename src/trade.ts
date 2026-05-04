import { QuoteContext, TradeContext, OrderStatus } from "longbridge";
import { buildConfig } from "./lib/auth.js";
import { toLongbridgeSymbol } from "./lib/symbols.js";
import { fetchBuySignals, fetchRecentReports } from "./lib/db.js";
import { executeSignal } from "./lib/executor.js";
import { getSubmittedRecordIds, loadTrackedOrders, removeOrder } from "./lib/tracker.js";
import type { AnalysisRecord, TradeSignal } from "./lib/types.js";

function printReports(reports: AnalysisRecord[]): void {
  console.log(`\n📊 最近 12 小时分析报告 (共 ${reports.length} 条)\n`);
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

async function cleanupOrphanedOrders(tradeCtx: TradeContext): Promise<void> {
  console.log("🧹 清理孤儿订单...");
  const orders = loadTrackedOrders();
  const slTpOrders = orders.filter((o) => o.role === "stop_loss" || o.role === "take_profit");
  const buyOrderIds = new Set(orders.filter((o) => o.role === "buy").map((o) => o.orderId));

  let cleaned = 0;
  for (const slTp of slTpOrders) {
    if (!slTp.linkedBuyOrderId || !buyOrderIds.has(slTp.linkedBuyOrderId)) {
      try {
        await tradeCtx.cancelOrder(slTp.orderId);
        console.log(`[CANCEL] 已取消孤立订单 ${slTp.orderId} (${slTp.role}, ${slTp.symbol})`);
        removeOrder(slTp.orderId);
        cleaned++;
      } catch (err) {
        console.error(`[WARN] 取消订单 ${slTp.orderId} 失败: ${err}`);
      }
      continue;
    }
    try {
      const buyDetail = await tradeCtx.orderDetail(slTp.linkedBuyOrderId);
      if (buyDetail.status === OrderStatus.Canceled || buyDetail.status === OrderStatus.Expired || buyDetail.status === OrderStatus.Rejected) {
        await tradeCtx.cancelOrder(slTp.orderId);
        const statusName = buyDetail.status === OrderStatus.Canceled ? "Canceled" : buyDetail.status === OrderStatus.Expired ? "Expired" : "Rejected";
        console.log(`[CANCEL] 买单 ${slTp.linkedBuyOrderId} 已${statusName}，取消关联订单 ${slTp.orderId} (${slTp.role})`);
        removeOrder(slTp.orderId);
        cleaned++;
      }
    } catch (err) {
      console.error(`[WARN] 查询买单 ${slTp.linkedBuyOrderId} 失败: ${err}`);
    }
  }
  if (cleaned > 0) {
    console.log(`✅ 清理完成，共取消 ${cleaned} 个孤儿订单`);
  } else {
    console.log("✅ 无孤儿订单");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isTradeMode = args.includes("--trade");
  const isForce = args.includes("--force");
  const isCleanup = args.includes("--cleanup");

  const dbPath = process.env.DB_PATH || "./stock_analysis.db";

  // Always show recent reports
  const reports = fetchRecentReports(dbPath);
  printReports(reports);

  // Standalone cleanup mode
  if (isCleanup) {
    const clientId = process.env.CLIENT_ID;
    if (!clientId) {
      console.error("错误: 请在 .env 中设置 CLIENT_ID");
      process.exit(1);
    }
    const config = await buildConfig(clientId);
    const tradeCtx = TradeContext.new(config);
    await cleanupOrphanedOrders(tradeCtx);
    return;
  }

  // If trade mode, run trading
  if (isTradeMode) {
    const clientId = process.env.CLIENT_ID;
    if (!clientId) {
      console.error("错误: 请在 .env 中设置 CLIENT_ID（Longbridge OAuth client ID）");
      process.exit(1);
    }

    const priceThresholdPct = Number(process.env.PRICE_THRESHOLD_PCT || "2");
    const positionPct = Number(process.env.POSITION_PCT || "20");
    if (!Number.isFinite(priceThresholdPct) || priceThresholdPct < 0 || priceThresholdPct > 100) {
      console.error(`错误: PRICE_THRESHOLD_PCT 必须是 0-100 的数字，当前值: ${process.env.PRICE_THRESHOLD_PCT}`);
      process.exit(1);
    }
    if (!Number.isFinite(positionPct) || positionPct <= 0 || positionPct > 100) {
      console.error(`错误: POSITION_PCT 必须是 0-100 的正数，当前值: ${process.env.POSITION_PCT}`);
      process.exit(1);
    }

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

    console.log("🔐 正在连接 Longbridge...");
    const config = await buildConfig(clientId);
    const quoteCtx = QuoteContext.new(config);
    const tradeCtx = TradeContext.new(config);

    // Auto-cleanup orphaned orders before trading
    await cleanupOrphanedOrders(tradeCtx);

    const execConfig = { quoteCtx, tradeCtx, force: isForce, positionPct, priceThresholdPct };
    for (const signal of signals) {
      await executeSignal(execConfig, signal);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
