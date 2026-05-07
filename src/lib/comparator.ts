import { toLongbridgeSymbol } from "./symbols.js";
import type { ActionPlan, AnalysisRecord, PortfolioState } from "./types.js";

/**
 * Compare portfolio state against DB signals and produce an action plan.
 *
 * Dedup rules (replacing excludeRecordIds):
 * - Buy signal: symbol in holdings → skip; has pending buy → UPDATE_BUY or skip
 * - Sell signal: symbol not in holdings → skip
 * - SL/TP: only for held symbols, compared against active orders
 */
export function buildActionPlan(
  portfolio: PortfolioState,
  buySignals: AnalysisRecord[],
  sellSignals: AnalysisRecord[],
  slTpRecords: Map<string, AnalysisRecord>,
): ActionPlan[] {
  const plans: ActionPlan[] = [];
  const processedSymbols = new Set<string>();

  // ── Buy signals ─────────────────────────────────────────────────────────────

  for (const record of buySignals) {
    const symbol = toLongbridgeSymbol(record.code);
    if (!symbol) {
      console.log(`[SKIP] ${record.code} 无法映射到 Longbridge symbol`);
      continue;
    }

    const holding = portfolio.holdings.get(symbol);
    const pendingBuy = portfolio.activeOrders.find((o) => o.symbol === symbol && o.role === "buy");

    if (holding) {
      console.log(`[SKIP] ${symbol} 已持仓 ${holding.quantity} 股，跳过买入信号`);
      processedSymbols.add(symbol);
      continue;
    }

    if (pendingBuy) {
      // Check if price/qty need updating
      // biome-ignore lint/style/noNonNullAssertion: buy signals always have ideal_buy
      const targetPrice = record.ideal_buy!;
      const pendingPrice = Number(pendingBuy.price);
      if (Math.abs(pendingPrice - targetPrice) / targetPrice > 0.001) {
        plans.push({
          action: "UPDATE_BUY",
          symbol,
          record,
          pendingBuyOrder: pendingBuy,
        });
      } else {
        console.log(`[HOLD] ${symbol} pending 买单价格已匹配 (${pendingPrice})，跳过`);
      }
      processedSymbols.add(symbol);
      continue;
    }

    plans.push({ action: "NEW_BUY", symbol, record });
    processedSymbols.add(symbol);
  }

  // ── Sell signals ────────────────────────────────────────────────────────────

  for (const record of sellSignals) {
    const symbol = toLongbridgeSymbol(record.code);
    if (!symbol) {
      console.log(`[SKIP] ${record.code} 无法映射到 Longbridge symbol`);
      continue;
    }

    const holding = portfolio.holdings.get(symbol);
    if (!holding) {
      console.log(`[SKIP] ${symbol} 无持仓，跳过卖出信号`);
      processedSymbols.add(symbol);
      continue;
    }

    const isPartial = (record.operation_advice ?? "").includes("减仓");
    plans.push({
      action: isPartial ? "SELL_PARTIAL" : "SELL_FULL",
      symbol,
      record,
      holding,
      sellPct: isPartial ? Number(process.env.SELL_PCT || "50") : undefined,
    });
    processedSymbols.add(symbol);
  }

  // ── SL/TP reconciliation for held symbols ───────────────────────────────────

  for (const [symbol, holding] of portfolio.holdings) {
    if (processedSymbols.has(symbol)) continue; // Already handled above

    const slOrders = portfolio.activeOrders.filter(
      (o) => o.symbol === symbol && o.role === "stop_loss",
    );
    const tpOrders = portfolio.activeOrders.filter(
      (o) => o.symbol === symbol && o.role === "take_profit",
    );

    const slTpRecord = slTpRecords.get(symbol);

    if (!slTpRecord) {
      // No SL/TP signal available at all — just hold
      plans.push({ action: "HOLD", symbol, record: makeDummyRecord(symbol, holding), holding });
      continue;
    }

    const hasSl = slTpRecord.stop_loss != null;
    const hasTp = slTpRecord.take_profit != null;

    // ── Duplicate SL/TP detection → MERGE_SL_TP ───────────────────────────
    // If there are multiple SL or TP orders, cancel all and re-submit one pair
    const allSlTpOrders = [...slOrders, ...tpOrders];
    if (slOrders.length > 1 || tpOrders.length > 1) {
      console.log(
        `[MERGE] ${symbol} 发现重复 SL/TP 单: ${slOrders.length} 止损, ${tpOrders.length} 止盈 → 将合并为一对`,
      );
      plans.push({
        action: "MERGE_SL_TP",
        symbol,
        record: slTpRecord,
        holding,
        ordersToCancel: allSlTpOrders,
      });
      continue;
    }

    // Existing SL/TP (take the first one if multiple)
    const existingSl = slOrders.length > 0 ? slOrders[0] : undefined;
    const existingTp = tpOrders.length > 0 ? tpOrders[0] : undefined;

    // If no visible SL/TP orders for this symbol
    if (!existingSl && !existingTp) {
      // Only RECOVER if this symbol was flagged as needing recovery
      // (today's buy filled but SL/TP missing → likely crash)
      // Cross-day holdings have GTC SL/TP that the API can't see → leave alone
      if (portfolio.orphanWarnings.includes(symbol) && (hasSl || hasTp)) {
        plans.push({
          action: "RECOVER_SL_TP",
          symbol,
          record: slTpRecord,
          holding,
        });
      } else {
        plans.push({ action: "HOLD", symbol, record: slTpRecord, holding });
      }
      continue;
    }

    // Check if SL/TP quantity matches holding
    const existingSlQty = existingSl ? Number(existingSl.quantity) : 0;
    const existingTpQty = existingTp ? Number(existingTp.quantity) : 0;
    const slQtyMismatch = hasSl && existingSl && existingSlQty !== holding.quantity;
    const tpQtyMismatch = hasTp && existingTp && existingTpQty !== holding.quantity;

    // Check if SL/TP prices match the signal
    const existingSlTrigger = existingSl ? Number(existingSl.triggerPrice) : 0;
    const existingTpTrigger = existingTp ? Number(existingTp.triggerPrice) : 0;
    const slPriceMismatch =
      hasSl && existingSl && Math.abs(existingSlTrigger - (slTpRecord.stop_loss ?? 0)) > 0.001;
    const tpPriceMismatch =
      hasTp && existingTp && Math.abs(existingTpTrigger - (slTpRecord.take_profit ?? 0)) > 0.001;

    if (
      hasSl &&
      hasTp &&
      existingSl &&
      existingTp &&
      !slQtyMismatch &&
      !tpQtyMismatch &&
      !slPriceMismatch &&
      !tpPriceMismatch
    ) {
      // Everything matches
      plans.push({
        action: "HOLD",
        symbol,
        record: slTpRecord,
        holding,
        existingSlOrder: existingSl,
        existingTpOrder: existingTp,
      });
      continue;
    }

    if (
      (existingSl || existingTp) &&
      (slQtyMismatch || tpQtyMismatch || slPriceMismatch || tpPriceMismatch)
    ) {
      // SL/TP exist but quantity or price doesn't match → SYNC
      plans.push({
        action: "SYNC_SL_TP",
        symbol,
        record: slTpRecord,
        holding,
        existingSlOrder: existingSl,
        existingTpOrder: existingTp,
      });
      continue;
    }

    // Partial: has SL but not TP, or vice versa → RECOVER only if orphanWarning
    if (
      ((hasSl && !existingSl) || (hasTp && !existingTp)) &&
      portfolio.orphanWarnings.includes(symbol)
    ) {
      plans.push({
        action: "RECOVER_SL_TP",
        symbol,
        record: slTpRecord,
        holding,
        existingSlOrder: existingSl,
        existingTpOrder: existingTp,
      });
      continue;
    }

    // Fallback: hold
    plans.push({
      action: "HOLD",
      symbol,
      record: slTpRecord,
      holding,
    });
  }

  return plans;
}

/**
 * Create a minimal dummy AnalysisRecord for HOLD actions that don't have
 * a real signal record (e.g., held symbols without any DB signal).
 */
function makeDummyRecord(
  symbol: string,
  _holding: { quantity: number; costPrice: number },
): AnalysisRecord {
  return {
    id: 0,
    query_id: null,
    code: symbol,
    name: null,
    report_type: null,
    sentiment_score: null,
    operation_advice: "持有",
    trend_prediction: null,
    analysis_summary: null,
    raw_result: null,
    news_content: null,
    context_snapshot: null,
    ideal_buy: null,
    secondary_buy: null,
    stop_loss: null,
    take_profit: null,
    created_at: new Date().toISOString(),
  };
}
