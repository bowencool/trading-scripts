import { OrderStatus, type TradeContext } from "longbridge";
import { isAutoTradeRemark, parseRemarkRecordId, parseRemarkRole } from "./symbols.js";

const API_DELAY_MS = 200;
const HISTORY_DAYS = 30;
const ACTIVE_HISTORY_STATUSES = [
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
];
const FILLED_HISTORY_STATUSES = [OrderStatus.Filled];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTerminal(status: OrderStatus): boolean {
  return (
    status === OrderStatus.Filled ||
    status === OrderStatus.Canceled ||
    status === OrderStatus.Rejected ||
    status === OrderStatus.Expired
  );
}

interface OcoOrderLike {
  orderId: string;
  status: OrderStatus;
  remark?: string | null;
}

export function selectOcoOrdersToCancel<T extends OcoOrderLike>(orders: T[]): T[] {
  const filledRolesByRecordId = new Map<string, Set<"stop_loss" | "take_profit">>();

  for (const order of orders) {
    const role = parseRemarkRole(order.remark ?? "");
    const recordId = parseRemarkRecordId(order.remark ?? "");
    if (!recordId || (role !== "stop_loss" && role !== "take_profit")) {
      continue;
    }

    if (order.status !== OrderStatus.Filled) {
      continue;
    }

    const filledRoles =
      filledRolesByRecordId.get(recordId) ?? new Set<"stop_loss" | "take_profit">();
    filledRoles.add(role);
    filledRolesByRecordId.set(recordId, filledRoles);
  }

  const selected: T[] = [];
  const seenOrderIds = new Set<string>();

  for (const order of orders) {
    const role = parseRemarkRole(order.remark ?? "");
    const recordId = parseRemarkRecordId(order.remark ?? "");
    if (!recordId || !role || isTerminal(order.status)) {
      continue;
    }

    const filledRoles = filledRolesByRecordId.get(recordId);
    if (!filledRoles) {
      continue;
    }

    const oppositeRole =
      role === "stop_loss" ? "take_profit" : role === "take_profit" ? "stop_loss" : null;
    if (!oppositeRole || !filledRoles.has(oppositeRole) || seenOrderIds.has(order.orderId)) {
      continue;
    }

    seenOrderIds.add(order.orderId);
    selected.push(order);
  }

  return selected;
}

/**
 * Clean up orphaned orders based on portfolio state + todayOrders() + historyOrders():
 *
 * 1. **Orphan SL/TP**: symbol has SL/TP but NO holding AND no pending buy → cancel
 *    (uses stockPositions() so cross-day filled buys are correctly detected)
 * 2. **OCO cleanup**: SL filled but TP still active (or vice versa) → cancel the other
 */
export async function cleanupOrphanedOrders(tradeCtx: TradeContext): Promise<void> {
  console.log("🧹 清理孤儿订单...");

  const endAt = new Date();
  const startAt = new Date(endAt.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);

  // Fetch holdings, today's orders, history pending orders, and filled history
  // in parallel. Filled history is only used to determine whether the opposite
  // side of an OCO pair has already completed.
  const [positionsResp, todayOrders, historyActiveOrdersResp, historyFilledOrdersResp] =
    await Promise.all([
      tradeCtx.stockPositions(),
      tradeCtx.todayOrders(),
      tradeCtx.historyOrders({
        status: ACTIVE_HISTORY_STATUSES,
        startAt,
        endAt,
      }),
      tradeCtx.historyOrders({
        status: FILLED_HISTORY_STATUSES,
        startAt,
        endAt,
      }),
    ]);

  const heldSymbols = new Set<string>();
  for (const pos of positionsResp.channels.flatMap((ch) => ch.positions)) {
    if (Number(pos.quantity.toString()) > 0) {
      heldSymbols.add(pos.symbol);
    }
  }

  // Merge today's + history orders, dedup by orderId (today takes priority)
  const seenIds = new Set<string>();
  const allOrders: typeof todayOrders = [];
  for (const order of todayOrders) {
    if (!seenIds.has(order.orderId)) {
      allOrders.push(order);
      seenIds.add(order.orderId);
    }
  }
  for (const order of historyActiveOrdersResp) {
    if (!seenIds.has(order.orderId)) {
      allOrders.push(order);
      seenIds.add(order.orderId);
    }
  }
  for (const order of historyFilledOrdersResp) {
    if (!seenIds.has(order.orderId)) {
      allOrders.push(order);
      seenIds.add(order.orderId);
    }
  }

  const ourOrders = allOrders.filter((o) => isAutoTradeRemark(o.remark ?? ""));

  // Group orders by symbol
  const bySymbol = new Map<string, typeof ourOrders>();
  for (const order of ourOrders) {
    const existing = bySymbol.get(order.symbol) ?? [];
    existing.push(order);
    bySymbol.set(order.symbol, existing);
  }

  let cleaned = 0;

  for (const [symbol, orders] of bySymbol) {
    const allSlOrders = orders.filter((o) => parseRemarkRole(o.remark ?? "") === "stop_loss");
    const allTpOrders = orders.filter((o) => parseRemarkRole(o.remark ?? "") === "take_profit");
    const activeSlOrders = allSlOrders.filter((o) => !isTerminal(o.status));
    const activeTpOrders = allTpOrders.filter((o) => !isTerminal(o.status));

    // 1. Orphan cleanup: cancel SL/TP only if symbol is NOT held AND no pending buy
    if (activeSlOrders.length > 0 || activeTpOrders.length > 0) {
      const hasHolding = heldSymbols.has(symbol);
      const hasPendingBuy = orders.some(
        (o) => parseRemarkRole(o.remark ?? "") === "buy" && !isTerminal(o.status),
      );

      if (!hasHolding && !hasPendingBuy) {
        for (const slTp of [...activeSlOrders, ...activeTpOrders]) {
          try {
            await tradeCtx.cancelOrder(slTp.orderId);
            const role = parseRemarkRole(slTp.remark ?? "") === "stop_loss" ? "止损" : "止盈";
            console.log(`[CANCEL] 已取消孤儿${role}订单 ${slTp.orderId} (${symbol} 无持仓)`);
            cleaned++;
          } catch (err) {
            console.error(`[WARN] 取消订单 ${slTp.orderId} 失败: ${err}`);
          }
          await delay(API_DELAY_MS);
        }
      }
    }

    // 2. OCO cleanup: only cancel the opposite order from the same signal record
    const ocoOrdersToCancel = selectOcoOrdersToCancel(orders);

    for (const order of ocoOrdersToCancel) {
      const role = parseRemarkRole(order.remark ?? "");
      const recordId = parseRemarkRecordId(order.remark ?? "") ?? "?";
      const label = role === "take_profit" ? "止盈" : role === "stop_loss" ? "止损" : "订单";
      const cause = role === "take_profit" ? "止损已成交" : "止盈已成交";
      try {
        await tradeCtx.cancelOrder(order.orderId);
        console.log(
          `[OCO] ${cause}，取消${label} ${order.orderId} (${symbol}, record ${recordId})`,
        );
        cleaned++;
      } catch (err) {
        console.error(`[WARN] 取消${label} ${order.orderId} 失败: ${err}`);
      }
      await delay(API_DELAY_MS);
    }
  }

  if (cleaned > 0) {
    console.log(`✅ 清理完成，共取消 ${cleaned} 个孤儿订单`);
  } else {
    console.log("✅ 无孤儿订单");
  }
}
