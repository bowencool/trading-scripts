import {
  QuoteContext,
  TradeContext,
  Decimal,
  OrderType,
  OrderSide,
  TimeInForceType,
} from "longbridge";
import { createInterface } from "node:readline";
import type { TradeSignal, AnalysisRecord } from "./types.js";
import { trackOrder } from "./tracker.js";

export interface ExecutorConfig {
  quoteCtx: QuoteContext;
  tradeCtx: TradeContext;
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
  const { quoteCtx, tradeCtx, force, positionPct, priceThresholdPct } = execConfig;

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

  let stopLossOrderId: string | undefined;
  let takeProfitOrderId: string | undefined;

  // Submit stop-loss order (MIT)
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

  return { buyOrderId, stopLossOrderId, takeProfitOrderId };
}
