import { QuoteContext, TradeContext } from "longbridge";
import { buildConfig } from "./lib/auth.js";
import {
  type CleanupAction,
  collectCleanupActions,
  executeCleanupActions,
  formatCleanupAction,
} from "./lib/cleanup.js";
import {
  buildActionPlan,
  buildPreflightPlan,
  projectPortfolioAfterPreflight,
} from "./lib/comparator.js";
import { promptConfirm } from "./lib/confirm.js";
import { queryAll, querySlTpRecord, WINDOW_HOURS } from "./lib/db.js";
import { executeAction, FatalError } from "./lib/executor.js";
import { OrderWatcher } from "./lib/order-watcher.js";
import { fetchPortfolioState } from "./lib/portfolio.js";
import type { ActionKind, ActionPlan, AnalysisRecord } from "./lib/types.js";

// ── Display ───────────────────────────────────────────────────────────────────

const ACTION_LABEL: Record<ActionKind, string> = {
  CANCEL_CONFLICTING_ORDERS: "🚫 取消冲突挂单",
  NEW_BUY: "🆕 新建买入",
  UPDATE_BUY: "🔄 更新买单",
  SELL_FULL: "📉 全仓卖出",
  SELL_PARTIAL: "📉 部分减仓",
  SYNC_SL_TP: "🔧 同步 SL/TP",
  RECOVER_SL_TP: "🛠️ 补挂 SL/TP",
  MERGE_SL_TP: "🔗 合并重复 SL/TP",
  HOLD: "⏸️  持仓匹配",
};

function printStartupCleanupPreview(actions: CleanupAction[], mode: "plan" | "dry-run"): void {
  if (actions.length === 0) {
    console.log(mode === "dry-run" ? "✅ [DRY RUN] 无孤儿订单" : "✅ 无孤儿订单");
    return;
  }

  for (const action of actions) {
    console.log(formatCleanupAction(action, mode));
  }

  const suffix = mode === "dry-run" ? "待清理订单" : "待确认清理订单";
  const prefix = mode === "dry-run" ? "✅ [DRY RUN]" : "📋";
  console.log(`${prefix} 共发现 ${actions.length} 个${suffix}`);
}

function printActionPlan(title: string, plans: ActionPlan[]): void {
  if (plans.length === 0) {
    console.log(`\n📋 ${title}: 无操作\n`);
    return;
  }

  const actionPlans = plans.filter((p) => p.action !== "HOLD");
  const holdPlans = plans.filter((p) => p.action === "HOLD");

  console.log(`\n📋 ${title}: ${actionPlans.length} 个操作 + ${holdPlans.length} 个持仓跳过\n`);

  for (const plan of plans) {
    const { symbol, record, action } = plan;
    const label = ACTION_LABEL[action];
    console.log(`${"=".repeat(80)}`);
    console.log(`${label} [${record.code}] ${record.name ?? "未知"} → ${symbol}`);
    console.log(`   报告类型: ${record.report_type ?? "-"} | 时间: ${record.created_at}`);
    console.log(
      `   情绪评分: ${record.sentiment_score ?? "-"} | 操作建议: ${record.operation_advice ?? "-"} | 趋势: ${record.trend_prediction ?? "-"}`,
    );
    console.log(
      `   理想买入: ${record.ideal_buy ?? "-"} | 止损: ${record.stop_loss ?? "-"} | 止盈: ${record.take_profit ?? "-"}`,
    );

    if (plan.holding) {
      console.log(
        `   持仓: ${plan.holding.quantity} 股 | 可卖: ${plan.holding.availableQuantity} 股 | 成本价: ${plan.holding.costPrice}`,
      );
    }

    if (plan.pendingBuyOrder) {
      console.log(
        `   Pending 买单: ${plan.pendingBuyOrder.orderId} @ ${plan.pendingBuyOrder.price}`,
      );
    }

    if (plan.action === "CANCEL_CONFLICTING_ORDERS" && plan.ordersToCancel) {
      console.log(
        `   冲突挂单: ${plan.ordersToCancel.map((order) => `${order.orderId}(${order.role})`).join(", ")}`,
      );
    }

    if (plan.existingSlOrder) {
      console.log(
        `   现有止损: ${plan.existingSlOrder.orderId || "(预期新单)"} @ ${plan.existingSlOrder.triggerPrice}`,
      );
    }

    if (plan.existingTpOrder) {
      console.log(
        `   现有止盈: ${plan.existingTpOrder.orderId || "(预期新单)"} @ ${plan.existingTpOrder.triggerPrice}`,
      );
    }

    console.log(`${"=".repeat(80)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isAutoApprove = args.includes("--auto-approve");
  const isDryRun = args.includes("--dry-run");

  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    console.error("错误: 请在 .env 中设置 DB_PATH（stock_analysis.db 文件路径）");
    process.exit(1);
  }

  const clientId = process.env.CLIENT_ID;
  if (!clientId) {
    console.error("错误: 请在 .env 中设置 CLIENT_ID（Longbridge OAuth client ID）");
    process.exit(1);
  }

  const priceThresholdPct = Number(process.env.PRICE_THRESHOLD_PCT || "2");
  const buyPct = Number(process.env.BUY_PCT || "15");
  const sellPct = Number(process.env.SELL_PCT || "50");
  if (!Number.isFinite(priceThresholdPct) || priceThresholdPct < 0 || priceThresholdPct > 100) {
    console.error(
      `错误: PRICE_THRESHOLD_PCT 必须是 0-100 的数字，当前值: ${process.env.PRICE_THRESHOLD_PCT}`,
    );
    process.exit(1);
  }
  if (!Number.isFinite(buyPct) || buyPct <= 0 || buyPct > 100) {
    console.error(`错误: BUY_PCT 必须是 0-100 的正数，当前值: ${process.env.BUY_PCT}`);
    process.exit(1);
  }
  if (!Number.isFinite(sellPct) || sellPct <= 0 || sellPct > 100) {
    console.error(`错误: SELL_PCT 必须是 0-100 的正数，当前值: ${process.env.SELL_PCT}`);
    process.exit(1);
  }

  if (isDryRun) {
    console.log(`🔍 [DRY RUN] 模拟运行，仅展示行动计划，不会实际下单\n`);
  }

  // Connect to Longbridge (dry-run also needs readonly APIs for portfolio state)
  console.log("🔐 正在连接 Longbridge...");
  const config = await buildConfig(clientId);
  const quoteCtx = QuoteContext.new(config);
  const tradeCtx = TradeContext.new(config);

  // 1. Preview or execute orphan cleanup
  console.log("🧹 清理孤儿订单...");
  const cleanupActions = await collectCleanupActions(tradeCtx);
  if (isDryRun) {
    printStartupCleanupPreview(cleanupActions, "dry-run");
  } else if (cleanupActions.length === 0) {
    console.log("✅ 无孤儿订单");
  } else if (isAutoApprove) {
    await executeCleanupActions(tradeCtx, cleanupActions);
  } else {
    printStartupCleanupPreview(cleanupActions, "plan");
    const confirmed = await promptConfirm(
      `\n确认执行启动前孤儿订单清理？(Enter 确认 / Esc 取消): `,
    );
    if (confirmed) {
      await executeCleanupActions(tradeCtx, cleanupActions);
    } else {
      console.log("[SKIP] 用户取消启动前孤儿订单清理");
    }
  }

  // 2. Fetch portfolio state (holdings + active orders)
  console.log("\n📊 获取持仓和活跃订单...");
  const portfolio = await fetchPortfolioState(tradeCtx);

  console.log(`\n📊 持仓: ${portfolio.holdings.size} 只`);
  for (const [symbol, holding] of portfolio.holdings) {
    console.log(
      `   ${symbol}: ${holding.quantity} 股 (可用 ${holding.availableQuantity}) @ 成本 ${holding.costPrice}`,
    );
  }
  console.log(`📊 活跃订单: ${portfolio.activeOrders.length} 个`);

  const existingSlTpOrders = portfolio.activeOrders.filter(
    (order) => order.role === "stop_loss" || order.role === "take_profit",
  );
  const existingWorkingOrders = portfolio.activeOrders.filter(
    (order) => order.role !== "stop_loss" && order.role !== "take_profit",
  );
  if (existingSlTpOrders.length > 0) {
    console.log(`📊 现存 SL/TP 订单: ${existingSlTpOrders.length} 个`);
    for (const order of existingSlTpOrders) {
      const label = order.role === "stop_loss" ? "止损" : "止盈";
      const price = order.role === "stop_loss" ? order.triggerPrice : order.price;
      console.log(
        `   ${order.symbol}: ${label} ${order.orderId} @ ${price} | 数量 ${order.quantity} | 状态 ${order.status}`,
      );
    }
  }
  if (existingWorkingOrders.length > 0) {
    console.log(`📊 活跃未成交普通订单: ${existingWorkingOrders.length} 个`);
    for (const order of existingWorkingOrders) {
      const label = order.role === "buy" ? "买单" : "卖单";
      console.log(
        `   ${order.symbol}: ${label} ${order.orderId} @ ${order.price} | 数量 ${order.quantity} | 状态 ${order.status}`,
      );
    }
  }

  // 3. Query DB signals
  const { buySignals, sellSignals, recentReports } = queryAll(dbPath);
  console.log(`\n📊 最近 ${WINDOW_HOURS} 小时分析报告: ${recentReports.length} 条`);

  // 4. Fetch SL/TP records for all held symbols
  const slTpRecords = new Map<string, AnalysisRecord>();
  for (const symbol of portfolio.holdings.keys()) {
    const code = symbolToCode(symbol);
    if (!code) continue;
    const slTpRecord = querySlTpRecord(dbPath, code);
    if (slTpRecord) {
      slTpRecords.set(symbol, slTpRecord);
    }
  }

  // 5. Build startup preflight plan
  const preflightPlan = buildPreflightPlan(portfolio, buySignals, sellSignals, slTpRecords);
  printActionPlan("启动前预检查", preflightPlan);

  // 6. Dry-run renders the post-preflight trade plan and stops
  if (isDryRun) {
    const projectedPortfolio = projectPortfolioAfterPreflight(portfolio, preflightPlan);
    const dryRunActionPlan = buildActionPlan(
      projectedPortfolio,
      buySignals,
      sellSignals,
      slTpRecords,
      priceThresholdPct,
    );
    printActionPlan("交易行动计划", dryRunActionPlan);
    console.log("\n🔍 [DRY RUN] 预检查与交易计划展示完毕，未执行任何操作。");
    return;
  }

  // 7. Start WebSocket order push listener once for the full run
  const orderWatcher = new OrderWatcher(tradeCtx);
  await orderWatcher.start();

  const execConfig = {
    quoteCtx,
    tradeCtx,
    orderWatcher,
    autoApprove: isAutoApprove,
    buyPct,
    sellPct,
    priceThresholdPct,
  };

  let finalPortfolio = portfolio;
  const actionablePreflight = preflightPlan.filter((p) => p.action !== "HOLD");

  for (const plan of actionablePreflight) {
    try {
      await executeAction(execConfig, plan);
    } catch (err) {
      if (err instanceof FatalError) {
        console.error(`[FATAL] ${err.message} — 终止后续执行`);
        break;
      }
      console.error(`[ERR] ${plan.symbol} ${plan.action} 失败: ${err}`);
      // Non-fatal: continue with next plan
    }
  }

  if (actionablePreflight.length > 0) {
    console.log("\n🔄 预检查执行完成，刷新持仓和活跃订单...");
    finalPortfolio = await fetchPortfolioState(tradeCtx);
    console.log(`📊 刷新后活跃订单: ${finalPortfolio.activeOrders.length} 个`);
  }

  // 8. Build and display final trade plan from post-preflight portfolio
  const actionPlan = buildActionPlan(
    finalPortfolio,
    buySignals,
    sellSignals,
    slTpRecords,
    priceThresholdPct,
  );
  printActionPlan("交易行动计划", actionPlan);

  const actionable = actionPlan.filter((p) => p.action !== "HOLD");

  if (actionable.length === 0) {
    await orderWatcher.stop();
    console.log("没有需要执行的操作。");
    return;
  }

  // 9. Execute each trade action serially
  for (const plan of actionable) {
    try {
      await executeAction(execConfig, plan);
    } catch (err) {
      if (err instanceof FatalError) {
        console.error(`[FATAL] ${err.message} — 终止后续执行`);
        break;
      }
      console.error(`[ERR] ${plan.symbol} ${plan.action} 失败: ${err}`);
    }
  }

  // 10. Cleanup
  await orderWatcher.stop();
  console.log("\n✅ 完成");
}

/**
 * Reverse map a Longbridge symbol back to a DB code for SL/TP lookup.
 * "01810.HK" → "HK01810", "AAPL.US" → "AAPL"
 */
function symbolToCode(symbol: string): string | null {
  if (symbol.endsWith(".HK")) {
    const num = symbol.replace(".HK", "");
    return `HK${num}`;
  }
  if (symbol.endsWith(".US")) {
    return symbol.replace(".US", "");
  }
  if (symbol.endsWith(".SH")) {
    return symbol.replace(".SH", "");
  }
  if (symbol.endsWith(".SZ")) {
    return symbol.replace(".SZ", "");
  }
  return null;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("未捕获错误:", err);
    process.exit(1);
  });
