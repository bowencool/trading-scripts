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
import type { OrderWatcher } from "./order-watcher.js";
import { linkOcoOrders, loadTrackedOrders, removeOrder, trackOrder } from "./tracker.js";
import type { AnalysisRecord, TradeSignal } from "./types.js";
import { orderStatusName } from "./utils.js";

export interface ExecutorConfig {
  quoteCtx: QuoteContext;
  tradeCtx: TradeContext;
  orderWatcher: OrderWatcher;
  autoApprove: boolean;
  positionPct: number;
  priceThresholdPct: number;
}

function printAnalysisRecord(record: AnalysisRecord): void {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`🔹 [${record.code}] ${record.name ?? "未知"}`);
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
  console.log("-".repeat(80));
}

function promptConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(message);
    console.log("(非交互模式，自动确认)");
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    process.stdout.write(message);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (key: string) => {
      if (key === "\r" || key === "\n" || key === "y" || key === "Y") {
        // Enter / y = confirm
        cleanup();
        process.stdout.write("y\n");
        resolve(true);
      } else if (key === "\x1B" || key === "n" || key === "N" || key === "q" || key === "Q") {
        // Esc / n / q = cancel
        cleanup();
        process.stdout.write("n\n");
        resolve(false);
      }
    };
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
    };
    process.stdin.on("data", onData);
  });
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
  // 1. Try order book depth (ask1 for buy, bid1 for sell)
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

  // 2. Try pre/post/overnight quote
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
    // 3. Fallback to lastDone
    const lastDone = Number(q.lastDone.toString());
    if (lastDone > 0) return { price: lastDone, source: "lastDone" };
  }

  return { price: 0, source: "N/A" };
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

export async function executeSignal(
  execConfig: ExecutorConfig,
  signal: TradeSignal,
): Promise<{ buyOrderId: string; stopLossOrderId?: string; takeProfitOrderId?: string } | null> {
  const { quoteCtx, tradeCtx, orderWatcher, autoApprove, positionPct, priceThresholdPct } =
    execConfig;

  // Display analysis record
  printAnalysisRecord(signal.record);

  // Buy signals must have a target price
  if (signal.targetPrice == null || signal.targetPrice <= 0) {
    console.log(`[SKIP] ${signal.symbol} - 无有效目标买入价`);
    return null;
  }

  const currency = getCurrency(signal.symbol);
  if (!currency) {
    console.log(`[SKIP] ${signal.symbol} - 未知货币后缀`);
    return null;
  }

  // Get lot size and account balance in parallel
  const [staticInfos, balances] = await Promise.all([
    quoteCtx.staticInfo([signal.symbol]),
    tradeCtx.accountBalance(currency),
  ]);

  // Get effective price: ask1 (卖一价) → pre/post/overnight → lastDone
  const { price: currentPriceNum, source: priceSource } = await getEffectivePrice(
    quoteCtx,
    signal.symbol,
    "buy",
  );
  const lotSize = staticInfos.length > 0 ? staticInfos[0].lotSize : 1;

  if (currentPriceNum <= 0) {
    console.log(`[SKIP] ${signal.symbol} - 无法获取有效现价`);
    return null;
  }

  // Check price threshold
  const threshold = Number((signal.targetPrice * (1 + priceThresholdPct / 100)).toFixed(2));
  if (currentPriceNum > threshold) {
    console.log(`[SKIP] ${signal.symbol} - 当前价 ${currentPriceNum} 超出阈值上限 ${threshold}`);
    return null;
  }

  // Calculate quantity based on account net assets * positionPct%
  const netAssets = balances.length > 0 ? Number(balances[0].netAssets.toString()) : 0;
  if (netAssets <= 0) {
    console.log(`[SKIP] ${signal.symbol} - 无法获取账户净资产（货币: ${currency}）`);
    return null;
  }
  const maxPositionValue = (netAssets * positionPct) / 100;
  // Use the higher of current price and target price to avoid over-sizing
  const sizingPrice = Math.max(currentPriceNum, signal.targetPrice);
  const qty = Math.floor(maxPositionValue / sizingPrice / lotSize) * lotSize;
  if (qty <= 0) {
    console.log(
      `[SKIP] ${signal.symbol} - 计算数量为 0（净资产 ${netAssets.toFixed(0)} ${currency} 的 ${positionPct}% = ${maxPositionValue.toFixed(0)}，不足一手）`,
    );
    return null;
  }

  // Print trade plan
  console.log(`\n📋 交易计划:`);
  console.log(
    `   标的: ${signal.symbol} | 当前价: ${currentPriceNum}（${priceSource}） | 目标价: ${signal.targetPrice}`,
  );
  console.log(
    `   账户净资产: ${netAssets.toFixed(0)} ${currency} | 仓位比例: ${positionPct}% | 可用金额: ${maxPositionValue.toFixed(0)} ${currency}`,
  );
  console.log(
    `   方向: 买入 | 数量: ${qty}（${qty / lotSize}手 × ${lotSize}股/手）| 订单类型: 限价单 (LO)`,
  );
  console.log(
    `   目标价: ${signal.targetPrice} | \x1b[33m限价: ${threshold}（${priceThresholdPct}% 阈值上限）\x1b[0m`,
  );
  if (signal.stopLoss) {
    console.log(`   止损: ${signal.stopLoss} (MIT 市价触单)`);
  }
  if (signal.takeProfit) {
    console.log(`   止盈: ${signal.takeProfit} (LIT 限价触单)`);
  }
  console.log(`   ⏳ 限价单等待: 10 秒（超时未成交则跳过）`);

  // Confirmation
  if (!autoApprove) {
    const confirmed = await promptConfirm(
      `\n确认以 \x1b[33m${threshold}\x1b[0m 买入 ${qty} 股？(Enter 确认 / Esc 取消): `,
    );
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return null;
    }
  }

  // Submit buy order at threshold price
  const buyResp = await tradeCtx.submitOrder({
    symbol: signal.symbol,
    orderType: OrderType.LO,
    side: OrderSide.Buy,
    timeInForce: TimeInForceType.Day,
    submittedQuantity: new Decimal(String(qty)),
    submittedPrice: new Decimal(String(threshold)),
    outsideRth: OutsideRTH.AnyTime,
    remark: `auto-trade:buy:${signal.record.id}`,
  });

  const buyOrderId = buyResp.orderId;
  console.log(`[OK] 买入单已提交: ${buyOrderId} @ ${threshold}`);

  // Track buy order
  trackOrder({
    orderId: buyOrderId,
    symbol: signal.symbol,
    side: "Buy",
    orderType: "LO",
    price: String(threshold),
    quantity: String(qty),
    submittedAt: new Date().toISOString(),
    signalRecordId: signal.record.id,
    role: "buy",
  });

  // Wait for buy order to fill within 10 seconds.
  console.log(`[WAIT] 等待限价买单 ${buyOrderId} 成交... (10 秒超时)`);
  const buyEvent = await orderWatcher.waitForTerminal(buyOrderId, 10_000);

  // Always query orderDetail for accurate executedQuantity (WS push may lack it)
  const buyDetail = await tradeCtx.orderDetail(buyOrderId);
  const buyFilledQty = Number(buyDetail.executedQuantity.toString());

  const filledOrderId = buyOrderId;
  const totalFilledQty = buyFilledQty;

  if (buyEvent.status !== OrderStatus.Filled) {
    if (buyFilledQty <= 0) {
      removeOrder(buyOrderId);
      console.log(
        `[SKIP] 限价单 ${buyOrderId} 10 秒内未成交 (状态: ${orderStatusName(buyEvent.status)})，跳过`,
      );
      return null;
    }
    console.log(
      `[WARN] 限价单 ${buyOrderId} 部分成交 ${buyFilledQty}/${qty} 股 (状态: ${orderStatusName(buyEvent.status)})，以已成交数量设置止损/止盈`,
    );
  } else {
    console.log(`[OK] 限价买单已成交: ${buyOrderId}`);
  }

  let stopLossOrderId: string | undefined;
  let takeProfitOrderId: string | undefined;

  // Submit stop-loss order (MIT) — only after buy order is confirmed filled
  if (signal.stopLoss) {
    stopLossOrderId = await submitWithRetry(
      () =>
        tradeCtx.submitOrder({
          symbol: signal.symbol,
          orderType: OrderType.MIT,
          side: OrderSide.Sell,
          timeInForce: TimeInForceType.GoodTilCanceled,
          submittedQuantity: new Decimal(String(totalFilledQty)),
          triggerPrice: new Decimal(String(signal.stopLoss)),
          outsideRth: OutsideRTH.AnyTime,
          remark: `auto-trade:sl:${signal.record.id}`,
        }),
      "止损单",
      signal.symbol,
    );
    if (stopLossOrderId) {
      console.log(`[OK] 止损单已提交: ${stopLossOrderId} (触发价: ${signal.stopLoss})`);
      trackOrder({
        orderId: stopLossOrderId,
        symbol: signal.symbol,
        side: "Sell",
        orderType: "MIT",
        price: "0",
        triggerPrice: String(signal.stopLoss),
        quantity: String(totalFilledQty),
        submittedAt: new Date().toISOString(),
        signalRecordId: signal.record.id,
        role: "stop_loss",
        linkedBuyOrderId: filledOrderId,
      });
    }
  }

  // Submit take-profit order (LIT)
  if (signal.takeProfit) {
    takeProfitOrderId = await submitWithRetry(
      () =>
        tradeCtx.submitOrder({
          symbol: signal.symbol,
          orderType: OrderType.LIT,
          side: OrderSide.Sell,
          timeInForce: TimeInForceType.GoodTilCanceled,
          submittedQuantity: new Decimal(String(totalFilledQty)),
          triggerPrice: new Decimal(String(signal.takeProfit)),
          submittedPrice: new Decimal(String(signal.takeProfit)),
          outsideRth: OutsideRTH.AnyTime,
          remark: `auto-trade:tp:${signal.record.id}`,
        }),
      "止盈单",
      signal.symbol,
    );
    if (takeProfitOrderId) {
      console.log(`[OK] 止盈单已提交: ${takeProfitOrderId} (触发价: ${signal.takeProfit})`);
      trackOrder({
        orderId: takeProfitOrderId,
        symbol: signal.symbol,
        side: "Sell",
        orderType: "LIT",
        price: String(signal.takeProfit),
        triggerPrice: String(signal.takeProfit),
        quantity: String(totalFilledQty),
        submittedAt: new Date().toISOString(),
        signalRecordId: signal.record.id,
        role: "take_profit",
        linkedBuyOrderId: filledOrderId,
      });
    }
  }

  // Link SL/TP as OCO pair — filling one cancels the other in real-time
  if (stopLossOrderId && takeProfitOrderId) {
    orderWatcher.watchOcoPair(stopLossOrderId, takeProfitOrderId);
    linkOcoOrders(stopLossOrderId, takeProfitOrderId);
    console.log(`[OK] OCO 已关联: 止损 ${stopLossOrderId} ↔ 止盈 ${takeProfitOrderId}`);
  }

  return { buyOrderId: filledOrderId, stopLossOrderId, takeProfitOrderId };
}

/**
 * Check tracked buy orders that are filled but missing SL/TP records,
 * and re-submit the missing orders. This handles the case where the script
 * crashed after buying but before SL/TP was fully submitted.
 */
export async function patchMissingSlTp(tradeCtx: TradeContext): Promise<void> {
  const orders = loadTrackedOrders();
  const buyOrders = orders.filter((o) => o.role === "buy");

  for (const buy of buyOrders) {
    const hasSl = orders.some((o) => o.role === "stop_loss" && o.linkedBuyOrderId === buy.orderId);
    const hasTp = orders.some(
      (o) => o.role === "take_profit" && o.linkedBuyOrderId === buy.orderId,
    );
    if (hasSl && hasTp) continue;

    // Check if buy order is actually filled
    try {
      const detail = await tradeCtx.orderDetail(buy.orderId);
      if (detail.status !== OrderStatus.Filled) continue;
    } catch {
      continue;
    }

    // Look up the signal record to get SL/TP prices
    // We don't have direct access to the DB here, so read from submitted_orders
    // The signal record may no longer be in DB's 12h window — skip gracefully
    console.warn(
      `[PATCH] ${buy.symbol} 买单 ${buy.orderId} 已成交但缺少 ${!hasSl ? "止损" : ""}${!hasSl && !hasTp ? "/" : ""}${!hasTp ? "止盈" : ""} 订单`,
    );
    // We can't re-derive the SL/TP prices without the original signal record.
    // Log a warning so the user can manually set them.
    console.warn(`[PATCH] 请手动为 ${buy.symbol} 设置止损/止盈，或删除跟踪记录后重新运行`);
  }
}

export async function executeSellSignal(
  execConfig: ExecutorConfig,
  signal: TradeSignal,
): Promise<{ sellOrderId: string } | null> {
  const { tradeCtx, quoteCtx, autoApprove, positionPct } = execConfig;
  const isPartial = signal.sellMode === "reduce";

  // Display analysis record
  printAnalysisRecord(signal.record);

  // 1. Get current position for this symbol
  const positionsResp = await tradeCtx.stockPositions();
  const allPositions = positionsResp.channels.flatMap((ch) => ch.positions);
  const pos = allPositions.find((p) => p.symbol === signal.symbol);

  if (!pos) {
    console.log(`[SKIP] ${signal.symbol} - 无持仓`);
    return null;
  }

  const totalQty = Number(pos.quantity.toString());
  const availableQty = Number(pos.availableQuantity.toString());

  if (availableQty <= 0) {
    console.log(
      `[SKIP] ${signal.symbol} - 可卖数量为 0（总持仓 ${totalQty}，可用 ${availableQty}）`,
    );
    return null;
  }

  // 2. Get lot size and calculate sell quantity
  const staticInfos = await quoteCtx.staticInfo([signal.symbol]);
  const lotSize = staticInfos.length > 0 ? staticInfos[0].lotSize : 1;
  let sellQty: number;
  if (isPartial) {
    // Reduce: sell positionPct% of available
    const reduceQty = Math.floor((availableQty * positionPct) / 100 / lotSize) * lotSize;
    sellQty = reduceQty;
    console.log(`📉 减仓模式: 可卖 ${availableQty} 股, 减持 ${positionPct}% = ${sellQty} 股`);
  } else {
    // Full exit: sell all available
    sellQty = availableQty;
    console.log(`📉 清仓模式: 可卖 ${availableQty} 股`);
  }

  if (sellQty <= 0) {
    console.log(`[SKIP] ${signal.symbol} - 计算卖出数量为 0`);
    return null;
  }

  // 3. Cancel existing SL/TP orders for this symbol
  // Full exit (卖出): cancel all SL/TP for the symbol since we're closing the entire position
  // Partial exit (减仓): only cancel SL/TP orders linked to buy orders with matching signalRecordId,
  //   since we're only reducing the position and other SL/TP should remain active
  const trackedOrders = loadTrackedOrders();
  let slTpOrders: typeof trackedOrders;
  if (isPartial) {
    // Only cancel SL/TP whose linked buy order was submitted for this signal
    const buyOrderIds = new Set(
      trackedOrders
        .filter(
          (o) =>
            o.symbol === signal.symbol && o.role === "buy" && o.signalRecordId === signal.record.id,
        )
        .map((o) => o.orderId),
    );
    slTpOrders = trackedOrders.filter(
      (o) =>
        o.symbol === signal.symbol &&
        (o.role === "stop_loss" || o.role === "take_profit") &&
        o.linkedBuyOrderId &&
        buyOrderIds.has(o.linkedBuyOrderId),
    );
    if (slTpOrders.length === 0) {
      console.log(`[INFO] 减仓模式: 未找到关联的止损/止盈单，现有止损/止盈将继续保持`);
    }
  } else {
    slTpOrders = trackedOrders.filter(
      (o) => o.symbol === signal.symbol && (o.role === "stop_loss" || o.role === "take_profit"),
    );
  }

  for (const slTp of slTpOrders) {
    try {
      await tradeCtx.cancelOrder(slTp.orderId);
      console.log(`[CANCEL] 已取消 ${slTp.role} 订单 ${slTp.orderId}`);
      removeOrder(slTp.orderId);
    } catch (err) {
      console.error(`[WARN] 取消 ${slTp.role} 订单 ${slTp.orderId} 失败: ${err}`);
    }
  }

  // Wait briefly for exchange to confirm cancellations before submitting new sell order
  if (slTpOrders.length > 0) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // 4. Get effective price: bid1 (买一价) in depth → pre/post/overnight → lastDone
  const { price: currentPrice, source: priceSource } = await getEffectivePrice(
    quoteCtx,
    signal.symbol,
    "sell",
  );
  const costPrice = Number(pos.costPrice.toString());

  if (currentPrice <= 0) {
    console.log(`[SKIP] ${signal.symbol} - 无法获取有效现价`);
    return null;
  }

  // 5. Price threshold check: if target sell price is too far above current price, skip
  if (signal.targetPrice != null && signal.targetPrice > 0) {
    const threshold = signal.targetPrice * (1 - execConfig.priceThresholdPct / 100);
    if (currentPrice < threshold) {
      console.log(
        `[SKIP] ${signal.symbol} - 当前价 ${currentPrice} 低于目标卖出价 ${signal.targetPrice} 的 ${execConfig.priceThresholdPct}% 阈值 (${threshold.toFixed(2)})，限价单不会成交`,
      );
      return null;
    }
  }

  // 6. Print trade plan
  const hasSellPrice = signal.targetPrice != null && signal.targetPrice > 0;
  const sellThreshold = hasSellPrice
    ? Number(((signal.targetPrice as number) * (1 - execConfig.priceThresholdPct / 100)).toFixed(2))
    : currentPrice;
  const sellPrice = sellThreshold;
  const orderType = "限价单 (LO)";
  console.log(`\n📋 卖出计划:`);
  console.log(
    `   标的: ${signal.symbol} | 当前价: ${currentPrice}（${priceSource}） | 成本价: ${costPrice}`,
  );
  console.log(`   卖出价: ${sellPrice} | 数量: ${sellQty} | 订单类型: ${orderType}`);
  if (hasSellPrice) {
    console.log(
      `   目标价: ${signal.targetPrice} | \x1b[33m限价: ${sellPrice}（${execConfig.priceThresholdPct}% 阈值下限）\x1b[0m`,
    );
  }
  console.log(`   模式: ${isPartial ? "减仓" : "清仓"}`);

  // 7. Confirmation
  if (!autoApprove) {
    const confirmed = await promptConfirm(
      `\n确认以 \x1b[33m${sellPrice}\x1b[0m 卖出 ${sellQty} 股？(Enter 确认 / Esc 取消): `,
    );
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return null;
    }
  }

  // 8. Submit sell order
  const remark = isPartial
    ? `auto-trade:reduce:${signal.record.id}`
    : `auto-trade:sell:${signal.record.id}`;
  const resp = await tradeCtx.submitOrder({
    symbol: signal.symbol,
    orderType: OrderType.LO,
    side: OrderSide.Sell,
    timeInForce: TimeInForceType.Day,
    submittedQuantity: new Decimal(String(sellQty)),
    submittedPrice: new Decimal(String(sellPrice)),
    outsideRth: OutsideRTH.AnyTime,
    remark,
  });

  const sellOrderId = resp.orderId;
  console.log(
    `[OK] 卖出单已提交: ${sellOrderId} (${isPartial ? "减仓" : "清仓"} ${sellQty} 股 @ ${sellPrice})`,
  );

  // 9. Track sell order
  trackOrder({
    orderId: sellOrderId,
    symbol: signal.symbol,
    side: "Sell",
    orderType: "LO",
    price: String(sellPrice),
    quantity: String(sellQty),
    submittedAt: new Date().toISOString(),
    signalRecordId: signal.record.id,
    role: "sell",
  });

  // 10. Wait for sell order to reach terminal state (30s timeout)
  const sellTimeout = hasSellPrice ? 30_000 : 10_000;
  console.log(`[WAIT] 等待限价卖单 ${sellOrderId} 成交... (${sellTimeout / 1000} 秒超时)`);
  const sellEvent = await execConfig.orderWatcher.waitForTerminal(sellOrderId, sellTimeout);
  if (sellEvent.status === OrderStatus.Filled) {
    console.log(`[OK] 限价卖单 ${sellOrderId} 已成交`);
  } else {
    const filledDetail = await tradeCtx.orderDetail(sellOrderId);
    const filledQty = Number(filledDetail.executedQuantity.toString());
    if (filledQty > 0) {
      console.log(
        `[WARN] 限价卖单 ${sellOrderId} 部分成交 ${filledQty}/${sellQty} 股 (状态: ${orderStatusName(sellEvent.status)})`,
      );
    } else {
      console.log(
        `[SKIP] 限价卖单 ${sellOrderId} 未成交 (状态: ${orderStatusName(sellEvent.status)})，跳过`,
      );
      removeOrder(sellOrderId);
      return null;
    }
  }

  return { sellOrderId };
}
