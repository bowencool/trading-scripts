import type { BrokerAdapter } from "./providers/broker.js";
import type { BrokerOrder, Position } from "./providers/types.js";
import { isAutoTradeRemark } from "./symbols.js";
import type { ActiveOrder, Holding, PortfolioState } from "./types.js";

const HISTORY_DAYS = 30;

export interface PortfolioSnapshot {
  positions: Position[];
  todayOrders: BrokerOrder[];
  historyOrders: BrokerOrder[];
}

function toActiveOrder(order: BrokerOrder): ActiveOrder | null {
  if (order.status !== "pending" && order.status !== "partially-filled") return null;
  if (!isAutoTradeRemark(order.remark) || order.role === "unknown") return null;
  if (order.side === "unknown") return null;

  return {
    orderId: order.id,
    symbol: order.instrument.symbol,
    side: order.side === "buy" ? "Buy" : "Sell",
    orderType: order.type,
    price: String(order.price ?? 0),
    triggerPrice: String(order.triggerPrice ?? 0),
    quantity: String(order.quantity),
    status: order.status,
    role: order.role,
    remark: order.remark,
  };
}

/** Build the business portfolio model from provider-neutral positions and orders. */
export function buildPortfolioStateFromSnapshot(
  snapshot: PortfolioSnapshot,
  strictSlTpCheck = false,
): PortfolioState {
  const holdings = new Map<string, Holding>();
  for (const position of snapshot.positions) {
    if (position.quantity <= 0) continue;
    const symbol = position.instrument.symbol;
    holdings.set(symbol, {
      symbol,
      instrument: position.instrument,
      quantity: position.quantity,
      availableQuantity: position.availableQuantity,
      costPrice: position.costPrice,
    });
  }

  const activeOrders: ActiveOrder[] = [];
  const seenOrderIds = new Set<string>();
  const todayFilledBuys = new Set<string>();

  for (const order of snapshot.todayOrders) {
    if (isAutoTradeRemark(order.remark) && order.role === "buy" && order.status === "filled") {
      todayFilledBuys.add(order.instrument.symbol);
    }
    const parsed = toActiveOrder(order);
    if (parsed) {
      activeOrders.push(parsed);
      seenOrderIds.add(parsed.orderId);
    }
  }

  let historyAdded = 0;
  for (const order of snapshot.historyOrders) {
    if (seenOrderIds.has(order.id)) continue;
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

  const symbolsWithSlTp = new Set(
    activeOrders
      .filter((order) => order.role === "stop_loss" || order.role === "take_profit")
      .map((order) => order.symbol),
  );

  const orphanWarnings: string[] = [];
  for (const symbol of holdings.keys()) {
    if (!symbolsWithSlTp.has(symbol) && (todayFilledBuys.has(symbol) || strictSlTpCheck)) {
      orphanWarnings.push(symbol);
    } else if (!symbolsWithSlTp.has(symbol)) {
      console.log(`[INFO] ${symbol} 跨日持仓，未找到活跃 SL/TP 订单，跳过`);
    }
  }
  if (orphanWarnings.length > 0) {
    console.warn(`[WARN] 以下持仓缺少 SL/TP，需要恢复检查: ${orphanWarnings.join(", ")}`);
  }

  return { holdings, activeOrders, orphanWarnings };
}

export async function fetchPortfolioState(
  broker: BrokerAdapter,
  strictSlTpCheck = false,
): Promise<PortfolioState> {
  const positions = await broker.getPositions();
  const todayOrders = await broker.listOrders({ scope: "today" });
  const endAt = new Date();
  const startAt = new Date(endAt.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const historyOrders = await broker.listOrders({
    scope: "history",
    statuses: ["pending", "partially-filled"],
    startAt,
    endAt,
  });

  return buildPortfolioStateFromSnapshot(
    { positions, todayOrders, historyOrders },
    strictSlTpCheck,
  );
}
