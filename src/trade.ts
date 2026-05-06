import { QuoteContext, TradeContext } from "longbridge";
import { buildConfig } from "./lib/auth.js";
import {
  cleanupOcoOrders,
  cleanupOrphanedOrders,
  pruneExpiredOrders,
  pruneStaleBuyOrders,
} from "./lib/cleanup.js";
import { queryAll } from "./lib/db.js";
import { executeSellSignal, executeSignal, patchMissingSlTp } from "./lib/executor.js";
import { OrderWatcher } from "./lib/order-watcher.js";
import { toLongbridgeSymbol } from "./lib/symbols.js";
import { drainWrites, getSubmittedRecordIds, loadTrackedOrders } from "./lib/tracker.js";
import type { AnalysisRecord, TradeSignal } from "./lib/types.js";

function printDryRunSignals(
  buySignals: AnalysisRecord[],
  sellRecords: AnalysisRecord[],
  priceThresholdPct: number,
  positionPct: number,
): void {
  const allSignals = [
    ...buySignals.map((r) => ({ record: r, side: "买入" as const })),
    ...sellRecords.map((r) => ({
      record: r,
      side: (r.operation_advice ?? "").includes("减仓") ? ("减仓" as const) : ("卖出" as const),
    })),
  ];

  if (allSignals.length === 0) {
    console.log("没有符合条件的交易信号。");
    return;
  }

  console.log(
    `\n找到 ${allSignals.length} 个信号待处理（${buySignals.length} 买入 / ${sellRecords.length} 卖出）\n`,
  );

  for (const { record, side } of allSignals) {
    const symbol = toLongbridgeSymbol(record.code);
    const symbolDisplay = symbol ?? record.code;

    console.log(`${"=".repeat(80)}`);
    console.log(`🔹 [${record.code}] ${record.name ?? "未知"} → ${symbolDisplay}`);
    console.log(`   报告类型: ${record.report_type ?? "-"} | 时间: ${record.created_at}`);
    console.log(
      `   情绪评分: ${record.sentiment_score ?? "-"} | 操作建议: ${record.operation_advice ?? "-"} | 趋势: ${record.trend_prediction ?? "-"}`,
    );
    console.log(
      `   理想买入: ${record.ideal_buy ?? "-"} | 次选买入: ${record.secondary_buy ?? "-"} | 止损: ${record.stop_loss ?? "-"} | 止盈: ${record.take_profit ?? "-"}`,
    );
    if (record.analysis_summary) {
      console.log(`   摘要: ${record.analysis_summary}`);
    }

    if (side === "买入" && record.ideal_buy) {
      const threshold = record.ideal_buy * (1 + priceThresholdPct / 100);
      console.log(`\n   📋 交易计划:`);
      console.log(
        `      方向: 买入 | 目标价: ${record.ideal_buy} | 价格阈值: +${priceThresholdPct}% → ${threshold.toFixed(2)}`,
      );
      if (record.stop_loss) console.log(`      止损: ${record.stop_loss} (MIT 市价触单)`);
      if (record.take_profit) console.log(`      止盈: ${record.take_profit} (LIT 限价触单)`);
      console.log(`      仓位比例: ${positionPct}%（需连接 Longbridge 才能计算具体数量）`);
    } else if (side === "卖出") {
      console.log(`\n   📋 交易计划:`);
      console.log(`      方向: ${side} | 模式: ${side === "减仓" ? "部分减仓" : "全部清仓"}`);
    } else {
      console.log(`\n   📋 交易计划:`);
      console.log(`      方向: ${side} | 目标价: ${record.ideal_buy ?? "-"}`);
    }
    console.log(`${"=".repeat(80)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isAutoApprove = args.includes("--auto-approve");
  const isDryRun = args.includes("--dry-run");

  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    console.error("错误: 请在 .env 中设置 DB_PATH（stock_analysis.db 文件路径）");
    process.exit(1);
  }

  if (!isDryRun) {
    const clientId = process.env.CLIENT_ID;
    if (!clientId) {
      console.error("错误: 请在 .env 中设置 CLIENT_ID（Longbridge OAuth client ID）");
      process.exit(1);
    }
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

  // Dry-run: query DB and print signals without connecting to Longbridge
  if (isDryRun) {
    const submittedIds = getSubmittedRecordIds();
    const {
      buySignals,
      sellSignals: sellRecords,
      recentReports,
    } = queryAll(dbPath, [...submittedIds]);
    console.log(`🔍 [DRY RUN] 模拟运行，不会实际下单\n`);
    console.log(`📊 最近 12 小时分析报告: ${recentReports.length} 条`);
    printDryRunSignals(buySignals, sellRecords, priceThresholdPct, positionPct);
    return;
  }

  console.log("🔐 正在连接 Longbridge...");
  const clientId = process.env.CLIENT_ID ?? "";
  const config = await buildConfig(clientId);
  const quoteCtx = QuoteContext.new(config);
  const tradeCtx = TradeContext.new(config);

  // Check tracked orders via API, remove cancelled/expired/rejected ones
  // so their signals can be re-processed
  await pruneStaleBuyOrders(tradeCtx);
  await cleanupOrphanedOrders(tradeCtx);
  await cleanupOcoOrders(tradeCtx);
  // Check for filled buy orders missing SL/TP (from prior crash)
  await patchMissingSlTp(tradeCtx);

  const pruned = pruneExpiredOrders();
  if (pruned > 0) {
    console.log(`🗑️  已清理 ${pruned} 条超过 2 周的过期订单记录`);
  }

  // Query DB once after cleanup (free'd signal IDs are now available)
  const submittedIds = getSubmittedRecordIds();
  const {
    buySignals,
    sellSignals: sellRecords,
    recentReports,
  } = queryAll(dbPath, [...submittedIds]);

  console.log(`\n📊 最近 12 小时分析报告: ${recentReports.length} 条`);

  const signals: TradeSignal[] = [];
  for (const record of buySignals) {
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
      targetPrice: record.take_profit,
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
    try {
      if (signal.side === "Buy") {
        await executeSignal(execConfig, signal);
      } else {
        await executeSellSignal(execConfig, signal);
      }
    } catch (err) {
      console.error(`[ERR] ${signal.symbol} 处理异常，跳过: ${err}`);
    }
  }

  // Keep the process alive briefly to allow any final OCO pushes to be processed
  await new Promise((r) => setTimeout(r, 2000));

  try {
    await orderWatcher.stop();
  } catch (err) {
    console.error(`[WARN] 关闭 OrderWatcher 失败: ${err}`);
  }

  // Flush any pending order tracking writes before exit
  await drainWrites();

  // Longbridge SDK holds open gRPC connections that keep the event loop alive.
  // Force exit since this is a CLI script, not a long-running server.
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
