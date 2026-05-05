import { QuoteContext, TradeContext } from "longbridge";
import { buildConfig } from "./lib/auth.js";
import {
  cleanupOcoOrders,
  cleanupOrphanedOrders,
  pruneExpiredOrders,
  pruneStaleBuyOrders,
} from "./lib/cleanup.js";
import { fetchBuySignals, fetchRecentReports, fetchSellSignals } from "./lib/db.js";
import { executeSellSignal, executeSignal } from "./lib/executor.js";
import { OrderWatcher } from "./lib/order-watcher.js";
import { toLongbridgeSymbol } from "./lib/symbols.js";
import { getSubmittedRecordIds, loadTrackedOrders } from "./lib/tracker.js";
import type { TradeSignal } from "./lib/types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isAutoApprove = args.includes("--auto-approve");

  const dbPath = process.env.DB_PATH || "./data/stock_analysis.db";

  const reports = fetchRecentReports(dbPath);
  console.log(`\n📊 最近 12 小时分析报告: ${reports.length} 条`);

  const clientId = process.env.CLIENT_ID;
  if (!clientId) {
    console.error("错误: 请在 .env 中设置 CLIENT_ID（Longbridge OAuth client ID）");
    process.exit(1);
  }

  const priceThresholdPct = Number(process.env.PRICE_THRESHOLD_PCT || "2");
  const positionPct = Number(process.env.POSITION_PCT || "20");
  if (!Number.isFinite(priceThresholdPct) || priceThresholdPct < 0 || priceThresholdPct > 100) {
    console.error(
      `错误: PRICE_THRESHOLD_PCT 必须是 0-100 的数字，当前值: ${process.env.PRICE_THRESHOLD_PCT}`,
    );
    process.exit(1);
  }
  if (!Number.isFinite(positionPct) || positionPct <= 0 || positionPct > 100) {
    console.error(`错误: POSITION_PCT 必须是 0-100 的正数，当前值: ${process.env.POSITION_PCT}`);
    process.exit(1);
  }

  console.log("🔐 正在连接 Longbridge...");
  const config = await buildConfig(clientId);
  const quoteCtx = QuoteContext.new(config);
  const tradeCtx = TradeContext.new(config);

  // Check tracked orders via API, remove cancelled/expired/rejected ones
  // so their signals can be re-processed
  await pruneStaleBuyOrders(tradeCtx);
  await cleanupOrphanedOrders(tradeCtx);
  await cleanupOcoOrders(tradeCtx);

  const pruned = pruneExpiredOrders();
  if (pruned > 0) {
    console.log(`🗑️  已清理 ${pruned} 条超过 2 周的过期订单记录`);
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
      // biome-ignore lint/style/noNonNullAssertion: buy signals always have ideal_buy
      targetPrice: record.ideal_buy!,
      stopLoss: record.stop_loss,
      takeProfit: record.take_profit,
    });
  }

  // Sell signals: "卖出" = full exit, "减仓" = partial exit
  const sellRecords = fetchSellSignals(dbPath, [...submittedIds]);
  for (const record of sellRecords) {
    const symbol = toLongbridgeSymbol(record.code);
    if (!symbol) {
      console.warn(`[SKIP] 无法映射代码 "${record.code}" 到 Longbridge symbol`);
      continue;
    }
    const isPartial = (record.operation_advice ?? "").includes("减仓");
    signals.push({
      record,
      symbol,
      side: "Sell",
      targetPrice: record.take_profit ?? 0,
      stopLoss: null,
      takeProfit: null,
      sellMode: isPartial ? "reduce" : "full",
    });
  }

  console.log(
    `\n找到 ${signals.length} 个信号待处理（${signals.filter((s) => s.side === "Buy").length} 买入 / ${signals.filter((s) => s.side === "Sell").length} 卖出）\n`,
  );

  if (signals.length === 0) {
    console.log("没有符合条件的交易信号。");
    return;
  }

  // Start WebSocket order push listener
  const orderWatcher = new OrderWatcher(tradeCtx);
  await orderWatcher.start();

  // Register remaining OCO pairs with the watcher for real-time monitoring
  const remainingOrders = loadTrackedOrders();
  const seen = new Set<string>();
  for (const o of remainingOrders) {
    if (o.ocoPairOrderId && !seen.has(o.orderId)) {
      seen.add(o.orderId);
      seen.add(o.ocoPairOrderId);
      orderWatcher.watchOcoPair(o.orderId, o.ocoPairOrderId);
      console.log(`[WS] OCO 实时监控已注册: ${o.orderId} ↔ ${o.ocoPairOrderId}`);
    }
  }

  const execConfig = {
    quoteCtx,
    tradeCtx,
    orderWatcher,
    autoApprove: isAutoApprove,
    positionPct,
    priceThresholdPct,
  };
  for (const signal of signals) {
    if (signal.side === "Buy") {
      await executeSignal(execConfig, signal);
    } else {
      await executeSellSignal(execConfig, signal);
    }
  }

  // Keep the process alive briefly to allow any final OCO pushes to be processed
  await new Promise((r) => setTimeout(r, 2000));
  await orderWatcher.stop();

  // Longbridge SDK holds open gRPC connections that keep the event loop alive.
  // Force exit since this is a CLI script, not a long-running server.
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
