import { OrderSide, OrderStatus, type TradeContext, TriggerStatus } from "longbridge";
import { isAutoTradeRemark, parseRemarkRole } from "./symbols.js";
import type { ActiveOrder as ActiveOrderParsed, Holding, PortfolioState } from "./types.js";

/** How many days back to search for GTC orders. */
const HISTORY_DAYS = 30;

/** Pending states that indicate an order is still active on the exchange. */
const PENDING_STATUSES = new Set([
  OrderStatus.New,
  OrderStatus.NotReported,
  OrderStatus.ReplacedNotReported,
  OrderStatus.ProtectedNotReported,
  OrderStatus.VarietiesNotReported,
  OrderStatus.WaitToNew,
  OrderStatus.WaitToReplace,
  OrderStatus.PendingReplace,
  OrderStatus.PartialFilled,
  OrderStatus.WaitToCancel,
  OrderStatus.PendingCancel,
]);

export interface PortfolioSnapshot {
  positionsResp: Awaited<ReturnType<TradeContext["stockPositions"]>>;
  todayOrders: Awaited<ReturnType<TradeContext["todayOrders"]>>;
  historyOrdersResp: Awaited<ReturnType<TradeContext["historyOrders"]>>;
}

function isPending(status: OrderStatus, triggerStatus: TriggerStatus | null | undefined): boolean {
  if (triggerStatus === TriggerStatus.Active) {
    return true;
  }
  return PENDING_STATUSES.has(status);
}

/**
 * Parse Longbridge OrderStatus to a human-readable string for logging.
 */
function orderStatusName(status: OrderStatus): string {
  switch (status) {
    case OrderStatus.Filled:
      return "Filled";
    case OrderStatus.Canceled:
      return "Canceled";
    case OrderStatus.Rejected:
      return "Rejected";
    case OrderStatus.Expired:
      return "Expired";
    case OrderStatus.New:
      return "New";
    case OrderStatus.PartialFilled:
      return "PartialFilled";
    case OrderStatus.NotReported:
      return "NotReported";
    case OrderStatus.VarietiesNotReported:
      return "VarietiesNotReported";
    case OrderStatus.PendingReplace:
      return "PendingReplace";
    case OrderStatus.PendingCancel:
      return "PendingCancel";
    default:
      return `Status(${status})`;
  }
}

function toActiveOrder(order: {
  orderId: string;
  symbol: string;
  side: OrderSide;
  orderType: unknown;
  price: { toString(): string } | null;
  triggerPrice: { toString(): string } | null;
  quantity: { toString(): string };
  status: OrderStatus;
  triggerStatus: TriggerStatus | null;
  remark: string;
}): ActiveOrderParsed | null {
  if (!isPending(order.status, order.triggerStatus)) return null;
  const remark = order.remark ?? "";
  if (!isAutoTradeRemark(remark)) return null;
  const role = parseRemarkRole(remark);
  if (!role) return null;

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    side: order.side === OrderSide.Buy ? "Buy" : "Sell",
    orderType: String(order.orderType),
    price: order.price?.toString() ?? "0",
    triggerPrice: order.triggerPrice?.toString() ?? "0",
    quantity: order.quantity?.toString() ?? "0",
    status: orderStatusName(order.status),
    role,
    remark,
  };
}

/**
 * Build portfolio state from prefetched Longbridge responses:
 * - Holdings via stockPositions()
 * - Active orders via todayOrders() + historyOrders() (for GTC SL/TP)
 * - For held symbols without SL/TP: check if a buy was filled today (→ needs RECOVER)
 *   vs. cross-day holding (→ SL/TP exists as GTC, don't touch)
 */
export function buildPortfolioStateFromSnapshot(
  snapshot: PortfolioSnapshot,
  strictSlTpCheck = false,
): PortfolioState {
  const { positionsResp, todayOrders, historyOrdersResp } = snapshot;
  const allPositions = positionsResp.channels.flatMap((ch) => ch.positions);

  const holdings = new Map<string, Holding>();
  for (const pos of allPositions) {
    const symbol = pos.symbol;
    const quantity = Number(pos.quantity.toString());
    if (quantity <= 0) continue;
    holdings.set(symbol, {
      symbol,
      quantity,
      availableQuantity: Number(pos.availableQuantity.toString()),
      costPrice: Number(pos.costPrice.toString()),
    });
  }

  const activeOrders: ActiveOrderParsed[] = [];
  const seenOrderIds = new Set<string>();

  // Track which symbols had a buy order filled today
  const todayFilledBuys = new Set<string>();

  for (const order of todayOrders) {
    const remark = order.remark ?? "";
    if (isAutoTradeRemark(remark)) {
      const role = parseRemarkRole(remark);
      if (role === "buy" && order.status === OrderStatus.Filled) {
        todayFilledBuys.add(order.symbol);
      }
    }
    const parsed = toActiveOrder(order);
    if (parsed) {
      activeOrders.push(parsed);
      seenOrderIds.add(parsed.orderId);
    }
  }

  // Add history GTC orders not already in today's list
  let historyAdded = 0;
  for (const order of historyOrdersResp) {
    if (seenOrderIds.has(order.orderId)) continue;
    const parsed = toActiveOrder(order);
    if (parsed) {
      activeOrders.push(parsed);
      seenOrderIds.add(parsed.orderId);
      historyAdded++;
    }
  }
  if (historyAdded > 0) {
    console.log(`[INFO] 从历史订单中额外发现 ${historyAdded} 个 GTC 挂单`);
  }

  // 3. Determine which held symbols need SL/TP recovery
  //    Only RECOVER if a buy was filled today (crash scenario).
  //    Cross-day holdings likely have GTC SL/TP that the API can't see.
  const symbolsWithSlTp = new Set(
    activeOrders
      .filter((o) => o.role === "stop_loss" || o.role === "take_profit")
      .map((o) => o.symbol),
  );

  const orphanWarnings: string[] = [];
  for (const symbol of holdings.keys()) {
    if (!symbolsWithSlTp.has(symbol) && (todayFilledBuys.has(symbol) || strictSlTpCheck)) {
      // Missing visible SL/TP and selected for recovery.
      orphanWarnings.push(symbol);
    } else if (!symbolsWithSlTp.has(symbol)) {
      // Cross-day holding without visible SL/TP → GTC orders exist, leave alone
      console.log(`[INFO] ${symbol} 跨日持仓，未找到活跃 SL/TP 订单，跳过`);
    }
  }

  if (orphanWarnings.length > 0) {
    console.warn(`[WARN] 以下持仓缺少 SL/TP，需要恢复检查: ${orphanWarnings.join(", ")}`);
  }

  return { holdings, activeOrders, orphanWarnings };
}

/**
 * Fetch current portfolio state from Longbridge API:
 * - Holdings via stockPositions()
 * - Active orders via todayOrders() + historyOrders() (for GTC SL/TP)
 * - For held symbols without SL/TP: check if a buy was filled today (→ needs RECOVER)
 *   vs. cross-day holding (→ SL/TP exists as GTC, don't touch)
 */
export async function fetchPortfolioState(
  tradeCtx: TradeContext,
  strictSlTpCheck = false,
): Promise<PortfolioState> {
  const positionsResp = await tradeCtx.stockPositions();

  const endAt = new Date();
  const startAt = new Date(endAt.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);

  const [todayOrders, historyOrdersResp] = await Promise.all([
    tradeCtx.todayOrders(),
    tradeCtx.historyOrders({
      status: [
        OrderStatus.New,
        OrderStatus.NotReported,
        OrderStatus.ReplacedNotReported,
        OrderStatus.ProtectedNotReported,
        OrderStatus.VarietiesNotReported,
        OrderStatus.WaitToNew,
        OrderStatus.WaitToReplace,
        OrderStatus.PendingReplace,
        OrderStatus.PartialFilled,
        OrderStatus.WaitToCancel,
        OrderStatus.PendingCancel,
      ],
      startAt,
      endAt,
    }),
  ]);

  return buildPortfolioStateFromSnapshot(
    {
      positionsResp,
      todayOrders,
      historyOrdersResp,
    },
    strictSlTpCheck,
  );
}
