import { QuoteContext, TradeContext, Decimal, OrderType, OrderSide, TimeInForceType, OrderStatus } from "longbridge";
import { createInterface } from "node:readline";
import type { TradeSignal, AnalysisRecord } from "./types.js";
import { loadTrackedOrders, trackOrder, removeOrder } from "./tracker.js";
import type { OrderWatcher } from "./order-watcher.js";

function orderStatusName(status: OrderStatus): string {
  switch (status) {
    case OrderStatus.Filled: return "Filled";
    case OrderStatus.Canceled: return "Canceled";
    case OrderStatus.Rejected: return "Rejected";
    case OrderStatus.Expired: return "Expired";
    case OrderStatus.New: return "New";
    case OrderStatus.PartialFilled: return "PartialFilled";
    case OrderStatus.NotReported: return "NotReported";
    default: return `Status(${status})`;
  }
}

export interface ExecutorConfig {
  quoteCtx: QuoteContext;
  tradeCtx: TradeContext;
  orderWatcher: OrderWatcher;
  force: boolean;
  positionPct: number;
  priceThresholdPct: number;
}

function printAnalysisRecord(record: AnalysisRecord): void {
  console.log("\n" + "=".repeat(80));
  console.log(`🔹 [${record.code}] ${record.name ?? "未知"}`);
  console.log(`   报告类型: ${record.report_type ?? "-"} | 时间: ${record.created_at}`);
  console.log(
    `   情绪评分: ${record.sentiment_score ?? "-"} | 操作建议: ${record.operation_advice ?? "-"} | 趋势: ${record.trend_prediction ?? "-"}`
  );
  console.log(
    `   理想买入: ${record.ideal_buy ?? "-"} | 次选买入: ${record.secondary_buy ?? "-"} | 止损: ${record.stop_loss ?? "-"} | 止盈: ${record.take_profit ?? "-"}`
  );
  if (record.analysis_summary) {
    console.log(`   摘要: ${record.analysis_summary}`);
  }
  console.log("=".repeat(80));
}

async function promptConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function getCurrency(symbol: string): string {
  if (symbol.endsWith(".HK")) return "HKD";
  if (symbol.endsWith(".US")) return "USD";
  if (symbol.endsWith(".SH") || symbol.endsWith(".SZ")) return "CNY";
  if (symbol.endsWith(".SG")) return "SGD";
  return "HKD";
}

export async function executeSignal(
  execConfig: ExecutorConfig,
  signal: TradeSignal
): Promise<{ buyOrderId: string; stopLossOrderId?: string; takeProfitOrderId?: string } | null> {
  const { quoteCtx, tradeCtx, orderWatcher, force, positionPct, priceThresholdPct } = execConfig;

  // Display analysis record
  printAnalysisRecord(signal.record);

  const currency = getCurrency(signal.symbol);

  // Get current price, lot size, and account balance in parallel
  const [quotes, staticInfos, balances] = await Promise.all([
    quoteCtx.quote([signal.symbol]),
    quoteCtx.staticInfo([signal.symbol]),
    tradeCtx.accountBalance(currency),
  ]);

  if (quotes.length === 0) {
    console.log(`[SKIP] ${signal.symbol} - 无法获取行情`);
    return null;
  }
  const currentPrice = quotes[0].lastDone;
  const currentPriceNum = Number(currentPrice.toString());
  const lotSize = staticInfos.length > 0 ? staticInfos[0].lotSize : 1;

  // Check price threshold
  const threshold = signal.targetPrice * (1 + priceThresholdPct / 100);
  if (currentPriceNum > threshold) {
    console.log(
      `[SKIP] ${signal.symbol} - 当前价 ${currentPriceNum} 超出目标价 ${signal.targetPrice} 的 ${priceThresholdPct}% 阈值 (${threshold.toFixed(2)})`
    );
    return null;
  }

  // Guard against zero/negative price (e.g. stock halt)
  if (currentPriceNum <= 0) {
    console.log(`[SKIP] ${signal.symbol} - 无法获取有效现价: ${currentPriceNum}`);
    return null;
  }

  // Calculate quantity based on account net assets * positionPct%
  const netAssets = balances.length > 0 ? Number(balances[0].netAssets.toString()) : 0;
  if (netAssets <= 0) {
    console.log(`[SKIP] ${signal.symbol} - 无法获取账户净资产（货币: ${currency}）`);
    return null;
  }
  const maxPositionValue = netAssets * positionPct / 100;
  // Use the higher of current price and target price to avoid over-sizing
  const sizingPrice = Math.max(currentPriceNum, signal.targetPrice);
  const qty = Math.floor(maxPositionValue / sizingPrice / lotSize) * lotSize;
  if (qty <= 0) {
    console.log(`[SKIP] ${signal.symbol} - 计算数量为 0（净资产 ${netAssets.toFixed(0)} ${currency} 的 ${positionPct}% = ${maxPositionValue.toFixed(0)}，不足一手）`);
    return null;
  }

  // Print trade plan
  console.log(`\n📋 交易计划:`);
  console.log(`   标的: ${signal.symbol} | 当前价: ${currentPriceNum} | 目标价: ${signal.targetPrice}`);
  console.log(`   账户净资产: ${netAssets.toFixed(0)} ${currency} | 仓位比例: ${positionPct}% | 可用金额: ${maxPositionValue.toFixed(0)} ${currency}`);
  console.log(`   方向: 买入 | 数量: ${qty}（${qty / lotSize}手 × ${lotSize}股/手）| 订单类型: 限价单 (LO)`);
  if (signal.stopLoss) {
    console.log(`   止损: ${signal.stopLoss} (MIT 市价触单)`);
  }
  if (signal.takeProfit) {
    console.log(`   止盈: ${signal.takeProfit} (LIT 限价触单)`);
  }

  // Confirmation
  if (!force) {
    const confirmed = await promptConfirm("\n确认下单？(y/n): ");
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return null;
    }
  }

  // Submit buy order
  const buyResp = await tradeCtx.submitOrder({
    symbol: signal.symbol,
    orderType: OrderType.LO,
    side: OrderSide.Buy,
    timeInForce: TimeInForceType.Day,
    submittedQuantity: new Decimal(String(qty)),
    submittedPrice: new Decimal(String(signal.targetPrice)),
    remark: `auto-trade:buy:${signal.record.id}`,
  });

  const buyOrderId = buyResp.orderId;
  console.log(`[OK] 买入单已提交: ${buyOrderId}`);

  // Track buy order
  trackOrder({
    orderId: buyOrderId,
    symbol: signal.symbol,
    side: "Buy",
    orderType: "LO",
    price: String(signal.targetPrice),
    quantity: String(qty),
    submittedAt: new Date().toISOString(),
    signalRecordId: signal.record.id,
    role: "buy",
  });

  // Wait for buy order to reach terminal state via WebSocket push (no polling).
  console.log(`[WAIT] 等待买单 ${buyOrderId} 成交确认... (WebSocket 推送)`);
  const buyEvent = await orderWatcher.waitForTerminal(buyOrderId);

  if (buyEvent.status !== OrderStatus.Filled) {
    console.log(`[SKIP] 买单未成交 (状态: ${orderStatusName(buyEvent.status)})，跳过止损/止盈`);
    return null;
  }
  console.log(`[OK] 买单已成交: ${buyOrderId}`);

  let stopLossOrderId: string | undefined;
  let takeProfitOrderId: string | undefined;

  // Submit stop-loss order (MIT) — only after buy order is confirmed filled
  if (signal.stopLoss) {
    try {
      const slResp = await tradeCtx.submitOrder({
        symbol: signal.symbol,
        orderType: OrderType.MIT,
        side: OrderSide.Sell,
        timeInForce: TimeInForceType.GoodTilCanceled,
        submittedQuantity: new Decimal(String(qty)),
        triggerPrice: new Decimal(String(signal.stopLoss)),
        remark: `auto-trade:sl:${signal.record.id}`,
      });
      stopLossOrderId = slResp.orderId;
      console.log(`[OK] 止损单已提交: ${stopLossOrderId} (触发价: ${signal.stopLoss})`);

      trackOrder({
        orderId: stopLossOrderId,
        symbol: signal.symbol,
        side: "Sell",
        orderType: "MIT",
        price: "0",
        triggerPrice: String(signal.stopLoss),
        quantity: String(qty),
        submittedAt: new Date().toISOString(),
        signalRecordId: signal.record.id,
        role: "stop_loss",
        linkedBuyOrderId: buyOrderId,
      });
    } catch (err) {
      console.error(`[WARN] 止损单提交失败: ${err}`);
    }
  }

  // Submit take-profit order (LIT)
  if (signal.takeProfit) {
    try {
      const tpResp = await tradeCtx.submitOrder({
        symbol: signal.symbol,
        orderType: OrderType.LIT,
        side: OrderSide.Sell,
        timeInForce: TimeInForceType.GoodTilCanceled,
        submittedQuantity: new Decimal(String(qty)),
        triggerPrice: new Decimal(String(signal.takeProfit)),
        submittedPrice: new Decimal(String(signal.takeProfit)),
        remark: `auto-trade:tp:${signal.record.id}`,
      });
      takeProfitOrderId = tpResp.orderId;
      console.log(`[OK] 止盈单已提交: ${takeProfitOrderId} (触发价: ${signal.takeProfit})`);

      trackOrder({
        orderId: takeProfitOrderId,
        symbol: signal.symbol,
        side: "Sell",
        orderType: "LIT",
        price: String(signal.takeProfit),
        triggerPrice: String(signal.takeProfit),
        quantity: String(qty),
        submittedAt: new Date().toISOString(),
        signalRecordId: signal.record.id,
        role: "take_profit",
        linkedBuyOrderId: buyOrderId,
      });
    } catch (err) {
      console.error(`[WARN] 止盈单提交失败: ${err}`);
    }
  }

  // Link SL/TP as OCO pair — filling one cancels the other in real-time
  if (stopLossOrderId && takeProfitOrderId) {
    orderWatcher.watchOcoPair(stopLossOrderId, takeProfitOrderId);
    console.log(`[OK] OCO 已关联: 止损 ${stopLossOrderId} ↔ 止盈 ${takeProfitOrderId}`);
  }

  return { buyOrderId, stopLossOrderId, takeProfitOrderId };
}

export async function executeSellSignal(
  execConfig: ExecutorConfig,
  signal: TradeSignal
): Promise<{ sellOrderId: string } | null> {
  const { tradeCtx, force, positionPct } = execConfig;
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
    console.log(`[SKIP] ${signal.symbol} - 可卖数量为 0（总持仓 ${totalQty}，可用 ${availableQty}）`);
    return null;
  }

  // 2. Calculate sell quantity
  const lotSize = 1; // positions already in shares, not lots
  let sellQty: number;
  if (isPartial) {
    // Reduce: sell positionPct% of available
    const reduceQty = Math.floor(availableQty * positionPct / 100 / lotSize) * lotSize;
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
  const trackedOrders = loadTrackedOrders();
  const slTpOrders = trackedOrders.filter(
    (o) => o.symbol === signal.symbol && (o.role === "stop_loss" || o.role === "take_profit")
  );

  for (const slTp of slTpOrders) {
    try {
      await tradeCtx.cancelOrder(slTp.orderId);
      console.log(`[CANCEL] 已取消 ${slTp.role} 订单 ${slTp.orderId}`);
      removeOrder(slTp.orderId);
    } catch (err) {
      console.error(`[WARN] 取消 ${slTp.role} 订单 ${slTp.orderId} 失败: ${err}`);
    }
  }

  // 4. Get current price for reference
  const quotes = await execConfig.quoteCtx.quote([signal.symbol]);
  const currentPrice = quotes.length > 0 ? Number(quotes[0].lastDone.toString()) : 0;
  const costPrice = Number(pos.costPrice.toString());

  // 5. Print trade plan
  const sellPrice = signal.targetPrice > 0 ? signal.targetPrice : currentPrice;
  const orderType = signal.targetPrice > 0 ? "限价单 (LO)" : "市价单 (MO)";
  console.log(`\n📋 卖出计划:`);
  console.log(`   标的: ${signal.symbol} | 当前价: ${currentPrice} | 成本价: ${costPrice}`);
  console.log(`   卖出价: ${sellPrice} | 数量: ${sellQty} | 订单类型: ${orderType}`);
  console.log(`   模式: ${isPartial ? "减仓" : "清仓"}`);

  // 6. Confirmation
  if (!force) {
    const confirmed = await promptConfirm("\n确认卖出？(y/n): ");
    if (!confirmed) {
      console.log("[SKIP] 用户取消");
      return null;
    }
  }

  // 7. Submit sell order
  const remark = isPartial ? `auto-trade:reduce:${signal.record.id}` : `auto-trade:sell:${signal.record.id}`;
  const resp = await tradeCtx.submitOrder({
    symbol: signal.symbol,
    orderType: signal.targetPrice > 0 ? OrderType.LO : OrderType.MO,
    side: OrderSide.Sell,
    timeInForce: TimeInForceType.Day,
    submittedQuantity: new Decimal(String(sellQty)),
    ...(signal.targetPrice > 0 && { submittedPrice: new Decimal(String(sellPrice)) }),
    remark,
  });

  const sellOrderId = resp.orderId;
  console.log(`[OK] 卖出单已提交: ${sellOrderId} (${isPartial ? "减仓" : "清仓"} ${sellQty} 股 @ ${sellPrice})`);

  // 8. Track sell order
  trackOrder({
    orderId: sellOrderId,
    symbol: signal.symbol,
    side: "Sell",
    orderType: signal.targetPrice > 0 ? "LO" : "MO",
    price: String(sellPrice),
    quantity: String(sellQty),
    submittedAt: new Date().toISOString(),
    signalRecordId: signal.record.id,
    role: "sell",
  });

  return { sellOrderId };
}
