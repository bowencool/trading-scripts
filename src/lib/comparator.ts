import { computeBuyLimitPrice } from "./pricing.js";
import { toLongbridgeSymbol } from "./symbols.js";
import type { ActionPlan, ActiveOrder, AnalysisRecord, PortfolioState } from "./types.js";

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
  priceThresholdPct = Number(process.env.PRICE_THRESHOLD_PCT || "2"),
  completedBuySignalRecordIds: ReadonlySet<number> = new Set<number>(),
  maxHoldings = Number(process.env.MAX_HOLDINGS || "0"),
): ActionPlan[] {
  const plans: ActionPlan[] = [];
  const { plans: conflictPlans, conflictSymbols } = buildConflictingPendingOrderPlans(
    portfolio,
    buySignals,
    sellSignals,
    completedBuySignalRecordIds,
  );
  plans.push(...conflictPlans);

  const processedSymbols = new Set<string>(conflictSymbols);
  const pendingBuySymbols = new Set(
    portfolio.activeOrders.filter((order) => order.role === "buy").map((order) => order.symbol),
  );
  const currentOrPendingHoldingCount =
    portfolio.holdings.size +
    [...pendingBuySymbols].filter((symbol) => !portfolio.holdings.has(symbol)).length;
  const maxNewPositions =
    maxHoldings > 0
      ? Math.max(0, maxHoldings - currentOrPendingHoldingCount)
      : Number.POSITIVE_INFINITY;
  let plannedNewPositions = 0;

  // ── Buy signals ─────────────────────────────────────────────────────────────

  for (const record of buySignals) {
    const symbol = toLongbridgeSymbol(record.code);
    if (!symbol) {
      console.log(`[SKIP] ${record.code} 无法映射到 Longbridge symbol`);
      continue;
    }
    if (processedSymbols.has(symbol)) {
      continue;
    }
    if (completedBuySignalRecordIds.has(record.id)) {
      console.log(`[SKIP] ${symbol} 买入信号 record ${record.id} 已由止盈/止损完结，跳过重复买入`);
      processedSymbols.add(symbol);
      continue;
    }

    const holding = portfolio.holdings.get(symbol);
    const pendingBuy = portfolio.activeOrders.find((o) => o.symbol === symbol && o.role === "buy");
    const isAddPosition = (record.operation_advice ?? "").includes("加仓");

    if (holding) {
      if (!isAddPosition) {
        console.log(`[SKIP] ${symbol} 已持仓 ${holding.quantity} 股，跳过买入信号`);
        continue;
      }

      if (!pendingBuy) {
        const existingSlOrder = portfolio.activeOrders.find(
          (o) => o.symbol === symbol && o.role === "stop_loss",
        );
        const existingTpOrder = portfolio.activeOrders.find(
          (o) => o.symbol === symbol && o.role === "take_profit",
        );
        plans.push({
          action: "ADD_POSITION",
          symbol,
          record,
          holding,
          existingSlOrder,
          existingTpOrder,
        });
        processedSymbols.add(symbol);
        continue;
      }
    }

    if (pendingBuy) {
      // Check if limit price needs updating.
      // biome-ignore lint/style/noNonNullAssertion: buy signals always have ideal_buy
      const targetPrice = record.ideal_buy!;
      const threshold = computeBuyLimitPrice(targetPrice, priceThresholdPct);
      const pendingPrice = Number(pendingBuy.price);
      if (Math.abs(pendingPrice - threshold) / threshold > 0.001) {
        plans.push({
          action: "UPDATE_BUY",
          symbol,
          record,
          pendingBuyOrder: pendingBuy,
        });
      } else {
        console.log(`[HOLD] ${symbol} pending 买单价格已匹配阈值价 (${pendingPrice})，跳过`);
      }
      processedSymbols.add(symbol);
      continue;
    }

    if (plannedNewPositions >= maxNewPositions) {
      console.log(`[SKIP] ${symbol} 已达到最大持仓数 ${maxHoldings}，跳过新开仓`);
      processedSymbols.add(symbol);
      continue;
    }

    plans.push({ action: "NEW_BUY", symbol, record });
    plannedNewPositions++;
    processedSymbols.add(symbol);
  }

  // ── Sell signals ────────────────────────────────────────────────────────────

  for (const record of sellSignals) {
    const symbol = toLongbridgeSymbol(record.code);
    if (!symbol) {
      console.log(`[SKIP] ${record.code} 无法映射到 Longbridge symbol`);
      continue;
    }
    if (processedSymbols.has(symbol)) {
      continue;
    }

    const holding = portfolio.holdings.get(symbol);
    if (!holding) {
      console.log(`[SKIP] ${symbol} 无持仓，跳过卖出信号`);
      processedSymbols.add(symbol);
      continue;
    }

    const isPartial = (record.operation_advice ?? "").includes("减仓");
    const slOrders = portfolio.activeOrders.filter(
      (o) => o.symbol === symbol && o.role === "stop_loss",
    );
    const tpOrders = portfolio.activeOrders.filter(
      (o) => o.symbol === symbol && o.role === "take_profit",
    );
    const ordersToCancel = [...slOrders, ...tpOrders];
    plans.push({
      action: isPartial ? "SELL_PARTIAL" : "SELL_FULL",
      symbol,
      record,
      holding,
      existingSlOrder: slOrders[0],
      existingTpOrder: tpOrders[0],
      sellPct: isPartial ? Number(process.env.SELL_PCT || "50") : undefined,
      ordersToCancel: ordersToCancel.length > 0 ? ordersToCancel : undefined,
    });
    processedSymbols.add(symbol);
  }

  plans.push(...buildHeldSlTpPlans(portfolio, slTpRecords, processedSymbols));
  return plans;
}

/**
 * Build a startup SL/TP preflight plan for held symbols.
 * Symbols with sell signals are skipped because their SL/TP will be cancelled
 * in the sell phase anyway.
 */
export function buildPreflightPlan(
  portfolio: PortfolioState,
  buySignals: AnalysisRecord[],
  sellSignals: AnalysisRecord[],
  slTpRecords: Map<string, AnalysisRecord>,
  completedBuySignalRecordIds: ReadonlySet<number> = new Set<number>(),
): ActionPlan[] {
  const { plans: conflictPlans, conflictSymbols } = buildConflictingPendingOrderPlans(
    portfolio,
    buySignals,
    sellSignals,
    completedBuySignalRecordIds,
  );
  const sellSymbols = new Set(
    sellSignals
      .map((record) => toLongbridgeSymbol(record.code))
      .filter((symbol): symbol is string => Boolean(symbol)),
  );

  for (const symbol of sellSymbols) {
    if (portfolio.holdings.has(symbol)) {
      console.log(`[SKIP] ${symbol} 有卖出信号，预检查阶段不调整 SL/TP`);
    }
  }

  const skippedSymbols = new Set([...sellSymbols, ...conflictSymbols]);
  return [...conflictPlans, ...buildHeldSlTpPlans(portfolio, slTpRecords, skippedSymbols)];
}

/**
 * Apply the expected preflight result to the in-memory portfolio state so
 * dry-run can render the post-normalization trade plan without mutating live
 * orders.
 */
export function projectPortfolioAfterPreflight(
  portfolio: PortfolioState,
  preflightPlans: ActionPlan[],
): PortfolioState {
  const projected: PortfolioState = {
    holdings: new Map(
      [...portfolio.holdings.entries()].map(([symbol, holding]) => [symbol, { ...holding }]),
    ),
    activeOrders: portfolio.activeOrders.map((order) => ({ ...order })),
    orphanWarnings: [...portfolio.orphanWarnings],
  };

  for (const plan of preflightPlans) {
    if (plan.action === "CANCEL_CONFLICTING_ORDERS") {
      const orderIds = new Set((plan.ordersToCancel ?? []).map((order) => order.orderId));
      projected.activeOrders = projected.activeOrders.filter(
        (order) => !orderIds.has(order.orderId),
      );
      continue;
    }

    if (!plan.holding) continue;
    const holding = plan.holding;

    if (plan.action === "MERGE_SL_TP") {
      projected.activeOrders = projected.activeOrders.filter(
        (order) =>
          !(
            order.symbol === plan.symbol &&
            (order.role === "stop_loss" || order.role === "take_profit")
          ),
      );
      appendProjectedSlTpOrders(projected.activeOrders, plan.symbol, plan.record, holding.quantity);
      projected.orphanWarnings = projected.orphanWarnings.filter(
        (symbol) => symbol !== plan.symbol,
      );
      continue;
    }

    if (plan.action === "RECOVER_SL_TP") {
      if (!plan.existingSlOrder && plan.record.stop_loss != null) {
        projected.activeOrders.push(
          makeProjectedOrder(plan.symbol, "stop_loss", plan.record, holding.quantity),
        );
      }
      if (!plan.existingTpOrder && plan.record.take_profit != null) {
        projected.activeOrders.push(
          makeProjectedOrder(plan.symbol, "take_profit", plan.record, holding.quantity),
        );
      }
      projected.orphanWarnings = projected.orphanWarnings.filter(
        (symbol) => symbol !== plan.symbol,
      );
      continue;
    }

    if (plan.action === "SYNC_SL_TP") {
      projected.activeOrders = projected.activeOrders.map((order) => {
        if (plan.existingSlOrder && order.orderId === plan.existingSlOrder.orderId) {
          return syncProjectedOrder(order, plan.record.stop_loss, holding.quantity);
        }
        if (plan.existingTpOrder && order.orderId === plan.existingTpOrder.orderId) {
          return syncProjectedOrder(order, plan.record.take_profit, holding.quantity);
        }
        return order;
      });
      projected.orphanWarnings = projected.orphanWarnings.filter(
        (symbol) => symbol !== plan.symbol,
      );
    }
  }

  return projected;
}

function buildHeldSlTpPlans(
  portfolio: PortfolioState,
  slTpRecords: Map<string, AnalysisRecord>,
  skippedSymbols: Set<string>,
): ActionPlan[] {
  const plans: ActionPlan[] = [];

  // ── SL/TP reconciliation for held symbols ─────────────────────────────────

  for (const [symbol, holding] of portfolio.holdings) {
    if (skippedSymbols.has(symbol)) continue;

    const slOrders = portfolio.activeOrders.filter(
      (o) => o.symbol === symbol && o.role === "stop_loss",
    );
    const tpOrders = portfolio.activeOrders.filter(
      (o) => o.symbol === symbol && o.role === "take_profit",
    );

    const slTpRecord = slTpRecords.get(symbol);

    if (!slTpRecord) {
      plans.push({ action: "HOLD", symbol, record: makeDummyRecord(symbol), holding });
      continue;
    }

    const hasSl = slTpRecord.stop_loss != null;
    const hasTp = slTpRecord.take_profit != null;

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

    const existingSl = slOrders.length > 0 ? slOrders[0] : undefined;
    const existingTp = tpOrders.length > 0 ? tpOrders[0] : undefined;

    if (!existingSl && !existingTp) {
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

    const existingSlQty = existingSl ? Number(existingSl.quantity) : 0;
    const existingTpQty = existingTp ? Number(existingTp.quantity) : 0;
    const slQtyMismatch = hasSl && existingSl && existingSlQty !== holding.quantity;
    const tpQtyMismatch = hasTp && existingTp && existingTpQty !== holding.quantity;

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

    plans.push({
      action: "HOLD",
      symbol,
      record: slTpRecord,
      holding,
      existingSlOrder: existingSl,
      existingTpOrder: existingTp,
    });
  }

  return plans;
}

function buildConflictingPendingOrderPlans(
  portfolio: PortfolioState,
  buySignals: AnalysisRecord[],
  sellSignals: AnalysisRecord[],
  completedBuySignalRecordIds: ReadonlySet<number>,
): {
  plans: ActionPlan[];
  conflictSymbols: Set<string>;
} {
  const buySignalsBySymbol = new Map<string, AnalysisRecord>();
  const sellSignalsBySymbol = new Map<string, AnalysisRecord>();

  for (const record of buySignals) {
    if (completedBuySignalRecordIds.has(record.id)) {
      continue;
    }
    const symbol = toLongbridgeSymbol(record.code);
    if (symbol) {
      buySignalsBySymbol.set(symbol, record);
    }
  }

  for (const record of sellSignals) {
    const symbol = toLongbridgeSymbol(record.code);
    if (symbol) {
      sellSignalsBySymbol.set(symbol, record);
    }
  }

  const grouped = new Map<string, { record: AnalysisRecord; orders: ActiveOrder[] }>();

  for (const order of portfolio.activeOrders) {
    let record: AnalysisRecord | undefined;
    if (order.role === "buy") {
      record = sellSignalsBySymbol.get(order.symbol);
    } else if (order.role === "sell") {
      record = buySignalsBySymbol.get(order.symbol);
    } else {
      continue;
    }

    if (!record) {
      continue;
    }

    const existing = grouped.get(order.symbol);
    if (existing) {
      existing.orders.push(order);
      continue;
    }

    grouped.set(order.symbol, { record, orders: [order] });
  }

  const plans: ActionPlan[] = [];
  const conflictSymbols = new Set<string>();

  for (const [symbol, { record, orders }] of grouped) {
    console.log(
      `[CANCEL] ${symbol} 最新信号为 ${record.operation_advice ?? "-"}，取消冲突挂单 ${orders.map((order) => order.orderId).join(", ")}`,
    );
    plans.push({
      action: "CANCEL_CONFLICTING_ORDERS",
      symbol,
      record,
      ordersToCancel: orders,
    });
    conflictSymbols.add(symbol);
  }

  return { plans, conflictSymbols };
}

/**
 * Create a minimal dummy AnalysisRecord for HOLD actions that don't have
 * a real signal record (e.g., held symbols without any DB signal).
 */
function makeDummyRecord(symbol: string): AnalysisRecord {
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

function makeProjectedOrder(
  symbol: string,
  role: "stop_loss" | "take_profit",
  record: AnalysisRecord,
  quantity: number,
): ActiveOrder {
  const trigger = role === "stop_loss" ? record.stop_loss : record.take_profit;

  return {
    orderId: "",
    symbol,
    side: "Sell",
    orderType: role === "stop_loss" ? "MIT" : "LIT",
    price: role === "take_profit" && trigger != null ? String(trigger) : "0",
    triggerPrice: trigger != null ? String(trigger) : "0",
    quantity: String(quantity),
    status: "Projected",
    role,
    remark: role === "stop_loss" ? `auto-trade:sl:${record.id}` : `auto-trade:tp:${record.id}`,
  };
}

function appendProjectedSlTpOrders(
  activeOrders: ActiveOrder[],
  symbol: string,
  record: AnalysisRecord,
  quantity: number,
): void {
  if (record.stop_loss != null) {
    activeOrders.push(makeProjectedOrder(symbol, "stop_loss", record, quantity));
  }
  if (record.take_profit != null) {
    activeOrders.push(makeProjectedOrder(symbol, "take_profit", record, quantity));
  }
}

function syncProjectedOrder(
  order: ActiveOrder,
  trigger: number | null,
  quantity: number,
): ActiveOrder {
  if (trigger == null) {
    return order;
  }

  return {
    ...order,
    quantity: String(quantity),
    triggerPrice: String(trigger),
    price: order.role === "take_profit" ? String(trigger) : order.price,
  };
}
