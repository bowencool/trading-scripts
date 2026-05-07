import { OrderStatus, type TradeContext } from "longbridge";
import { isAutoTradeRemark, parseRemarkRole } from "./symbols.js";

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

  // Fetch holdings, today's orders, and history pending orders in parallel
  const [positionsResp, todayOrders, historyOrdersResp] = await Promise.all([
    tradeCtx.stockPositions(),
    tradeCtx.todayOrders(),
    tradeCtx.historyOrders({
      status: ACTIVE_HISTORY_STATUSES,
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
  for (const order of historyOrdersResp) {
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

    // 2. OCO cleanup: if SL filled but TP still active, cancel TP (and vice versa)
    const filledSl = allSlOrders.filter((o) => o.status === OrderStatus.Filled);
    const filledTp = allTpOrders.filter((o) => o.status === OrderStatus.Filled);

    if (filledSl.length > 0) {
      for (const tp of activeTpOrders) {
        try {
          await tradeCtx.cancelOrder(tp.orderId);
          console.log(`[OCO] 止损已成交，取消止盈 ${tp.orderId} (${symbol})`);
          cleaned++;
        } catch (err) {
          console.error(`[WARN] 取消止盈 ${tp.orderId} 失败: ${err}`);
        }
        await delay(API_DELAY_MS);
      }
    }

    if (filledTp.length > 0) {
      for (const sl of activeSlOrders) {
        try {
          await tradeCtx.cancelOrder(sl.orderId);
          console.log(`[OCO] 止盈已成交，取消止损 ${sl.orderId} (${symbol})`);
          cleaned++;
        } catch (err) {
          console.error(`[WARN] 取消止损 ${sl.orderId} 失败: ${err}`);
        }
        await delay(API_DELAY_MS);
      }
    }
  }

  if (cleaned > 0) {
    console.log(`✅ 清理完成，共取消 ${cleaned} 个孤儿订单`);
  } else {
    console.log("✅ 无孤儿订单");
  }
}
