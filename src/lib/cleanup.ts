import type { BrokerAdapter } from "./providers/broker.js";
import type { BrokerOrder, Position } from "./providers/types.js";
import { isAutoTradeRemark, parseRemarkRecordId } from "./symbols.js";

const API_DELAY_MS = 200;
const HISTORY_DAYS = 30;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminal(order: CleanupOrderLike): boolean {
  return (
    order.status === "filled" ||
    order.status === "canceled" ||
    order.status === "rejected" ||
    order.status === "expired"
  );
}

type CleanupOrderLike = Pick<BrokerOrder, "id" | "instrument" | "status" | "role" | "remark">;

export interface CleanupSnapshot {
  positions: Position[];
  todayOrders: BrokerOrder[];
  historyActiveOrders: BrokerOrder[];
  historyFilledOrders: BrokerOrder[];
}

export interface CleanupAction {
  kind: "orphan" | "oco";
  orderId: string;
  symbol: string;
  role: "stop_loss" | "take_profit";
  recordId: string | null;
}

export function selectOcoOrdersToCancel<T extends CleanupOrderLike>(orders: T[]): T[] {
  const filledRolesByRecordId = new Map<string, Set<"stop_loss" | "take_profit">>();

  for (const order of orders) {
    const recordId = parseRemarkRecordId(order.remark);
    if (!recordId || (order.role !== "stop_loss" && order.role !== "take_profit")) continue;
    if (order.status !== "filled") continue;
    const roles = filledRolesByRecordId.get(recordId) ?? new Set();
    roles.add(order.role);
    filledRolesByRecordId.set(recordId, roles);
  }

  const selected: T[] = [];
  const seenOrderIds = new Set<string>();
  for (const order of orders) {
    const recordId = parseRemarkRecordId(order.remark);
    if (!recordId || isTerminal(order)) continue;
    const filledRoles = filledRolesByRecordId.get(recordId);
    if (!filledRoles) continue;
    const oppositeRole =
      order.role === "stop_loss"
        ? "take_profit"
        : order.role === "take_profit"
          ? "stop_loss"
          : null;
    if (!oppositeRole || !filledRoles.has(oppositeRole) || seenOrderIds.has(order.id)) continue;
    seenOrderIds.add(order.id);
    selected.push(order);
  }
  return selected;
}

function roleLabel(role: CleanupAction["role"]): string {
  return role === "stop_loss" ? "止损" : "止盈";
}

function ocoCause(role: CleanupAction["role"]): string {
  return role === "take_profit" ? "止损已成交" : "止盈已成交";
}

export function formatCleanupAction(
  action: CleanupAction,
  mode: "plan" | "dry-run" | "execute",
): string {
  const label = roleLabel(action.role);
  const recordId = action.recordId ?? "?";
  const prefix = mode === "dry-run" ? "[DRY RUN]" : mode === "plan" ? "[PLAN]" : "";
  if (action.kind === "orphan") {
    const verb = mode === "execute" ? "已取消" : "将取消";
    return `${prefix}[CANCEL] ${verb}孤儿${label}订单 ${action.orderId} (${action.symbol} 无持仓)`;
  }
  const cause = ocoCause(action.role);
  if (mode === "execute") {
    return `[OCO] ${cause}，取消${label} ${action.orderId} (${action.symbol}, record ${recordId})`;
  }
  return `${prefix}[OCO] ${cause}，将取消${label} ${action.orderId} (${action.symbol}, record ${recordId})`;
}

export function buildCleanupActions<T extends CleanupOrderLike>(
  heldSymbols: Set<string>,
  orders: T[],
): CleanupAction[] {
  const bySymbol = new Map<string, T[]>();
  for (const order of orders) {
    const symbol = order.instrument.symbol;
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), order]);
  }

  const actionsByOrderId = new Map<string, CleanupAction>();
  for (const [symbol, symbolOrders] of bySymbol) {
    const activeProtectionOrders = symbolOrders.filter(
      (order) => (order.role === "stop_loss" || order.role === "take_profit") && !isTerminal(order),
    );
    if (activeProtectionOrders.length > 0) {
      const hasPendingBuy = symbolOrders.some(
        (order) => order.role === "buy" && !isTerminal(order),
      );
      if (!heldSymbols.has(symbol) && !hasPendingBuy) {
        for (const order of activeProtectionOrders) {
          actionsByOrderId.set(order.id, {
            kind: "orphan",
            orderId: order.id,
            symbol,
            role: order.role as "stop_loss" | "take_profit",
            recordId: parseRemarkRecordId(order.remark),
          });
        }
      }
    }

    for (const order of selectOcoOrdersToCancel(symbolOrders)) {
      if (actionsByOrderId.has(order.id)) continue;
      if (order.role !== "stop_loss" && order.role !== "take_profit") continue;
      actionsByOrderId.set(order.id, {
        kind: "oco",
        orderId: order.id,
        symbol,
        role: order.role,
        recordId: parseRemarkRecordId(order.remark),
      });
    }
  }
  return [...actionsByOrderId.values()];
}

function normalizeCleanupSnapshot(snapshot: CleanupSnapshot): {
  heldSymbols: Set<string>;
  orders: BrokerOrder[];
} {
  const heldSymbols = new Set(
    snapshot.positions
      .filter((position) => position.quantity > 0)
      .map((position) => position.instrument.symbol),
  );
  const orders: BrokerOrder[] = [];
  const seenIds = new Set<string>();
  for (const order of [
    ...snapshot.todayOrders,
    ...snapshot.historyActiveOrders,
    ...snapshot.historyFilledOrders,
  ]) {
    if (!seenIds.has(order.id) && isAutoTradeRemark(order.remark)) {
      orders.push(order);
      seenIds.add(order.id);
    }
  }
  return { heldSymbols, orders };
}

export async function fetchCleanupSnapshot(broker: BrokerAdapter): Promise<CleanupSnapshot> {
  const endAt = new Date();
  const startAt = new Date(endAt.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  // Keep broker snapshot calls sequential; adapters may enforce request-rate limits.
  const positions = await broker.getPositions();
  await delay(API_DELAY_MS);
  const todayOrders = await broker.listOrders({ scope: "today" });
  await delay(API_DELAY_MS);
  const historyActiveOrders = await broker.listOrders({
    scope: "history",
    statuses: ["pending", "partially-filled"],
    startAt,
    endAt,
  });
  await delay(API_DELAY_MS);
  const historyFilledOrders = await broker.listOrders({
    scope: "history",
    statuses: ["filled"],
    startAt,
    endAt,
  });
  return { positions, todayOrders, historyActiveOrders, historyFilledOrders };
}

export function buildCleanupActionsFromSnapshot(snapshot: CleanupSnapshot): CleanupAction[] {
  const normalized = normalizeCleanupSnapshot(snapshot);
  return buildCleanupActions(normalized.heldSymbols, normalized.orders);
}

export function collectCompletedBuySignalRecordIdsFromSnapshot(
  snapshot: CleanupSnapshot,
): Set<number> {
  const completedRecordIds = new Set<number>();
  for (const order of [...snapshot.todayOrders, ...snapshot.historyFilledOrders]) {
    if (order.status !== "filled" || (order.role !== "stop_loss" && order.role !== "take_profit")) {
      continue;
    }
    const recordId = parseRemarkRecordId(order.remark);
    if (recordId) completedRecordIds.add(Number(recordId));
  }
  return completedRecordIds;
}

export async function collectCleanupActions(broker: BrokerAdapter): Promise<CleanupAction[]> {
  return buildCleanupActionsFromSnapshot(await fetchCleanupSnapshot(broker));
}

export async function executeCleanupActions(
  broker: Pick<BrokerAdapter, "cancelOrder">,
  actions: CleanupAction[],
): Promise<number> {
  let cleaned = 0;
  for (const action of actions) {
    try {
      await broker.cancelOrder(action.orderId);
      console.log(formatCleanupAction(action, "execute"));
      cleaned++;
    } catch (error) {
      console.error(`[WARN] 取消${roleLabel(action.role)} ${action.orderId} 失败: ${error}`);
    }
    await delay(API_DELAY_MS);
  }
  console.log(cleaned > 0 ? `✅ 清理完成，共取消 ${cleaned} 个孤儿订单` : "✅ 无孤儿订单");
  return cleaned;
}

export async function cleanupOrphanedOrders(broker: BrokerAdapter): Promise<void> {
  console.log("🧹 清理孤儿订单...");
  const snapshot = await fetchCleanupSnapshot(broker);
  await executeCleanupActions(broker, buildCleanupActionsFromSnapshot(snapshot));
}
