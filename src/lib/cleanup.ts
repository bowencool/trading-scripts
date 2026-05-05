import { TradeContext, OrderStatus } from "longbridge";
import { loadTrackedOrders, pruneExpiredOrders, removeOrder } from "./tracker.js";

/** Terminal states where the order is no longer active on the exchange. */
function isTerminal(status: OrderStatus): boolean {
  return (
    status === OrderStatus.Filled ||
    status === OrderStatus.Canceled ||
    status === OrderStatus.Rejected ||
    status === OrderStatus.Expired
  );
}

export async function cleanupOrphanedOrders(tradeCtx: TradeContext): Promise<void> {
  console.log("🧹 清理孤儿订单...");
  const orders = loadTrackedOrders();
  const slTpOrders = orders.filter((o) => o.role === "stop_loss" || o.role === "take_profit");
  const buyOrderIds = new Set(orders.filter((o) => o.role === "buy").map((o) => o.orderId));

  let cleaned = 0;
  for (const slTp of slTpOrders) {
    if (!slTp.linkedBuyOrderId || !buyOrderIds.has(slTp.linkedBuyOrderId)) {
      try {
        await tradeCtx.cancelOrder(slTp.orderId);
        console.log(`[CANCEL] 已取消孤立订单 ${slTp.orderId} (${slTp.role}, ${slTp.symbol})`);
        removeOrder(slTp.orderId);
        cleaned++;
      } catch (err) {
        console.error(`[WARN] 取消订单 ${slTp.orderId} 失败: ${err}`);
      }
      continue;
    }
    try {
      const buyDetail = await tradeCtx.orderDetail(slTp.linkedBuyOrderId);
      if (buyDetail.status === OrderStatus.Canceled || buyDetail.status === OrderStatus.Expired || buyDetail.status === OrderStatus.Rejected) {
        await tradeCtx.cancelOrder(slTp.orderId);
        const statusName = buyDetail.status === OrderStatus.Canceled ? "Canceled" : buyDetail.status === OrderStatus.Expired ? "Expired" : "Rejected";
        console.log(`[CANCEL] 买单 ${slTp.linkedBuyOrderId} 已${statusName}，取消关联订单 ${slTp.orderId} (${slTp.role})`);
        removeOrder(slTp.orderId);
        cleaned++;
      }
    } catch (err) {
      console.error(`[WARN] 查询买单 ${slTp.linkedBuyOrderId} 失败: ${err}`);
    }
  }
  if (cleaned > 0) {
    console.log(`✅ 清理完成，共取消 ${cleaned} 个孤儿订单`);
  } else {
    console.log("✅ 无孤儿订单");
  }
}

/**
 * OCO cleanup: for each SL/TP order that has an ocoPairOrderId,
 * check if the pair has been filled. If so, cancel this order.
 * This prevents the scenario where SL triggers → stock sold → TP still live → unintended short.
 */
export async function cleanupOcoOrders(tradeCtx: TradeContext): Promise<void> {
  console.log("🔗 检查 OCO 互斥订单...");
  const orders = loadTrackedOrders();
  const ocoOrders = orders.filter(
    (o) => (o.role === "stop_loss" || o.role === "take_profit") && o.ocoPairOrderId
  );

  if (ocoOrders.length === 0) {
    console.log("✅ 无 OCO 订单");
    return;
  }

  // Deduplicate: each pair appears twice (A→B and B→A), only process once
  const processed = new Set<string>();
  let ocoCleaned = 0;

  for (const order of ocoOrders) {
    const pairId = order.ocoPairOrderId!;
    const pairKey = [order.orderId, pairId].sort().join(":");
    if (processed.has(pairKey)) continue;
    processed.add(pairKey);

    try {
      const [detail, pairDetail] = await Promise.all([
        tradeCtx.orderDetail(order.orderId),
        tradeCtx.orderDetail(pairId),
      ]);

      // If both already in terminal state, just clean up tracking
      if (isTerminal(detail.status) && isTerminal(pairDetail.status)) {
        if (detail.status === OrderStatus.Filled || pairDetail.status === OrderStatus.Filled) {
          console.log(
            `[OCO] 订单 ${order.orderId} (${order.role}) 与 ${pairId} 均已结束，清理跟踪记录`
          );
          removeOrder(order.orderId);
          removeOrder(pairId);
          ocoCleaned++;
        }
        continue;
      }

      // If this order is filled but pair is still active → cancel pair
      if (detail.status === OrderStatus.Filled && !isTerminal(pairDetail.status)) {
        try {
          await tradeCtx.cancelOrder(pairId);
          console.log(
            `[OCO] ${order.role === "stop_loss" ? "止损" : "止盈"} ${order.orderId} 已成交，取消对端 ${pairId}`
          );
          removeOrder(order.orderId);
          removeOrder(pairId);
          ocoCleaned++;
        } catch (err) {
          console.error(`[WARN] OCO 取消对端 ${pairId} 失败: ${err}`);
        }
        continue;
      }

      // If pair is filled but this order is still active → cancel this order
      if (pairDetail.status === OrderStatus.Filled && !isTerminal(detail.status)) {
        try {
          await tradeCtx.cancelOrder(order.orderId);
          console.log(
            `[OCO] 对端 ${pairId} 已成交，取消 ${order.role === "stop_loss" ? "止损" : "止盈"} ${order.orderId}`
          );
          removeOrder(order.orderId);
          removeOrder(pairId);
          ocoCleaned++;
        } catch (err) {
          console.error(`[WARN] OCO 取消订单 ${order.orderId} 失败: ${err}`);
        }
      }
    } catch (err) {
      console.error(`[WARN] OCO 查询订单 ${order.orderId}/${pairId} 失败: ${err}`);
    }
  }

  if (ocoCleaned > 0) {
    console.log(`✅ OCO 清理完成，处理 ${ocoCleaned} 对`);
  } else {
    console.log("✅ 无需处理的 OCO 订单");
  }
}

export { pruneExpiredOrders } from "./tracker.js";
