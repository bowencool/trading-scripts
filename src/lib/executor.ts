import {
  Decimal,
  OrderSide,
  OrderStatus,
  OrderType,
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
  console.log("=".repeat(80));
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

function getCurrency(symbol: string): string {
  if (symbol.endsWith(".HK")) return "HKD";
  if (symbol.endsWith(".US")) return "USD";
  if (symbol.endsWith(".SH") || symbol.endsWith(".SZ")) return "CNY";
  if (symbol.endsWith(".SG")) return "SGD";
  return "HKD";
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
      `[SKIP] ${signal.symbol} - 当前价 ${currentPriceNum} 超出目标价 ${signal.targetPrice} 的 ${priceThresholdPct}% 阈值 (${threshold.toFixed(2)})`,
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
    `   标的: ${signal.symbol} | 当前价: ${currentPriceNum} | 目标价: ${signal.targetPrice}`,
  );
  console.log(
    `   账户净资产: ${netAssets.toFixed(0)} ${currency} | 仓位比例: ${positionPct}% | 可用金额: ${maxPositionValue.toFixed(0)} ${currency}`,
  );
  console.log(
    `   方向: 买入 | 数量: ${qty}（${qty / lotSize}手 × ${lotSize}股/手）| 订单类型: 限价单 (LO)`,
  );
  if (signal.stopLoss) {
    console.log(`   止损: ${signal.stopLoss} (MIT 市价触单)`);
  }
  if (signal.takeProfit) {
    console.log(`   止盈: ${signal.takeProfit} (LIT 限价触单)`);
  }
  console.log(`   ⏳ 限价单等待: 10 秒（超时后自动评估是否切换市价单）`);

  // Confirmation
  if (!autoApprove) {
    const confirmed = await promptConfirm("\n确认下单？(Enter 确认 / Esc 取消): ");
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

  // Wait for buy order to fill within 10 seconds.
  console.log(`[WAIT] 等待限价买单 ${buyOrderId} 成交... (10 秒超时)`);
  const buyEvent = await orderWatcher.waitForTerminal(buyOrderId, 10_000);

  // Always query orderDetail for accurate executedQuantity (WS push may lack it)
  const buyDetail = await tradeCtx.orderDetail(buyOrderId);
  const buyFilledQty = Number(buyDetail.executedQuantity.toString());

  let filledOrderId = buyOrderId;
  let totalFilledQty = buyFilledQty;

  if (buyEvent.status !== OrderStatus.Filled) {
    const remainingQty = qty - buyFilledQty;

    console.log(
      `[RETRY] 限价单 ${buyOrderId} 10 秒内未成交 (状态: ${orderStatusName(buyEvent.status)}${buyFilledQty > 0 ? `, 已部分成交 ${buyFilledQty} 股` : ""})，重新评估...`,
    );

    if (remainingQty <= 0) {
      console.log(`[OK] 限价单 ${buyOrderId} 实际已全部成交 ${buyFilledQty} 股`);
    } else {
      removeOrder(buyOrderId);

      const retryQuotes = await quoteCtx.quote([signal.symbol]);
      if (retryQuotes.length === 0) {
        console.log(`[SKIP] ${signal.symbol} - 无法获取最新行情，跳过`);
        return null;
      }
      const retryPrice = Number(retryQuotes[0].lastDone.toString());
      const retryThreshold = signal.targetPrice * (1 + priceThresholdPct / 100);

      if (retryPrice <= 0) {
        console.log(`[SKIP] ${signal.symbol} - 最新价无效: ${retryPrice}，跳过`);
        return null;
      }

      if (retryPrice > retryThreshold) {
        console.log(
          `[SKIP] ${signal.symbol} - 最新价 ${retryPrice} 仍超出阈值 ${retryThreshold.toFixed(2)}，跳过`,
        );
        return null;
      }

      // Within threshold → submit market order for remaining quantity
      console.log(
        `[RETRY] 最新价 ${retryPrice} 在阈值 ${retryThreshold.toFixed(2)} 内，切换市价单买入 ${remainingQty} 股...`,
      );
      const moResp = await tradeCtx.submitOrder({
        symbol: signal.symbol,
        orderType: OrderType.MO,
        side: OrderSide.Buy,
        timeInForce: TimeInForceType.Day,
        submittedQuantity: new Decimal(String(remainingQty)),
        remark: `auto-trade:buy-retry:${signal.record.id}`,
      });

      filledOrderId = moResp.orderId;
      console.log(`[OK] 市价单已提交: ${filledOrderId}`);

      trackOrder({
        orderId: filledOrderId,
        symbol: signal.symbol,
        side: "Buy",
        orderType: "MO",
        price: String(retryPrice),
        quantity: String(remainingQty),
        submittedAt: new Date().toISOString(),
        signalRecordId: signal.record.id,
        role: "buy",
      });

      const moEvent = await orderWatcher.waitForTerminal(filledOrderId, 10_000);
      if (moEvent.status !== OrderStatus.Filled) {
        const moDetail = await tradeCtx.orderDetail(filledOrderId);
        const moFilledQty = Number(moDetail.executedQuantity.toString());
        totalFilledQty = buyFilledQty + moFilledQty;
        removeOrder(filledOrderId);
        if (totalFilledQty <= 0) {
          console.log(
            `[SKIP] 市价单 ${filledOrderId} 未成交 (状态: ${orderStatusName(moEvent.status)})，跳过止损/止盈`,
          );
          return null;
        }
        console.log(
          `[WARN] 市价单 ${filledOrderId} 未全部成交 (状态: ${orderStatusName(moEvent.status)})，已成交部分 ${moFilledQty} 股，总成交: ${totalFilledQty} 股，仍设置止损/止盈`,
        );
      } else {
        const moDetail = await tradeCtx.orderDetail(filledOrderId);
        totalFilledQty = buyFilledQty + Number(moDetail.executedQuantity.toString());
        console.log(`[OK] 市价单已成交，总成交: ${totalFilledQty} 股`);
      }
    }
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

export async function executeSellSignal(
  execConfig: ExecutorConfig,
  signal: TradeSignal,
): Promise<{ sellOrderId: string } | null> {
  const { tradeCtx, autoApprove, positionPct } = execConfig;
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

  // 2. Calculate sell quantity
  const lotSize = 1; // positions already in shares, not lots
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

  // 4. Get current price for reference
  const quotes = await execConfig.quoteCtx.quote([signal.symbol]);
  const currentPrice = quotes.length > 0 ? Number(quotes[0].lastDone.toString()) : 0;
  const costPrice = Number(pos.costPrice.toString());

  if (currentPrice <= 0) {
    console.log(`[SKIP] ${signal.symbol} - 无法获取有效现价: ${currentPrice}`);
    return null;
  }

  // 5. Price threshold check: if target sell price is too far above current price, skip
  if (signal.targetPrice > 0) {
    const threshold = signal.targetPrice * (1 - execConfig.priceThresholdPct / 100);
    if (currentPrice < threshold) {
      console.log(
        `[SKIP] ${signal.symbol} - 当前价 ${currentPrice} 低于目标卖出价 ${signal.targetPrice} 的 ${execConfig.priceThresholdPct}% 阈值 (${threshold.toFixed(2)})，限价单不会成交`,
      );
      return null;
    }
  }

  // 6. Print trade plan
  const sellPrice = signal.targetPrice > 0 ? signal.targetPrice : currentPrice;
  const orderType = signal.targetPrice > 0 ? "限价单 (LO)" : "市价单 (MO)";
  console.log(`\n📋 卖出计划:`);
  console.log(`   标的: ${signal.symbol} | 当前价: ${currentPrice} | 成本价: ${costPrice}`);
  console.log(`   卖出价: ${sellPrice} | 数量: ${sellQty} | 订单类型: ${orderType}`);
  console.log(`   模式: ${isPartial ? "减仓" : "清仓"}`);

  // 7. Confirmation
  if (!autoApprove) {
    const confirmed = await promptConfirm("\n确认卖出？(Enter 确认 / Esc 取消): ");
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
    orderType: signal.targetPrice > 0 ? OrderType.LO : OrderType.MO,
    side: OrderSide.Sell,
    timeInForce: TimeInForceType.Day,
    submittedQuantity: new Decimal(String(sellQty)),
    ...(signal.targetPrice > 0 && { submittedPrice: new Decimal(String(sellPrice)) }),
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
    orderType: signal.targetPrice > 0 ? "LO" : "MO",
    price: String(sellPrice),
    quantity: String(sellQty),
    submittedAt: new Date().toISOString(),
    signalRecordId: signal.record.id,
    role: "sell",
  });

  // 10. Wait for sell order to reach terminal state (30s timeout for limit orders)
  if (signal.targetPrice > 0) {
    console.log(`[WAIT] 等待限价卖单 ${sellOrderId} 成交... (30 秒超时)`);
    const sellEvent = await execConfig.orderWatcher.waitForTerminal(sellOrderId, 30_000);
    if (sellEvent.status === OrderStatus.Filled) {
      console.log(`[OK] 限价卖单 ${sellOrderId} 已成交`);
    } else {
      const filledDetail = await tradeCtx.orderDetail(sellOrderId);
      const filledQty = Number(filledDetail.executedQuantity.toString());
      if (filledQty > 0) {
        console.log(`[OK] 限价卖单 ${sellOrderId} 部分成交 ${filledQty} 股`);
      } else {
        console.log(
          `[WARN] 限价卖单 ${sellOrderId} 未成交 (状态: ${orderStatusName(sellEvent.status)})`,
        );
        removeOrder(sellOrderId);
        return null;
      }
    }
  } else {
    // Market orders: wait briefly for confirmation
    console.log(`[WAIT] 等待市价卖单 ${sellOrderId} 成交... (10 秒)`);
    const sellEvent = await execConfig.orderWatcher.waitForTerminal(sellOrderId, 10_000);
    if (sellEvent.status === OrderStatus.Filled) {
      console.log(`[OK] 市价卖单 ${sellOrderId} 已成交`);
    } else {
      console.log(
        `[WARN] 市价卖单 ${sellOrderId} 未成交 (状态: ${orderStatusName(sellEvent.status)})`,
      );
      removeOrder(sellOrderId);
      return null;
    }
  }

  return { sellOrderId };
}
