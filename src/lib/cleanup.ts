import { OrderStatus, type TradeContext } from "longbridge";
import { loadTrackedOrders, removeOrder } from "./tracker.js";
import { isTerminal, orderStatusName } from "./utils.js";

/**
 * Check tracked buy/sell orders via API and remove any that have reached a
 * terminal state without being Filled. This frees their signalRecordIds so
 * the signals can be re-processed on the next run.
 */
export async function pruneStaleBuyOrders(tradeCtx: TradeContext): Promise<void> {
  console.log("🔍 检查已追踪订单状态...");
  const orders = loadTrackedOrders();
  const buySellOrders = orders.filter((o) => o.role === "buy" || o.role === "sell");

  let pruned = 0;
  const results = await Promise.allSettled(
    buySellOrders.map(async (order) => {
      const detail = await tradeCtx.orderDetail(order.orderId);
      return { order, detail };
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn(`[WARN] 查询订单状态失败: ${result.reason}`);
      continue;
    }
    const { order, detail } = result.value;
    if (isTerminal(detail.status) && detail.status !== OrderStatus.Filled) {
      const statusName =
        detail.status === OrderStatus.Canceled
          ? "已撤单"
          : detail.status === OrderStatus.Expired
            ? "已过期"
            : detail.status === OrderStatus.Rejected
              ? "被拒绝"
              : `状态${detail.status}`;
      console.log(
        `[PRUNE] ${order.symbol} ${order.orderId} ${statusName}，移除跟踪记录（信号 ${order.signalRecordId} 可重新处理）`,
      );
      removeOrder(order.orderId);
      pruned++;
    }
  }

  if (pruned > 0) {
    console.log(`✅ 已清理 ${pruned} 条过期订单记录`);
  } else {
    console.log("✅ 已追踪订单均有效");
  }
}

export async function cleanupOrphanedOrders(tradeCtx: TradeContext): Promise<void> {
  console.log("🧹 清理孤儿订单...");
  const orders = loadTrackedOrders();
  const slTpOrders = orders.filter((o) => o.role === "stop_loss" || o.role === "take_profit");
  const buyOrderIds = new Set(orders.filter((o) => o.role === "buy").map((o) => o.orderId));

  // Partition: orphaned (no linked buy) vs linked (need to check buy status)
  const orphaned = slTpOrders.filter(
    (o) => !o.linkedBuyOrderId || !buyOrderIds.has(o.linkedBuyOrderId),
  );
  const linked = slTpOrders.filter(
    (o) => o.linkedBuyOrderId && buyOrderIds.has(o.linkedBuyOrderId),
  );

  let cleaned = 0;

  // Cancel orphaned orders directly
  for (const slTp of orphaned) {
    try {
      await tradeCtx.cancelOrder(slTp.orderId);
      console.log(`[CANCEL] 已取消孤立订单 ${slTp.orderId} (${slTp.role}, ${slTp.symbol})`);
      removeOrder(slTp.orderId);
      cleaned++;
    } catch (err) {
      console.error(`[WARN] 取消订单 ${slTp.orderId} 失败: ${err}`);
    }
  }

  // Parallel-fetch linked buy order statuses
  const buyDetails = await Promise.allSettled(
    linked.map(async (slTp) => ({
      slTp,
      // biome-ignore lint/style/noNonNullAssertion: filtered above
      buyDetail: await tradeCtx.orderDetail(slTp.linkedBuyOrderId!),
    })),
  );

  for (const result of buyDetails) {
    if (result.status === "rejected") {
      console.error(`[WARN] 查询关联买单状态失败: ${result.reason}`);
      continue;
    }
    const { slTp, buyDetail } = result.value;
    if (
      buyDetail.status === OrderStatus.Canceled ||
      buyDetail.status === OrderStatus.Expired ||
      buyDetail.status === OrderStatus.Rejected
    ) {
      try {
        await tradeCtx.cancelOrder(slTp.orderId);
        const statusName =
          buyDetail.status === OrderStatus.Canceled
            ? "Canceled"
            : buyDetail.status === OrderStatus.Expired
              ? "Expired"
              : "Rejected";
        console.log(
          `[CANCEL] 买单 ${slTp.linkedBuyOrderId} 已${statusName}，取消关联订单 ${slTp.orderId} (${slTp.role})`,
        );
        removeOrder(slTp.orderId);
        cleaned++;
      } catch (err) {
        console.error(`[WARN] 取消订单 ${slTp.orderId} 失败: ${err}`);
      }
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
    (o) => (o.role === "stop_loss" || o.role === "take_profit") && o.ocoPairOrderId,
  );

  if (ocoOrders.length === 0) {
    console.log("✅ 无 OCO 订单");
    return;
  }

  // Deduplicate: each pair appears twice (A→B and B→A), only process once
  const processed = new Set<string>();
  let ocoCleaned = 0;

  for (const order of ocoOrders) {
    // biome-ignore lint/style/noNonNullAssertion: OCO orders always have pairOrderId
    const pairId = order.ocoPairOrderId!;
    const pairKey = [order.orderId, pairId].sort().join(":");
    if (processed.has(pairKey)) continue;
    processed.add(pairKey);

    try {
      const [detail, pairDetail] = await Promise.all([
        tradeCtx.orderDetail(order.orderId),
        tradeCtx.orderDetail(pairId),
      ]);

      // If both already in terminal state, clean up tracking
      if (isTerminal(detail.status) && isTerminal(pairDetail.status)) {
        console.log(
          `[OCO] 订单 ${order.orderId} (${order.role}, ${orderStatusName(detail.status)}) 与 ${pairId} (${orderStatusName(pairDetail.status)}) 均已结束，清理跟踪记录`,
        );
        removeOrder(order.orderId);
        removeOrder(pairId);
        ocoCleaned++;
        continue;
      }

      // If this order is filled but pair is still active → cancel pair
      if (detail.status === OrderStatus.Filled && !isTerminal(pairDetail.status)) {
        try {
          await tradeCtx.cancelOrder(pairId);
          console.log(
            `[OCO] ${order.role === "stop_loss" ? "止损" : "止盈"} ${order.orderId} 已成交，取消对端 ${pairId}`,
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
            `[OCO] 对端 ${pairId} 已成交，取消 ${order.role === "stop_loss" ? "止损" : "止盈"} ${order.orderId}`,
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
