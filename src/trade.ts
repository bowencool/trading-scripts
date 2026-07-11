import {
  buildCleanupActionsFromSnapshot,
  type CleanupAction,
  collectCompletedBuySignalRecordIdsFromSnapshot,
  executeCleanupActions,
  fetchCleanupSnapshot,
  formatCleanupAction,
} from "./lib/cleanup.js";
import { parseTradeCliArgs } from "./lib/cli.js";
import { colors } from "./lib/color.js";
import {
  buildActionPlan,
  buildPreflightPlan,
  projectPortfolioAfterPreflight,
} from "./lib/comparator.js";
import { promptConfirm } from "./lib/confirm.js";
import { queryAll, queryRecordById, querySlTpRecord, WINDOW_HOURS } from "./lib/db.js";
import { executeAction, FatalError } from "./lib/executor.js";
import { buildPortfolioStateFromSnapshot, fetchPortfolioState } from "./lib/portfolio.js";
import { createProviders } from "./lib/providers/factory.js";
import type { Instrument } from "./lib/providers/types.js";
import type { ActionKind, ActionPlan, AnalysisRecord } from "./lib/types.js";

// ── 显示 ───────────────────────────────────────────────────────────────────────

/** Extract record ID from remark like "auto-trade:buy:123" */
function extractRecordIdFromRemark(remark: string): number | null {
  const m = remark.match(/auto-trade:\w+:(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseBoolEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "y"].includes((value ?? "").trim().toLowerCase());
}

const ACTION_LABEL: Record<ActionKind, string> = {
  CANCEL_CONFLICTING_ORDERS: "🚫 取消冲突挂单",
  NEW_BUY: "🆕 新建买入",
  ADD_POSITION: "➕ 加仓买入",
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

    // Line 1: action + symbol
    console.log(`  ${label} [${record.code}] ${record.name ?? "未知"} → ${symbol}`);

    // Line 1.5: record id & time
    console.log(`    记录 #${record.id} · ${record.created_at}`);

    // Line 2: signal summary
    const parts: string[] = [];
    if (record.sentiment_score != null) parts.push(colors.cyan(record.sentiment_score));
    if (record.operation_advice) parts.push(record.operation_advice);
    if (record.trend_prediction) parts.push(record.trend_prediction);
    if (parts.length > 0) console.log(`    评分 ${parts.join(" · ")}`);

    // Line 3: prices
    const prices: string[] = [];
    if (record.ideal_buy != null) prices.push(`理想 ${colors.yellow(record.ideal_buy)}`);
    if (record.stop_loss != null) prices.push(`SL ${colors.red(record.stop_loss)}`);
    if (record.take_profit != null) prices.push(`TP ${colors.green(record.take_profit)}`);
    if (prices.length > 0) console.log(`    ${prices.join(" · ")}`);

    // Line 4: holding (if any)
    if (plan.holding) {
      console.log(
        `    持仓 ${colors.cyan(plan.holding.quantity)} 股 (可用 ${plan.holding.availableQuantity}) @ 成本 ${colors.yellow(plan.holding.costPrice)}`,
      );
    }

    // Line 5: pending order
    if (plan.pendingBuyOrder) {
      console.log(
        `    挂单 ${plan.pendingBuyOrder.orderId} @ ${colors.yellow(plan.pendingBuyOrder.price)}`,
      );
    }

    // Line 6: conflicting orders
    if (plan.action === "CANCEL_CONFLICTING_ORDERS" && plan.ordersToCancel) {
      console.log(
        `    冲突: ${plan.ordersToCancel.map((o) => `${o.orderId}(${o.role})`).join(", ")}`,
      );
    }

    // Line 7: existing SL/TP
    const slTpParts: string[] = [];
    if (plan.existingSlOrder) {
      slTpParts.push(
        `SL ${plan.existingSlOrder.orderId || "新"}@${plan.existingSlOrder.triggerPrice}`,
      );
    }
    if (plan.existingTpOrder) {
      slTpParts.push(
        `TP ${plan.existingTpOrder.orderId || "新"}@${plan.existingTpOrder.triggerPrice}`,
      );
    }
    if (slTpParts.length > 0) console.log(`    现有 ${slTpParts.join(" · ")}`);

    console.log(); // blank line between records
  }
}

// ── 主程序 ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const cli = parseTradeCliArgs(process.argv.slice(2), process.env);
  if (cli.kind === "help") {
    console.log(cli.usage);
    return 0;
  }
  if (cli.kind === "error") {
    console.error(`错误: ${cli.message}\n\n${cli.usage}`);
    return 1;
  }

  const { autoApprove: isAutoApprove, dryRun: isDryRun } = cli.options;

  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    console.error("错误: 请在 .env 中设置 DB_PATH（stock_analysis.db 文件路径）");
    return 1;
  }

  const clientId = process.env.CLIENT_ID;
  if (!clientId) {
    console.error("错误: 请在 .env 中设置 CLIENT_ID（Longbridge OAuth client ID）");
    return 1;
  }

  const priceThresholdPct = Number(process.env.PRICE_THRESHOLD_PCT || "2");
  const buyPct = Number(process.env.BUY_PCT || "15");
  const sellPct = Number(process.env.SELL_PCT || "50");
  const riskPctPerTrade = Number(process.env.RISK_PCT_PER_TRADE || "1");
  const maxPositionPct = Number(process.env.MAX_POSITION_PCT || "20");
  const maxHoldings = Number(process.env.MAX_HOLDINGS || "0");
  const strictSlTpCheck = parseBoolEnv(process.env.STRICT_SLTP_CHECK);
  if (!Number.isFinite(priceThresholdPct) || priceThresholdPct < 0 || priceThresholdPct > 100) {
    console.error(
      `错误: PRICE_THRESHOLD_PCT 必须是 0-100 的数字，当前值: ${process.env.PRICE_THRESHOLD_PCT}`,
    );
    return 1;
  }
  if (!Number.isFinite(buyPct) || buyPct <= 0 || buyPct > 100) {
    console.error(`错误: BUY_PCT 必须是 0-100 的正数，当前值: ${process.env.BUY_PCT}`);
    return 1;
  }
  if (!Number.isFinite(sellPct) || sellPct <= 0 || sellPct > 100) {
    console.error(`错误: SELL_PCT 必须是 0-100 的正数，当前值: ${process.env.SELL_PCT}`);
    return 1;
  }
  if (!Number.isFinite(riskPctPerTrade) || riskPctPerTrade < 0 || riskPctPerTrade > 100) {
    console.error(
      `错误: RISK_PCT_PER_TRADE 必须是 0-100 的数字，当前值: ${process.env.RISK_PCT_PER_TRADE}`,
    );
    return 1;
  }
  if (!Number.isFinite(maxPositionPct) || maxPositionPct < 0 || maxPositionPct > 100) {
    console.error(
      `错误: MAX_POSITION_PCT 必须是 0-100 的数字，当前值: ${process.env.MAX_POSITION_PCT}`,
    );
    return 1;
  }
  if (!Number.isFinite(maxHoldings) || maxHoldings < 0 || !Number.isInteger(maxHoldings)) {
    console.error(`错误: MAX_HOLDINGS 必须是非负整数，当前值: ${process.env.MAX_HOLDINGS}`);
    return 1;
  }

  if (isDryRun) {
    console.log(`🔍 [DRY RUN] 模拟运行，仅展示行动计划，不会实际下单\n`);
  }

  // 试运行也需要只读 provider 来获取投资组合状态。
  console.log(`🔐 正在连接行情 ${cli.options.marketData} / 交易 ${cli.options.broker}...`);
  const { marketData, broker } = await createProviders(cli.options, {
    longbridgeClientId: clientId,
  });
  console.log(
    broker.protectionMode === "reconciled-orders"
      ? "ℹ️  保护单模式: reconciled-orders（独立 SL/TP，下次启动时清理成交后的另一单）"
      : `ℹ️  保护单模式: ${broker.protectionMode}`,
  );

  // 1. 预览或执行孤儿订单清理
  console.log("🧹 清理孤儿订单...");
  const cleanupSnapshot = await fetchCleanupSnapshot(broker);
  const cleanupActions = buildCleanupActionsFromSnapshot(cleanupSnapshot);
  const completedBuySignalRecordIds =
    collectCompletedBuySignalRecordIdsFromSnapshot(cleanupSnapshot);
  let shouldReuseCleanupSnapshot = true;
  if (isDryRun) {
    printStartupCleanupPreview(cleanupActions, "dry-run");
  } else if (cleanupActions.length === 0) {
    console.log("✅ 无孤儿订单");
  } else if (isAutoApprove) {
    await executeCleanupActions(broker, cleanupActions);
    shouldReuseCleanupSnapshot = false;
  } else {
    printStartupCleanupPreview(cleanupActions, "plan");
    const confirmed = await promptConfirm(
      `\n确认执行启动前孤儿订单清理？(Enter 确认 / Esc 取消): `,
    );
    if (confirmed) {
      await executeCleanupActions(broker, cleanupActions);
      shouldReuseCleanupSnapshot = false;
    } else {
      console.log("[SKIP] 用户取消启动前孤儿订单清理");
    }
  }

  // 2. 获取投资组合状态 (持仓 + 活跃订单)
  console.log("\n📊 获取持仓和活跃订单...");
  const portfolio = shouldReuseCleanupSnapshot
    ? buildPortfolioStateFromSnapshot(
        {
          positions: cleanupSnapshot.positions,
          todayOrders: cleanupSnapshot.todayOrders,
          historyOrders: cleanupSnapshot.historyActiveOrders,
        },
        strictSlTpCheck,
      )
    : await fetchPortfolioState(broker, strictSlTpCheck);

  console.log(`\n📊 持仓: ${portfolio.holdings.size} 只`);
  for (const [symbol, holding] of portfolio.holdings) {
    console.log(
      `   ${symbol}: ${holding.quantity} 股 (可用 ${holding.availableQuantity}) @ 成本 ${holding.costPrice}`,
    );
  }
  console.log(`📊 活跃订单: ${portfolio.activeOrders.length} 个`);

  // 3. 查询所有持仓标的的止损/止盈分析记录
  const slTpRecords = new Map<string, AnalysisRecord>();
  for (const [symbol, holding] of portfolio.holdings) {
    const code = instrumentToCode(holding.instrument);
    if (!code) continue;
    const slTpRecord = querySlTpRecord(dbPath, code);
    if (slTpRecord) {
      slTpRecords.set(symbol, slTpRecord);
    }
  }

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
      const rec = slTpRecords.get(order.symbol);
      const recInfo = rec ? ` | 记录 #${rec.id} · ${rec.created_at}` : "";
      console.log(
        `   ${order.symbol}: ${label} ${order.orderId} @ ${price} | 数量 ${order.quantity} | 状态 ${order.status}${recInfo}`,
      );
    }
  }
  if (existingWorkingOrders.length > 0) {
    console.log(`📊 活跃未成交普通订单: ${existingWorkingOrders.length} 个`);
    for (const order of existingWorkingOrders) {
      const label = order.role === "buy" ? "买单" : "卖单";
      const remarkId = extractRecordIdFromRemark(order.remark);
      const rec = remarkId != null ? queryRecordById(dbPath, remarkId) : null;
      const recInfo = rec ? ` | 记录 #${rec.id} · ${rec.created_at}` : "";
      console.log(
        `   ${order.symbol}: ${label} ${order.orderId} @ ${order.price} | 数量 ${order.quantity} | 状态 ${order.status}${recInfo}`,
      );
    }
  }

  // 4. 查询数据库信号
  const { buySignals, sellSignals, recentReports } = queryAll(dbPath);
  console.log(`\n📊 最近 ${WINDOW_HOURS} 小时分析报告: ${recentReports.length} 条`);

  // 5. 构建启动前预检查计划
  const preflightPlan = buildPreflightPlan(
    portfolio,
    buySignals,
    sellSignals,
    slTpRecords,
    completedBuySignalRecordIds,
  );
  printActionPlan("启动前预检查", preflightPlan);

  // 7. 试运行展示启动后交易计划并停止
  if (isDryRun) {
    const projectedPortfolio = projectPortfolioAfterPreflight(portfolio, preflightPlan);
    const dryRunActionPlan = buildActionPlan(
      projectedPortfolio,
      buySignals,
      sellSignals,
      slTpRecords,
      priceThresholdPct,
      completedBuySignalRecordIds,
      maxHoldings,
    );
    printActionPlan("交易行动计划", dryRunActionPlan);
    console.log("\n🔍 [DRY RUN] 预检查与交易计划展示完毕，未执行任何操作。");
    return 0;
  }

  // 8. 仅在实际执行期间启动 broker 的短期订单事件订阅。
  await broker.start();
  try {
    const execConfig = {
      marketData,
      broker,
      autoApprove: isAutoApprove,
      buyPct,
      sellPct,
      riskPctPerTrade,
      maxPositionPct,
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
        // 非致命错误: 继续处理下一个计划
      }
    }

    if (actionablePreflight.length > 0) {
      console.log("\n🔄 预检查执行完成，刷新持仓和活跃订单...");
      finalPortfolio = await fetchPortfolioState(broker, strictSlTpCheck);
      console.log(`📊 刷新后活跃订单: ${finalPortfolio.activeOrders.length} 个`);
    }

    // 9. 从启动后投资组合构建并展示最终交易计划
    const actionPlan = buildActionPlan(
      finalPortfolio,
      buySignals,
      sellSignals,
      slTpRecords,
      priceThresholdPct,
      completedBuySignalRecordIds,
      maxHoldings,
    );
    printActionPlan("交易行动计划", actionPlan);

    const actionable = actionPlan.filter((p) => p.action !== "HOLD");

    if (actionable.length === 0) {
      console.log("没有需要执行的操作。");
      return 0;
    }

    // 10. 逐个执行每个交易操作
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

    console.log("\n✅ 完成");
    return 0;
  } finally {
    await broker.stop();
  }
}

/** Reverse-map a provider-neutral instrument to the database code convention. */
function instrumentToCode(instrument: Instrument): string {
  return instrument.market === "HK" ? `HK${instrument.symbol}` : instrument.symbol;
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch((err) => {
    console.error("未捕获错误:", err);
    process.exit(1);
  });
