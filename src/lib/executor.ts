import { colors } from "./color.js";
import { promptConfirm } from "./confirm.js";
import { calculateBuyQuantity } from "./position-sizing.js";
import { computeBuyLimitPrice } from "./pricing.js";
import type { BrokerAdapter } from "./providers/broker.js";
import type { MarketDataProvider } from "./providers/market-data.js";
import type { BrokerOrder, Currency, Instrument, ProtectionOrderIds } from "./providers/types.js";
import type { ActionPlan, ActiveOrder, AnalysisRecord } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExecutorConfig {
  marketData: MarketDataProvider;
  broker: BrokerAdapter;
  autoApprove: boolean;
  buyPct: number;
  sellPct: number;
  riskPctPerTrade: number;
  maxPositionPct: number;
  priceThresholdPct: number;
}

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

function getCurrency(instrument: Instrument): Currency {
  const currencies: Record<Instrument["market"], Currency> = {
    US: "USD",
    HK: "HKD",
    CN: "CNY",
    SG: "SGD",
  };
  return currencies[instrument.market];
}

/**
 * Get the best available price for a symbol.
 * For buy side: prefer ask1 (卖一价) → pre/post/overnight → lastDone.
 * For sell side: prefer bid1 (买一价) → pre/post/overnight → lastDone.
 */
export async function getEffectivePrice(
  marketData: MarketDataProvider,
  instrument: Instrument,
  side: "buy" | "sell",
): Promise<{ price: number; source: string }> {
  try {
    const depth = await marketData.getOrderBook(instrument);
    const entries = side === "buy" ? depth.asks : depth.bids;
    const first = entries[0];
    if (first?.price && first.price > 0) {
      return { price: first.price, source: side === "buy" ? "卖一" : "买一" };
    }
  } catch {
    // depth API may not be available for all symbols
  }

  const quotes = await marketData.getQuotes([instrument]);
  if (quotes.length > 0) {
    const q = quotes[0];
    for (const [key, label] of [
      ["preMarket", "盘前"],
      ["postMarket", "盘后"],
      ["overnight", "夜盘"],
    ] as const) {
      const pq = q[key];
      if (pq) {
        const p = pq.price;
        if (p > 0) return { price: p, source: label };
      }
    }
    if (q.lastPrice > 0) return { price: q.lastPrice, source: "lastDone" };
  }

  return { price: 0, source: "N/A" };
}

function printAnalysisRecord(record: AnalysisRecord): void {
  console.log(`\n🔹 [${record.code}] ${record.name ?? "未知"} (${record.report_type ?? "-"})`);

  const parts: string[] = [];
  if (record.sentiment_score != null) parts.push(colors.cyan(record.sentiment_score));
  if (record.operation_advice) parts.push(record.operation_advice);
  if (record.trend_prediction) parts.push(record.trend_prediction);
  if (parts.length > 0) console.log(`   评分 ${parts.join(" · ")}`);

  const prices: string[] = [];
  if (record.ideal_buy != null) prices.push(`理想 ${colors.yellow(record.ideal_buy)}`);
  if (record.secondary_buy != null) prices.push(`次选 ${colors.yellow(record.secondary_buy)}`);
  if (record.stop_loss != null) prices.push(`SL ${colors.red(record.stop_loss)}`);
  if (record.take_profit != null) prices.push(`TP ${colors.green(record.take_profit)}`);
  if (prices.length > 0) console.log(`   ${prices.join(" · ")}`);

  if (record.analysis_summary) {
    console.log(`   ${record.analysis_summary}`);
  }
}

// ── Action executors ──────────────────────────────────────────────────────────

async function executeBuy(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const {
    marketData,
    broker,
    autoApprove,
    buyPct,
    riskPctPerTrade,
    maxPositionPct,
    priceThresholdPct,
  } = cfg;
  const { instrument, symbol, record, holding } = plan;
  const isAddPosition = plan.action === "ADD_POSITION";
  // biome-ignore lint/style/noNonNullAssertion: buy signals always have ideal_buy
  const targetPrice = record.ideal_buy!;

  printAnalysisRecord(record);

  const currency = getCurrency(instrument);

  const staticInfos = await marketData.getInstrumentInfo([instrument]);
  const balances = await broker.getAccountBalances(currency);

  const { price: currentPriceNum, source: priceSource } = await getEffectivePrice(
    marketData,
    instrument,
    "buy",
  );
  const lotSize = staticInfos.length > 0 ? staticInfos[0].lotSize : 1;

  if (currentPriceNum <= 0) {
    console.log(`[SKIP] ${symbol} - 无法获取有效现价`);
    return;
  }

  const threshold = computeBuyLimitPrice(targetPrice, priceThresholdPct);
  if (currentPriceNum > threshold) {
    console.log(`[SKIP] ${symbol} - 当前价 ${currentPriceNum} 超出阈值上限 ${threshold}`);
    return;
  }

  const balance = balances[0];
  const buyPower = balance?.buyingPower ?? 0;
  const netAssets = balance?.netAssets ?? 0;
  if (buyPower <= 0) {
    console.log(`[SKIP] ${symbol} - 账户购买力不足（货币: ${currency}）`);
    return;
  }

  const sizing = calculateBuyQuantity({
    buyPower,
    netAssets,
    buyPct,
    riskPctPerTrade,
    maxPositionPct,
    existingPositionValue: holding ? holding.quantity * currentPriceNum : 0,
    entryPrice: threshold,
    stopLoss: record.stop_loss,
    lotSize,
  });
  const qty = sizing.quantity;
  if (qty <= 0) {
    console.log(
      `[SKIP] ${symbol} - 计算数量为 0（资金上限 ${sizing.cashCapValue.toFixed(0)} ${currency}，风险模式 ${sizing.mode}，不足一手）`,
    );
    return;
  }

  console.log(
    `\n📋 ${isAddPosition ? "加仓" : "买入"} ${symbol} | 现价 ${currentPriceNum}（${priceSource}）→ 限价 ${colors.yellow(threshold)}（${priceThresholdPct}% 阈值）`,
  );
  console.log(`   记录 #${record.id} · ${record.created_at}`);
  if (holding) {
    console.log(
      `   持仓 ${colors.cyan(holding.quantity)} 股 @ 成本 ${colors.yellow(holding.costPrice)}`,
    );
  }
  console.log(
    `   购买力 ${colors.cyan(buyPower.toFixed(0))} ${currency} | 资金上限 ${buyPct}% = ${sizing.cashCapValue.toFixed(0)} | 单笔风险 ${riskPctPerTrade}%`,
  );
  if (sizing.mode === "risk_budget") {
    console.log(
      `   风险预算 ${sizing.riskBudgetValue?.toFixed(0)} ${currency} | 单股风险 ${sizing.riskPerShare?.toFixed(2)} | 上限 ${colors.cyan(sizing.riskCapQuantity ?? "-")} 股`,
    );
  }
  if (sizing.positionCapValue != null) {
    console.log(
      `   单标的上限 ${maxPositionPct}% = ${sizing.positionCapValue.toFixed(0)} | 追加上限 ${colors.cyan(sizing.positionCapQuantity ?? "-")} 股`,
    );
  }
  const slTp: string[] = [];
  if (record.stop_loss) slTp.push(`SL ${colors.red(record.stop_loss)} (MIT)`);
  if (record.take_profit) slTp.push(`TP ${colors.green(record.take_profit)} (LIT)`);
  console.log(
    `   买入 ${colors.cyan(qty)} 股（${qty / lotSize} 手 × ${lotSize}）${slTp.length > 0 ? ` | ${slTp.join(" | ")}` : ""} | 10s 超时`,
  );

  if (!autoApprove) {
    const confirmed = await promptConfirm(
      `\n确认以 ${colors.yellow(threshold)} 买入 ${qty} 股？(Enter 确认 / Esc 取消): `,
    );
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return;
    }
  }

  const entryRequest = {
    instrument,
    type: "limit" as const,
    side: "buy" as const,
    timeInForce: "day" as const,
    quantity: qty,
    price: threshold,
    outsideRegularHours: true,
    remark: `auto-trade:buy:${record.id}`,
  };

  let buyDetail: BrokerOrder;
  if (isAddPosition) {
    const submitted = await broker.submitOrder(entryRequest);
    console.log(`[OK] 买入单已提交: ${submitted.id} @ ${threshold}`);
    console.log(`[WAIT] 等待限价买单 ${submitted.id} 成交... (10 秒超时)`);
    await broker.waitForTerminal(submitted.id, 10_000);
    buyDetail = await broker.getOrder(submitted.id);
  } else {
    const bracket = await broker.submitBracketOrder({
      entry: entryRequest,
      protection: {
        stopLoss: record.stop_loss ?? undefined,
        takeProfit: record.take_profit ?? undefined,
      },
      recordId: record.id,
      waitTimeoutMs: 10_000,
    });
    buyDetail = bracket.entryOrder;
    console.log(`[OK] 买入单已提交: ${buyDetail.id} @ ${threshold} | 保护模式 ${bracket.mode}`);
  }

  const buyOrderId = buyDetail.id;
  const buyFilledQty = buyDetail.executedQuantity;

  // buyFilledQty is the source of truth — the WS push status may be stale
  // when a race occurs between timeout-cancellation and exchange fill.
  if (buyFilledQty <= 0) {
    console.log(`[SKIP] 限价单 ${buyOrderId} 未成交 (状态: ${buyDetail.status})，跳过`);
    return;
  }
  if (buyDetail.status !== "filled") {
    console.warn(
      `[RACE] 限价单 ${buyOrderId} 状态 ${buyDetail.status} 但实际已成交 ${buyFilledQty}/${qty} 股（取消与成交竞态），以实际成交数量为准`,
    );
  } else {
    console.log(`[OK] 限价买单已成交: ${buyOrderId}`);
  }

  if (isAddPosition && holding) {
    await syncSlTpAfterBuy(
      cfg,
      instrument,
      record,
      holding.quantity + buyFilledQty,
      plan.existingSlOrder,
      plan.existingTpOrder,
    );
    return;
  }

  // New positions use submitBracketOrder, which has already attached protection orders.
}

async function executeUpdateBuy(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { broker, autoApprove, priceThresholdPct } = cfg;
  const { symbol, record, pendingBuyOrder } = plan;
  // biome-ignore lint/style/noNonNullAssertion: buy signals always have ideal_buy
  const targetPrice = record.ideal_buy!;

  if (!pendingBuyOrder) {
    console.log(`[SKIP] ${symbol} - UPDATE_BUY 但无 pending 买单`);
    return;
  }

  printAnalysisRecord(record);

  const threshold = computeBuyLimitPrice(targetPrice, priceThresholdPct);
  const pendingPrice = Number(pendingBuyOrder.price);
  const pendingQty = Number(pendingBuyOrder.quantity);

  console.log(
    `\n📋 更新买单 ${symbol} | 挂单 ${pendingPrice} → ${colors.yellow(threshold)} | ${colors.cyan(pendingQty)} 股`,
  );

  if (!autoApprove) {
    const confirmed = await promptConfirm(
      `\n确认修改买单 ${pendingBuyOrder.orderId} 价格为 ${threshold}？(Enter 确认 / Esc 取消): `,
    );
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return;
    }
  }

  try {
    await broker.replaceOrder({
      orderId: pendingBuyOrder.orderId,
      quantity: pendingQty,
      price: threshold,
      remark: `auto-trade:buy:${record.id}`,
    });
    console.log(`[OK] 买单 ${pendingBuyOrder.orderId} 已更新价格为 ${threshold}`);
  } catch (err) {
    console.error(`[ERR] 更新买单 ${pendingBuyOrder.orderId} 失败: ${err}`);
  }
}

async function executeCancelConflictingOrders(
  cfg: ExecutorConfig,
  plan: ActionPlan,
): Promise<void> {
  const { broker, autoApprove } = cfg;
  const ordersToCancel = dedupeOrdersById(plan.ordersToCancel ?? []);

  if (ordersToCancel.length === 0) {
    console.log(`[SKIP] ${plan.symbol} - 无冲突挂单需要取消`);
    return;
  }

  printAnalysisRecord(plan.record);

  console.log(`\n📋 取消冲突挂单 ${plan.symbol}（信号: ${plan.record.operation_advice ?? "-"}）`);
  console.log(`   记录 #${plan.record.id} · ${plan.record.created_at}`);
  for (const order of ordersToCancel) {
    console.log(`   ${order.orderId} ${order.role} @ ${order.price} × ${order.quantity}`);
  }

  if (!autoApprove) {
    const confirmed = await promptConfirm(
      `\n确认取消 ${ordersToCancel.length} 个冲突挂单？(Enter 确认 / Esc 取消): `,
    );
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return;
    }
  }

  for (const order of ordersToCancel) {
    try {
      await broker.cancelOrder(order.orderId);
      console.log(`[CANCEL] 已取消冲突挂单 ${order.orderId} (${order.role})`);
    } catch (err) {
      console.error(`[ERR] 取消冲突挂单 ${order.orderId} 失败: ${err}`);
    }
  }
}

async function executeSell(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { broker, marketData, autoApprove, sellPct: cfgSellPct } = cfg;
  const { instrument, symbol, record, holding, action } = plan;

  if (!holding) {
    console.log(`[SKIP] ${symbol} - 无持仓`);
    return;
  }

  printAnalysisRecord(record);

  const isPartial = action === "SELL_PARTIAL";
  const sellPct = plan.sellPct ?? cfgSellPct;

  // Get lot size
  const staticInfos = await marketData.getInstrumentInfo([instrument]);
  const lotSize = staticInfos.length > 0 ? staticInfos[0].lotSize : 1;

  let sellQty: number;
  if (isPartial) {
    const reduceQty = Math.floor((holding.availableQuantity * sellPct) / 100 / lotSize) * lotSize;
    sellQty = reduceQty;
    console.log(
      `📉 减仓模式: 可卖 ${holding.availableQuantity} 股, 减持 ${sellPct}% = ${sellQty} 股`,
    );
  } else {
    sellQty = holding.availableQuantity;
    console.log(`📉 清仓模式: 可卖 ${holding.availableQuantity} 股`);
  }

  if (sellQty <= 0) {
    console.log(`[SKIP] ${symbol} - 计算卖出数量为 0`);
    return;
  }

  // Cancel existing SL/TP orders (atomic: cancel first, then sell)
  const slTpToCancel = getSlTpOrdersForSymbol(cfg, symbol, plan);
  const cancelledOrderIds: string[] = [];

  for (const slTp of slTpToCancel) {
    try {
      await broker.cancelOrder(slTp.orderId);
      console.log(`[CANCEL] 已取消 ${slTp.role} 订单 ${slTp.orderId}`);
      cancelledOrderIds.push(slTp.orderId);
    } catch (err) {
      console.error(`[WARN] 取消 ${slTp.role} 订单 ${slTp.orderId} 失败: ${err}`);
    }
  }

  if (slTpToCancel.length > 0) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // Get effective sell price
  const { price: currentPrice, source: priceSource } = await getEffectivePrice(
    marketData,
    instrument,
    "sell",
  );
  const costPrice = holding.costPrice;

  if (currentPrice <= 0) {
    console.log(`[SKIP] ${symbol} - 无法获取有效现价`);
    // Rollback: re-create cancelled SL/TP
    if (cancelledOrderIds.length > 0) {
      await rollbackSlTp(cfg, instrument, record, holding.quantity);
    }
    return;
  }

  // Use bid1 as sell price
  const sellPrice = currentPrice;

  console.log(
    `\n📋 ${isPartial ? "减仓" : "清仓"} ${symbol} | 现价 ${currentPrice}（${priceSource}）→ 卖出 ${colors.yellow(sellPrice)} | ${colors.cyan(sellQty)} 股`,
  );
  console.log(`   记录 #${record.id} · ${record.created_at}`);
  console.log(`   成本 ${colors.yellow(costPrice)}`);

  if (!autoApprove) {
    const confirmed = await promptConfirm(
      `\n确认以 ${colors.yellow(sellPrice)} 卖出 ${sellQty} 股？(Enter 确认 / Esc 取消): `,
    );
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      // Rollback: re-create cancelled SL/TP
      if (cancelledOrderIds.length > 0) {
        await rollbackSlTp(cfg, instrument, record, holding.quantity);
      }
      return;
    }
  }

  const remark = isPartial ? `auto-trade:reduce:${record.id}` : `auto-trade:sell:${record.id}`;

  try {
    const resp = await broker.submitOrder({
      instrument,
      type: "limit",
      side: "sell",
      timeInForce: "day",
      quantity: sellQty,
      price: sellPrice,
      outsideRegularHours: true,
      remark,
    });

    console.log(
      `[OK] 卖出单已提交: ${resp.id} (${isPartial ? "减仓" : "清仓"} ${sellQty} 股 @ ${sellPrice})`,
    );

    // Wait for sell order to reach terminal state
    const sellTimeout = 30_000;
    console.log(`[WAIT] 等待限价卖单 ${resp.id} 成交... (${sellTimeout / 1000} 秒超时)`);
    await broker.waitForTerminal(resp.id, sellTimeout);
    const filledDetail = await broker.getOrder(resp.id);
    const filledQty = filledDetail.executedQuantity;
    const remainingQty = getRemainingPositionQuantity(holding.quantity, filledQty);

    if (filledDetail.status === "filled") {
      console.log(`[OK] 限价卖单 ${resp.id} 已成交`);
    } else {
      if (filledQty > 0) {
        console.log(`[WARN] 限价卖单 ${resp.id} 部分成交 ${filledQty}/${sellQty} 股`);
      } else {
        console.log(`[SKIP] 限价卖单 ${resp.id} 未成交，跳过`);
      }
    }

    if (cancelledOrderIds.length > 0 && remainingQty > 0) {
      console.log(`[RECOVER] ${symbol} 剩余 ${remainingQty} 股，重挂 SL/TP`);
      await rollbackSlTp(cfg, instrument, record, remainingQty);
    }
  } catch (err) {
    console.error(`[ERR] 卖出单提交失败: ${err}`);
    // Rollback: re-create cancelled SL/TP
    if (cancelledOrderIds.length > 0) {
      await rollbackSlTp(cfg, instrument, record, holding.quantity);
    }
  }
}

async function executeSyncSlTp(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { broker, autoApprove } = cfg;
  const { instrument, symbol, record, holding, existingSlOrder, existingTpOrder } = plan;

  if (!holding) {
    console.log(`[SKIP] ${symbol} - 无持仓`);
    return;
  }

  printAnalysisRecord(record);

  const changes: string[] = [];
  if (existingSlOrder) {
    const oldTrigger = Number(existingSlOrder.triggerPrice);
    const newTrigger = record.stop_loss;
    const oldQty = Number(existingSlOrder.quantity);
    if (oldTrigger !== newTrigger)
      changes.push(`止损价 ${oldTrigger} → ${colors.red(newTrigger ?? "-")}`);
    if (oldQty !== holding.quantity)
      changes.push(`止损量 ${oldQty} → ${colors.cyan(holding.quantity)}`);
  }
  if (existingTpOrder) {
    const oldTrigger = Number(existingTpOrder.triggerPrice);
    const newTrigger = record.take_profit;
    const oldQty = Number(existingTpOrder.quantity);
    if (oldTrigger !== newTrigger)
      changes.push(`止盈价 ${oldTrigger} → ${colors.green(newTrigger ?? "-")}`);
    if (oldQty !== holding.quantity)
      changes.push(`止盈量 ${oldQty} → ${colors.cyan(holding.quantity)}`);
  }

  console.log(`\n📋 同步 SL/TP ${symbol}（${colors.cyan(holding.quantity)} 股）`);
  console.log(`   记录 #${record.id} · ${record.created_at}`);
  for (const c of changes) {
    console.log(`   ${c}`);
  }

  if (!autoApprove) {
    const confirmed = await promptConfirm(`\n确认同步 SL/TP？(Enter 确认 / Esc 取消): `);
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return;
    }
  }

  try {
    await broker.syncProtectionOrders({
      instrument,
      quantity: holding.quantity,
      recordId: record.id,
      stopLoss: record.stop_loss ?? undefined,
      takeProfit: record.take_profit ?? undefined,
      existing: toProtectionOrderIds(existingSlOrder, existingTpOrder),
    });

    if (existingSlOrder && record.stop_loss != null) {
      console.log(
        `[OK] 止损单 ${existingSlOrder.orderId} 已同步: 数量=${holding.quantity}, 触发价=${record.stop_loss}`,
      );
    }
    if (existingTpOrder && record.take_profit != null) {
      console.log(
        `[OK] 止盈单 ${existingTpOrder.orderId} 已同步: 数量=${holding.quantity}, 触发价=${record.take_profit}`,
      );
    }
  } catch (err) {
    console.error(`[ERR] 同步 ${symbol} SL/TP 失败: ${err}`);
  }
}

async function executeRecoverSlTp(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { autoApprove } = cfg;
  const { instrument, symbol, record, holding, existingSlOrder, existingTpOrder } = plan;

  if (!holding) {
    console.log(`[SKIP] ${symbol} - 无持仓`);
    return;
  }

  printAnalysisRecord(record);

  const missingSl = record.stop_loss != null && !existingSlOrder;
  const missingTp = record.take_profit != null && !existingTpOrder;

  const missing: string[] = [];
  if (missingSl) missing.push(`SL ${colors.red(record.stop_loss ?? "-")}`);
  if (missingTp) missing.push(`TP ${colors.green(record.take_profit ?? "-")}`);
  console.log(
    `\n📋 补挂 SL/TP ${symbol}（${colors.cyan(holding.quantity)} 股）: ${missing.join(" · ")}`,
  );

  if (!autoApprove) {
    const confirmed = await promptConfirm(`\n确认补挂 SL/TP？(Enter 确认 / Esc 取消): `);
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return;
    }
  }

  await cfg.broker.submitProtectionOrders({
    instrument,
    quantity: holding.quantity,
    recordId: record.id,
    stopLoss: missingSl ? (record.stop_loss ?? undefined) : undefined,
    takeProfit: missingTp ? (record.take_profit ?? undefined) : undefined,
  });
}

async function executeMergeSlTp(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { broker, autoApprove } = cfg;
  const { instrument, symbol, record, holding, ordersToCancel } = plan;

  if (!holding) {
    console.log(`[SKIP] ${symbol} - 无持仓`);
    return;
  }

  if (!ordersToCancel || ordersToCancel.length === 0) {
    console.log(`[SKIP] ${symbol} - 无重复 SL/TP 需合并`);
    return;
  }

  printAnalysisRecord(record);

  const slCount = ordersToCancel.filter((o) => o.role === "stop_loss").length;
  const tpCount = ordersToCancel.filter((o) => o.role === "take_profit").length;

  const newSlTp: string[] = [];
  if (record.stop_loss != null) newSlTp.push(`SL ${colors.red(record.stop_loss)}`);
  if (record.take_profit != null) newSlTp.push(`TP ${colors.green(record.take_profit)}`);
  console.log(
    `\n📋 合并 SL/TP ${symbol}（${colors.cyan(holding.quantity)} 股）: ${slCount} SL + ${tpCount} TP → ${newSlTp.join(" · ")}`,
  );

  if (!autoApprove) {
    const confirmed = await promptConfirm(
      `\n确认取消 ${ordersToCancel.length} 个重复 SL/TP 并重新挂一对？(Enter 确认 / Esc 取消): `,
    );
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return;
    }
  }

  // Step 1: Cancel all duplicate orders
  let allCancelled = true;
  for (const order of ordersToCancel) {
    try {
      await broker.cancelOrder(order.orderId);
      console.log(`[CANCEL] 已取消 ${order.role} 订单 ${order.orderId}`);
    } catch (err) {
      console.error(`[ERR] 取消 ${order.role} 订单 ${order.orderId} 失败: ${err}`);
      allCancelled = false;
    }
  }

  if (!allCancelled) {
    console.warn(`[WARN] 部分订单取消失败，跳过重新挂单（需手动处理 ${symbol} 的 SL/TP）`);
    return;
  }

  // Brief pause to let exchange process cancellations
  if (ordersToCancel.length > 0) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // Step 2: Re-submit one pair using signal prices
  await submitSlTp(cfg, instrument, record, holding.quantity);
}

// ── SL/TP helpers ─────────────────────────────────────────────────────────────

async function submitSlTp(
  cfg: ExecutorConfig,
  instrument: Instrument,
  record: AnalysisRecord,
  quantity: number,
): Promise<void> {
  const ids = await cfg.broker.submitProtectionOrders({
    instrument,
    quantity,
    recordId: record.id,
    stopLoss: record.stop_loss ?? undefined,
    takeProfit: record.take_profit ?? undefined,
  });
  if (ids.stopLossOrderId) {
    console.log(`[OK] 止损单已提交: ${ids.stopLossOrderId} (触发价: ${record.stop_loss})`);
  }
  if (ids.takeProfitOrderId) {
    console.log(`[OK] 止盈单已提交: ${ids.takeProfitOrderId} (触发价: ${record.take_profit})`);
  }
}

async function syncSlTpAfterBuy(
  cfg: ExecutorConfig,
  instrument: Instrument,
  record: AnalysisRecord,
  quantity: number,
  existingSlOrder: ActiveOrder | undefined,
  existingTpOrder: ActiveOrder | undefined,
): Promise<void> {
  const symbol = instrument.symbol;
  console.log(`[SYNC] ${symbol} 加仓成交后同步 SL/TP 到总持仓 ${quantity} 股`);

  const stopLoss = record.stop_loss ?? optionalPositiveNumber(existingSlOrder?.triggerPrice);
  const takeProfit = record.take_profit ?? optionalPositiveNumber(existingTpOrder?.triggerPrice);
  const ids = await cfg.broker.syncProtectionOrders({
    instrument,
    quantity,
    recordId: record.id,
    stopLoss,
    takeProfit,
    existing: toProtectionOrderIds(existingSlOrder, existingTpOrder),
  });

  if (existingSlOrder && stopLoss != null) {
    console.log(
      `[OK] 止损单 ${existingSlOrder.orderId} 已同步: 数量=${quantity}, 触发价=${stopLoss}`,
    );
  } else if (ids.stopLossOrderId) {
    console.log(`[OK] 止损单已提交: ${ids.stopLossOrderId} (触发价: ${stopLoss})`);
  } else {
    console.warn(`[WARN] ${symbol} 加仓后缺少止损价，无法补挂止损`);
  }

  if (existingTpOrder && takeProfit != null) {
    console.log(
      `[OK] 止盈单 ${existingTpOrder.orderId} 已同步: 数量=${quantity}, 触发价=${takeProfit}`,
    );
  } else if (ids.takeProfitOrderId) {
    console.log(`[OK] 止盈单已提交: ${ids.takeProfitOrderId} (触发价: ${takeProfit})`);
  }
}

/**
 * Get SL/TP orders from the portfolio's active orders for a symbol.
 */
function getSlTpOrdersForSymbol(
  _cfg: ExecutorConfig,
  _symbol: string,
  plan: ActionPlan,
): ActiveOrder[] {
  if (plan.ordersToCancel && plan.ordersToCancel.length > 0) {
    return dedupeOrdersById(plan.ordersToCancel);
  }

  const result: ActiveOrder[] = [];
  if (plan.existingSlOrder) result.push(plan.existingSlOrder);
  if (plan.existingTpOrder) result.push(plan.existingTpOrder);
  return dedupeOrdersById(result);
}

/**
 * Rollback: re-create SL/TP orders with original parameters after a failed sell.
 * This is the last resort — if rollback also fails, print a loud warning.
 */
async function rollbackSlTp(
  cfg: ExecutorConfig,
  instrument: Instrument,
  record: AnalysisRecord,
  quantity: number,
): Promise<void> {
  const symbol = instrument.symbol;
  console.warn(`[ROLLBACK] 尝试为 ${symbol} 重新挂 SL/TP...`);
  try {
    await submitSlTp(cfg, instrument, record, quantity);
    console.log(`[ROLLBACK] ${symbol} SL/TP 补挂成功`);
  } catch (_err) {
    console.error(`\n${"!".repeat(80)}`);
    console.error(`[CRITICAL] ${symbol} 回滚失败！持仓现为裸仓（无止损保护）！`);
    console.error(`[CRITICAL] 请手动在交易账户中为 ${symbol} 设置止损/止盈`);
    console.error(
      `[CRITICAL] 原始止损: ${record.stop_loss ?? "无"} | 原始止盈: ${record.take_profit ?? "无"}`,
    );
    console.error(`${"!".repeat(80)}\n`);
  }
}

function optionalPositiveNumber(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function toProtectionOrderIds(
  stopLossOrder: ActiveOrder | undefined,
  takeProfitOrder: ActiveOrder | undefined,
): ProtectionOrderIds {
  return {
    stopLossOrderId: stopLossOrder?.orderId,
    takeProfitOrderId: takeProfitOrder?.orderId,
  };
}

function dedupeOrdersById(orders: ActiveOrder[]): ActiveOrder[] {
  const seen = new Set<string>();
  const result: ActiveOrder[] = [];

  for (const order of orders) {
    if (seen.has(order.orderId)) continue;
    seen.add(order.orderId);
    result.push(order);
  }

  return result;
}

export function getRemainingPositionQuantity(
  holdingQuantity: number,
  filledQuantity: number,
): number {
  return Math.max(0, holdingQuantity - filledQuantity);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute a single action plan. Throws FatalError for unrecoverable errors
 * (e.g. insufficient balance), returns normally for all other cases.
 */
export async function executeAction(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  switch (plan.action) {
    case "CANCEL_CONFLICTING_ORDERS":
      await executeCancelConflictingOrders(cfg, plan);
      break;
    case "NEW_BUY":
    case "ADD_POSITION":
      await executeBuy(cfg, plan);
      break;
    case "UPDATE_BUY":
      await executeUpdateBuy(cfg, plan);
      break;
    case "SELL_FULL":
    case "SELL_PARTIAL":
      await executeSell(cfg, plan);
      break;
    case "SYNC_SL_TP":
      await executeSyncSlTp(cfg, plan);
      break;
    case "RECOVER_SL_TP":
      await executeRecoverSlTp(cfg, plan);
      break;
    case "MERGE_SL_TP":
      await executeMergeSlTp(cfg, plan);
      break;
    case "HOLD":
      console.log(`[HOLD] ${plan.symbol} 持仓 + SL/TP 已匹配，不操作`);
      break;
  }
}
