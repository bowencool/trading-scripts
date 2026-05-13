import {
  Decimal,
  OrderSide,
  OrderStatus,
  OrderType,
  OutsideRTH,
  type QuoteContext,
  TimeInForceType,
  type TradeContext,
} from "longbridge";
import { promptConfirm } from "./confirm.js";
import type { OrderWatcher } from "./order-watcher.js";
import { calculateBuyQuantity } from "./position-sizing.js";
import { computeBuyLimitPrice } from "./pricing.js";
import type { ActionPlan, ActiveOrder, AnalysisRecord } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExecutorConfig {
  quoteCtx: QuoteContext;
  tradeCtx: TradeContext;
  orderWatcher: OrderWatcher;
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

function getCurrency(symbol: string): string | null {
  if (symbol.endsWith(".HK")) return "HKD";
  if (symbol.endsWith(".US")) return "USD";
  if (symbol.endsWith(".SH") || symbol.endsWith(".SZ")) return "CNY";
  if (symbol.endsWith(".SG")) return "SGD";
  return null;
}

/**
 * Get the best available price for a symbol.
 * For buy side: prefer ask1 (卖一价) → pre/post/overnight → lastDone.
 * For sell side: prefer bid1 (买一价) → pre/post/overnight → lastDone.
 */
async function getEffectivePrice(
  quoteCtx: QuoteContext,
  symbol: string,
  side: "buy" | "sell",
): Promise<{ price: number; source: string }> {
  try {
    const depth = await quoteCtx.depth(symbol);
    const entries = side === "buy" ? depth.asks : depth.bids;
    const first = entries[0];
    if (first?.price) {
      const depthPrice = Number(first.price.toString());
      if (depthPrice > 0) {
        return { price: depthPrice, source: side === "buy" ? "卖一" : "买一" };
      }
    }
  } catch {
    // depth API may not be available for all symbols
  }

  const quotes = await quoteCtx.quote([symbol]);
  if (quotes.length > 0) {
    const q = quotes[0];
    for (const [key, label] of [
      ["preMarketQuote", "盘前"],
      ["postMarketQuote", "盘后"],
      ["overnightQuote", "夜盘"],
    ] as const) {
      const pq = q[key];
      if (pq) {
        const p = Number(pq.lastDone.toString());
        if (p > 0) return { price: p, source: label };
      }
    }
    const lastDone = Number(q.lastDone.toString());
    if (lastDone > 0) return { price: lastDone, source: "lastDone" };
  }

  return { price: 0, source: "N/A" };
}

function printAnalysisRecord(record: AnalysisRecord): void {
  console.log(`\n🔹 [${record.code}] ${record.name ?? "未知"} (${record.report_type ?? "-"})`);

  const parts: string[] = [];
  if (record.sentiment_score != null) parts.push(`\x1b[36m${record.sentiment_score}\x1b[0m`);
  if (record.operation_advice) parts.push(record.operation_advice);
  if (record.trend_prediction) parts.push(record.trend_prediction);
  if (parts.length > 0) console.log(`   评分 ${parts.join(" · ")}`);

  const prices: string[] = [];
  if (record.ideal_buy != null) prices.push(`理想 \x1b[33m${record.ideal_buy}\x1b[0m`);
  if (record.secondary_buy != null) prices.push(`次选 \x1b[33m${record.secondary_buy}\x1b[0m`);
  if (record.stop_loss != null) prices.push(`SL \x1b[31m${record.stop_loss}\x1b[0m`);
  if (record.take_profit != null) prices.push(`TP \x1b[32m${record.take_profit}\x1b[0m`);
  if (prices.length > 0) console.log(`   ${prices.join(" · ")}`);

  if (record.analysis_summary) {
    console.log(`   ${record.analysis_summary}`);
  }
}

const MAX_SUBMIT_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

async function submitWithRetry(
  submitFn: () => Promise<{ orderId: string }>,
  label: string,
  symbol: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt <= MAX_SUBMIT_RETRIES; attempt++) {
    try {
      const resp = await submitFn();
      return resp.orderId;
    } catch (err) {
      if (attempt < MAX_SUBMIT_RETRIES) {
        console.warn(
          `[RETRY] ${label} ${symbol} 第 ${attempt + 1} 次提交失败: ${err}，${RETRY_DELAY_MS}ms 后重试...`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(
          `[ERR] ${label} ${symbol} 提交失败（已重试 ${MAX_SUBMIT_RETRIES} 次）: ${err}`,
        );
      }
    }
  }
  return undefined;
}

// ── Action executors ──────────────────────────────────────────────────────────

async function executeBuy(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const {
    quoteCtx,
    tradeCtx,
    orderWatcher,
    autoApprove,
    buyPct,
    riskPctPerTrade,
    maxPositionPct,
    priceThresholdPct,
  } = cfg;
  const { symbol, record, holding } = plan;
  const isAddPosition = plan.action === "ADD_POSITION";
  // biome-ignore lint/style/noNonNullAssertion: buy signals always have ideal_buy
  const targetPrice = record.ideal_buy!;

  printAnalysisRecord(record);

  const currency = getCurrency(symbol);
  if (!currency) {
    console.log(`[SKIP] ${symbol} - 未知货币后缀`);
    return;
  }

  const [staticInfos, balances] = await Promise.all([
    quoteCtx.staticInfo([symbol]),
    tradeCtx.accountBalance(currency),
  ]);

  const { price: currentPriceNum, source: priceSource } = await getEffectivePrice(
    quoteCtx,
    symbol,
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
  const buyPower = balance ? Number(balance.buyPower.toString()) : 0;
  const netAssets = balance ? Number(balance.netAssets.toString()) : 0;
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
    `\n📋 ${isAddPosition ? "加仓" : "买入"} ${symbol} | 现价 ${currentPriceNum}（${priceSource}）→ 限价 \x1b[33m${threshold}\x1b[0m（${priceThresholdPct}% 阈值）`,
  );
  console.log(`   记录 #${record.id} · ${record.created_at}`);
  if (holding) {
    console.log(
      `   持仓 \x1b[36m${holding.quantity}\x1b[0m 股 @ 成本 \x1b[33m${holding.costPrice}\x1b[0m`,
    );
  }
  console.log(
    `   购买力 \x1b[36m${buyPower.toFixed(0)}\x1b[0m ${currency} | 资金上限 ${buyPct}% = ${sizing.cashCapValue.toFixed(0)} | 单笔风险 ${riskPctPerTrade}%`,
  );
  if (sizing.mode === "risk_budget") {
    console.log(
      `   风险预算 ${sizing.riskBudgetValue?.toFixed(0)} ${currency} | 单股风险 ${sizing.riskPerShare?.toFixed(2)} | 上限 \x1b[36m${sizing.riskCapQuantity}\x1b[0m 股`,
    );
  }
  if (sizing.positionCapValue != null) {
    console.log(
      `   单标的上限 ${maxPositionPct}% = ${sizing.positionCapValue.toFixed(0)} | 追加上限 \x1b[36m${sizing.positionCapQuantity}\x1b[0m 股`,
    );
  }
  const slTp: string[] = [];
  if (record.stop_loss) slTp.push(`SL \x1b[31m${record.stop_loss}\x1b[0m (MIT)`);
  if (record.take_profit) slTp.push(`TP \x1b[32m${record.take_profit}\x1b[0m (LIT)`);
  console.log(
    `   买入 \x1b[36m${qty}\x1b[0m 股（${qty / lotSize} 手 × ${lotSize}）${slTp.length > 0 ? ` | ${slTp.join(" | ")}` : ""} | 10s 超时`,
  );

  if (!autoApprove) {
    const confirmed = await promptConfirm(
      `\n确认以 \x1b[33m${threshold}\x1b[0m 买入 ${qty} 股？(Enter 确认 / Esc 取消): `,
    );
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return;
    }
  }

  const buyResp = await tradeCtx.submitOrder({
    symbol,
    orderType: OrderType.LO,
    side: OrderSide.Buy,
    timeInForce: TimeInForceType.Day,
    submittedQuantity: new Decimal(String(qty)),
    submittedPrice: new Decimal(String(threshold)),
    outsideRth: OutsideRTH.AnyTime,
    remark: `auto-trade:buy:${record.id}`,
  });

  const buyOrderId = buyResp.orderId;
  console.log(`[OK] 买入单已提交: ${buyOrderId} @ ${threshold}`);

  // Wait for buy order to fill within 10 seconds
  console.log(`[WAIT] 等待限价买单 ${buyOrderId} 成交... (10 秒超时)`);
  const buyEvent = await orderWatcher.waitForTerminal(buyOrderId, 10_000);

  const buyDetail = await tradeCtx.orderDetail(buyOrderId);
  const buyFilledQty = Number(buyDetail.executedQuantity.toString());

  // buyFilledQty is the source of truth — the WS push status may be stale
  // when a race occurs between timeout-cancellation and exchange fill.
  if (buyFilledQty <= 0) {
    console.log(`[SKIP] 限价单 ${buyOrderId} 未成交 (WS 状态: ${buyEvent.status})，跳过`);
    return;
  }
  if (buyEvent.status !== OrderStatus.Filled) {
    console.warn(
      `[RACE] 限价单 ${buyOrderId} WS 状态 ${buyEvent.status} 但实际已成交 ${buyFilledQty}/${qty} 股（取消与成交竞态），以实际成交数量为准`,
    );
  } else {
    console.log(`[OK] 限价买单已成交: ${buyOrderId}`);
  }

  if (isAddPosition && holding) {
    await syncSlTpAfterBuy(
      cfg,
      symbol,
      record,
      holding.quantity + buyFilledQty,
      plan.existingSlOrder,
      plan.existingTpOrder,
    );
    return;
  }

  await submitSlTp(cfg, symbol, record, buyFilledQty);
}

async function executeUpdateBuy(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { tradeCtx, autoApprove, priceThresholdPct } = cfg;
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
    `\n📋 更新买单 ${symbol} | 挂单 ${pendingPrice} → \x1b[33m${threshold}\x1b[0m | \x1b[36m${pendingQty}\x1b[0m 股`,
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
    await tradeCtx.replaceOrder({
      orderId: pendingBuyOrder.orderId,
      quantity: new Decimal(String(pendingQty)),
      price: new Decimal(String(threshold)),
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
  const { tradeCtx, autoApprove } = cfg;
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
      await tradeCtx.cancelOrder(order.orderId);
      console.log(`[CANCEL] 已取消冲突挂单 ${order.orderId} (${order.role})`);
    } catch (err) {
      console.error(`[ERR] 取消冲突挂单 ${order.orderId} 失败: ${err}`);
    }
  }
}

async function executeSell(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { tradeCtx, quoteCtx, autoApprove, sellPct: cfgSellPct } = cfg;
  const { symbol, record, holding, action } = plan;

  if (!holding) {
    console.log(`[SKIP] ${symbol} - 无持仓`);
    return;
  }

  printAnalysisRecord(record);

  const isPartial = action === "SELL_PARTIAL";
  const sellPct = plan.sellPct ?? cfgSellPct;

  // Get lot size
  const staticInfos = await quoteCtx.staticInfo([symbol]);
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
      await tradeCtx.cancelOrder(slTp.orderId);
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
    quoteCtx,
    symbol,
    "sell",
  );
  const costPrice = holding.costPrice;

  if (currentPrice <= 0) {
    console.log(`[SKIP] ${symbol} - 无法获取有效现价`);
    // Rollback: re-create cancelled SL/TP
    if (cancelledOrderIds.length > 0) {
      await rollbackSlTp(cfg, symbol, record, holding.quantity);
    }
    return;
  }

  // Use bid1 as sell price
  const sellPrice = currentPrice;

  console.log(
    `\n📋 ${isPartial ? "减仓" : "清仓"} ${symbol} | 现价 ${currentPrice}（${priceSource}）→ 卖出 \x1b[33m${sellPrice}\x1b[0m | \x1b[36m${sellQty}\x1b[0m 股`,
  );
  console.log(`   记录 #${record.id} · ${record.created_at}`);
  console.log(`   成本 \x1b[33m${costPrice}\x1b[0m`);

  if (!autoApprove) {
    const confirmed = await promptConfirm(
      `\n确认以 \x1b[33m${sellPrice}\x1b[0m 卖出 ${sellQty} 股？(Enter 确认 / Esc 取消): `,
    );
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      // Rollback: re-create cancelled SL/TP
      if (cancelledOrderIds.length > 0) {
        await rollbackSlTp(cfg, symbol, record, holding.quantity);
      }
      return;
    }
  }

  const remark = isPartial ? `auto-trade:reduce:${record.id}` : `auto-trade:sell:${record.id}`;

  try {
    const resp = await tradeCtx.submitOrder({
      symbol,
      orderType: OrderType.LO,
      side: OrderSide.Sell,
      timeInForce: TimeInForceType.Day,
      submittedQuantity: new Decimal(String(sellQty)),
      submittedPrice: new Decimal(String(sellPrice)),
      outsideRth: OutsideRTH.AnyTime,
      remark,
    });

    console.log(
      `[OK] 卖出单已提交: ${resp.orderId} (${isPartial ? "减仓" : "清仓"} ${sellQty} 股 @ ${sellPrice})`,
    );

    // Wait for sell order to reach terminal state
    const sellTimeout = 30_000;
    console.log(`[WAIT] 等待限价卖单 ${resp.orderId} 成交... (${sellTimeout / 1000} 秒超时)`);
    const sellEvent = await cfg.orderWatcher.waitForTerminal(resp.orderId, sellTimeout);
    const filledDetail = await tradeCtx.orderDetail(resp.orderId);
    const filledQty = Number(filledDetail.executedQuantity.toString());
    const remainingQty = getRemainingPositionQuantity(holding.quantity, filledQty);

    if (sellEvent.status === OrderStatus.Filled) {
      console.log(`[OK] 限价卖单 ${resp.orderId} 已成交`);
    } else {
      if (filledQty > 0) {
        console.log(`[WARN] 限价卖单 ${resp.orderId} 部分成交 ${filledQty}/${sellQty} 股`);
      } else {
        console.log(`[SKIP] 限价卖单 ${resp.orderId} 未成交，跳过`);
      }
    }

    if (cancelledOrderIds.length > 0 && remainingQty > 0) {
      console.log(`[RECOVER] ${symbol} 剩余 ${remainingQty} 股，重挂 SL/TP`);
      await rollbackSlTp(cfg, symbol, record, remainingQty);
    }
  } catch (err) {
    console.error(`[ERR] 卖出单提交失败: ${err}`);
    // Rollback: re-create cancelled SL/TP
    if (cancelledOrderIds.length > 0) {
      await rollbackSlTp(cfg, symbol, record, holding.quantity);
    }
  }
}

async function executeSyncSlTp(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { tradeCtx, autoApprove } = cfg;
  const { symbol, record, holding, existingSlOrder, existingTpOrder } = plan;

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
      changes.push(`止损价 ${oldTrigger} → \x1b[31m${newTrigger}\x1b[0m`);
    if (oldQty !== holding.quantity)
      changes.push(`止损量 ${oldQty} → \x1b[36m${holding.quantity}\x1b[0m`);
  }
  if (existingTpOrder) {
    const oldTrigger = Number(existingTpOrder.triggerPrice);
    const newTrigger = record.take_profit;
    const oldQty = Number(existingTpOrder.quantity);
    if (oldTrigger !== newTrigger)
      changes.push(`止盈价 ${oldTrigger} → \x1b[32m${newTrigger}\x1b[0m`);
    if (oldQty !== holding.quantity)
      changes.push(`止盈量 ${oldQty} → \x1b[36m${holding.quantity}\x1b[0m`);
  }

  console.log(`\n📋 同步 SL/TP ${symbol}（\x1b[36m${holding.quantity}\x1b[0m 股）`);
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

  // Replace SL order
  if (existingSlOrder && record.stop_loss != null) {
    try {
      await tradeCtx.replaceOrder({
        orderId: existingSlOrder.orderId,
        quantity: new Decimal(String(holding.quantity)),
        triggerPrice: new Decimal(String(record.stop_loss)),
        remark: `auto-trade:sl:${record.id}`,
      });
      console.log(
        `[OK] 止损单 ${existingSlOrder.orderId} 已同步: 数量=${holding.quantity}, 触发价=${record.stop_loss}`,
      );
    } catch (err) {
      console.error(`[ERR] 同步止损单 ${existingSlOrder.orderId} 失败: ${err}`);
    }
  }

  // Replace TP order
  if (existingTpOrder && record.take_profit != null) {
    try {
      await tradeCtx.replaceOrder({
        orderId: existingTpOrder.orderId,
        quantity: new Decimal(String(holding.quantity)),
        price: new Decimal(String(record.take_profit)),
        triggerPrice: new Decimal(String(record.take_profit)),
        remark: `auto-trade:tp:${record.id}`,
      });
      console.log(
        `[OK] 止盈单 ${existingTpOrder.orderId} 已同步: 数量=${holding.quantity}, 触发价=${record.take_profit}`,
      );
    } catch (err) {
      console.error(`[ERR] 同步止盈单 ${existingTpOrder.orderId} 失败: ${err}`);
    }
  }
}

async function executeRecoverSlTp(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { autoApprove } = cfg;
  const { symbol, record, holding, existingSlOrder, existingTpOrder } = plan;

  if (!holding) {
    console.log(`[SKIP] ${symbol} - 无持仓`);
    return;
  }

  printAnalysisRecord(record);

  const missingSl = record.stop_loss != null && !existingSlOrder;
  const missingTp = record.take_profit != null && !existingTpOrder;

  const missing: string[] = [];
  if (missingSl) missing.push(`SL \x1b[31m${record.stop_loss}\x1b[0m`);
  if (missingTp) missing.push(`TP \x1b[32m${record.take_profit}\x1b[0m`);
  console.log(
    `\n📋 补挂 SL/TP ${symbol}（\x1b[36m${holding.quantity}\x1b[0m 股）: ${missing.join(" · ")}`,
  );

  if (!autoApprove) {
    const confirmed = await promptConfirm(`\n确认补挂 SL/TP？(Enter 确认 / Esc 取消): `);
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return;
    }
  }

  await submitSlTpPartial(cfg, symbol, record, holding.quantity, missingSl, missingTp);
}

async function executeMergeSlTp(cfg: ExecutorConfig, plan: ActionPlan): Promise<void> {
  const { tradeCtx, autoApprove } = cfg;
  const { symbol, record, holding, ordersToCancel } = plan;

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
  if (record.stop_loss != null) newSlTp.push(`SL \x1b[31m${record.stop_loss}\x1b[0m`);
  if (record.take_profit != null) newSlTp.push(`TP \x1b[32m${record.take_profit}\x1b[0m`);
  console.log(
    `\n📋 合并 SL/TP ${symbol}（\x1b[36m${holding.quantity}\x1b[0m 股）: ${slCount} SL + ${tpCount} TP → ${newSlTp.join(" · ")}`,
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
      await tradeCtx.cancelOrder(order.orderId);
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
  await submitSlTp(cfg, symbol, record, holding.quantity);
}

// ── SL/TP helpers ─────────────────────────────────────────────────────────────

async function submitSlTp(
  cfg: ExecutorConfig,
  symbol: string,
  record: AnalysisRecord,
  quantity: number,
): Promise<void> {
  await submitSlTpPartial(
    cfg,
    symbol,
    record,
    quantity,
    record.stop_loss != null,
    record.take_profit != null,
  );
}

async function submitSlTpPartial(
  cfg: ExecutorConfig,
  symbol: string,
  record: AnalysisRecord,
  quantity: number,
  submitSl: boolean,
  submitTp: boolean,
): Promise<void> {
  let slOrderId: string | undefined;
  let tpOrderId: string | undefined;

  if (submitSl && record.stop_loss) {
    slOrderId = await submitWithRetry(
      () =>
        cfg.tradeCtx.submitOrder({
          symbol,
          orderType: OrderType.MIT,
          side: OrderSide.Sell,
          timeInForce: TimeInForceType.GoodTilCanceled,
          submittedQuantity: new Decimal(String(quantity)),
          triggerPrice: new Decimal(String(record.stop_loss)),
          outsideRth: OutsideRTH.AnyTime,
          remark: `auto-trade:sl:${record.id}`,
        }),
      "止损单",
      symbol,
    );
    if (slOrderId) {
      console.log(`[OK] 止损单已提交: ${slOrderId} (触发价: ${record.stop_loss})`);
    }
  }

  if (submitTp && record.take_profit) {
    tpOrderId = await submitWithRetry(
      () =>
        cfg.tradeCtx.submitOrder({
          symbol,
          orderType: OrderType.LIT,
          side: OrderSide.Sell,
          timeInForce: TimeInForceType.GoodTilCanceled,
          submittedQuantity: new Decimal(String(quantity)),
          triggerPrice: new Decimal(String(record.take_profit)),
          submittedPrice: new Decimal(String(record.take_profit)),
          outsideRth: OutsideRTH.AnyTime,
          remark: `auto-trade:tp:${record.id}`,
        }),
      "止盈单",
      symbol,
    );
    if (tpOrderId) {
      console.log(`[OK] 止盈单已提交: ${tpOrderId} (触发价: ${record.take_profit})`);
    }
  }
}

async function syncSlTpAfterBuy(
  cfg: ExecutorConfig,
  symbol: string,
  record: AnalysisRecord,
  quantity: number,
  existingSlOrder: ActiveOrder | undefined,
  existingTpOrder: ActiveOrder | undefined,
): Promise<void> {
  console.log(`[SYNC] ${symbol} 加仓成交后同步 SL/TP 到总持仓 ${quantity} 股`);

  if (existingSlOrder) {
    const trigger = record.stop_loss ?? Number(existingSlOrder.triggerPrice);
    await cfg.tradeCtx.replaceOrder({
      orderId: existingSlOrder.orderId,
      quantity: new Decimal(String(quantity)),
      triggerPrice: new Decimal(String(trigger)),
      remark: `auto-trade:sl:${record.id}`,
    });
    console.log(
      `[OK] 止损单 ${existingSlOrder.orderId} 已同步: 数量=${quantity}, 触发价=${trigger}`,
    );
  } else if (record.stop_loss != null) {
    await submitSlTpPartial(cfg, symbol, record, quantity, true, false);
  } else {
    console.warn(`[WARN] ${symbol} 加仓后缺少止损价，无法补挂止损`);
  }

  if (existingTpOrder) {
    const trigger = record.take_profit ?? Number(existingTpOrder.triggerPrice);
    await cfg.tradeCtx.replaceOrder({
      orderId: existingTpOrder.orderId,
      quantity: new Decimal(String(quantity)),
      price: new Decimal(String(trigger)),
      triggerPrice: new Decimal(String(trigger)),
      remark: `auto-trade:tp:${record.id}`,
    });
    console.log(
      `[OK] 止盈单 ${existingTpOrder.orderId} 已同步: 数量=${quantity}, 触发价=${trigger}`,
    );
  } else if (record.take_profit != null) {
    await submitSlTpPartial(cfg, symbol, record, quantity, false, true);
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
  symbol: string,
  record: AnalysisRecord,
  quantity: number,
): Promise<void> {
  console.warn(`[ROLLBACK] 尝试为 ${symbol} 重新挂 SL/TP...`);
  try {
    await submitSlTp(cfg, symbol, record, quantity);
    console.log(`[ROLLBACK] ${symbol} SL/TP 补挂成功`);
  } catch (_err) {
    console.error(`\n${"!".repeat(80)}`);
    console.error(`[CRITICAL] ${symbol} 回滚失败！持仓现为裸仓（无止损保护）！`);
    console.error(`[CRITICAL] 请手动在 Longbridge App 中为 ${symbol} 设置止损/止盈`);
    console.error(
      `[CRITICAL] 原始止损: ${record.stop_loss ?? "无"} | 原始止盈: ${record.take_profit ?? "无"}`,
    );
    console.error(`${"!".repeat(80)}\n`);
  }
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
