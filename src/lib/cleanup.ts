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

interface CleanupOrderLike extends OcoOrderLike {
  symbol: string;
}

export interface CleanupSnapshot {
  positionsResp: Awaited<ReturnType<TradeContext["stockPositions"]>>;
  todayOrders: Awaited<ReturnType<TradeContext["todayOrders"]>>;
  historyActiveOrders: Awaited<ReturnType<TradeContext["historyOrders"]>>;
  historyFilledOrders: Awaited<ReturnType<TradeContext["historyOrders"]>>;
}

export interface CleanupAction {
  kind: "orphan" | "oco";
  orderId: string;
  symbol: string;
  role: "stop_loss" | "take_profit";
  recordId: string | null;
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
    const existing = bySymbol.get(order.symbol) ?? [];
    existing.push(order);
    bySymbol.set(order.symbol, existing);
  }

  const actionsByOrderId = new Map<string, CleanupAction>();

  for (const [symbol, symbolOrders] of bySymbol) {
    const allSlOrders = symbolOrders.filter(
      (order) => parseRemarkRole(order.remark ?? "") === "stop_loss",
    );
    const allTpOrders = symbolOrders.filter(
      (order) => parseRemarkRole(order.remark ?? "") === "take_profit",
    );
    const activeSlOrders = allSlOrders.filter((order) => !isTerminal(order.status));
    const activeTpOrders = allTpOrders.filter((order) => !isTerminal(order.status));

    if (activeSlOrders.length > 0 || activeTpOrders.length > 0) {
      const hasHolding = heldSymbols.has(symbol);
      const hasPendingBuy = symbolOrders.some(
        (order) => parseRemarkRole(order.remark ?? "") === "buy" && !isTerminal(order.status),
      );

      if (!hasHolding && !hasPendingBuy) {
        for (const order of [...activeSlOrders, ...activeTpOrders]) {
          const role = parseRemarkRole(order.remark ?? "");
          if (role !== "stop_loss" && role !== "take_profit") {
            continue;
          }
          actionsByOrderId.set(order.orderId, {
            kind: "orphan",
            orderId: order.orderId,
            symbol,
            role,
            recordId: parseRemarkRecordId(order.remark ?? ""),
          });
        }
      }
    }

    const ocoOrdersToCancel = selectOcoOrdersToCancel(symbolOrders);
    for (const order of ocoOrdersToCancel) {
      if (actionsByOrderId.has(order.orderId)) {
        continue;
      }
      const role = parseRemarkRole(order.remark ?? "");
      if (role !== "stop_loss" && role !== "take_profit") {
        continue;
      }
      actionsByOrderId.set(order.orderId, {
        kind: "oco",
        orderId: order.orderId,
        symbol,
        role,
        recordId: parseRemarkRecordId(order.remark ?? ""),
      });
    }
  }

  return [...actionsByOrderId.values()];
}

function normalizeCleanupSnapshot(snapshot: CleanupSnapshot): {
  heldSymbols: Set<string>;
  orders: CleanupOrderLike[];
} {
  const { positionsResp, todayOrders, historyActiveOrders, historyFilledOrders } = snapshot;

  const heldSymbols = new Set<string>();
  for (const pos of positionsResp.channels.flatMap((channel) => channel.positions)) {
    if (Number(pos.quantity.toString()) > 0) {
      heldSymbols.add(pos.symbol);
    }
  }

  const seenIds = new Set<string>();
  const allOrders: CleanupOrderLike[] = [];
  for (const order of todayOrders) {
    if (!seenIds.has(order.orderId)) {
      allOrders.push(order);
      seenIds.add(order.orderId);
    }
  }
  for (const order of historyActiveOrders) {
    if (!seenIds.has(order.orderId)) {
      allOrders.push(order);
      seenIds.add(order.orderId);
    }
  }
  for (const order of historyFilledOrders) {
    if (!seenIds.has(order.orderId)) {
      allOrders.push(order);
      seenIds.add(order.orderId);
    }
  }

  return {
    heldSymbols,
    orders: allOrders.filter((order) => isAutoTradeRemark(order.remark ?? "")),
  };
}

export async function fetchCleanupSnapshot(tradeCtx: TradeContext): Promise<CleanupSnapshot> {
  const endAt = new Date();
  const startAt = new Date(endAt.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);

  // Longbridge is sensitive to request bursts. Keep the preview path
  // sequential so dry-run does not trip the rate limiter before doing any work.
  const positionsResp = await tradeCtx.stockPositions();
  await delay(API_DELAY_MS);

  const todayOrders = await tradeCtx.todayOrders();
  await delay(API_DELAY_MS);

  const historyActiveOrders = await tradeCtx.historyOrders({
    status: ACTIVE_HISTORY_STATUSES,
    startAt,
    endAt,
  });
  await delay(API_DELAY_MS);

  const historyFilledOrders = await tradeCtx.historyOrders({
    status: FILLED_HISTORY_STATUSES,
    startAt,
    endAt,
  });

  return {
    positionsResp,
    todayOrders,
    historyActiveOrders,
    historyFilledOrders,
  };
}

export function buildCleanupActionsFromSnapshot(snapshot: CleanupSnapshot): CleanupAction[] {
  const normalized = normalizeCleanupSnapshot(snapshot);
  return buildCleanupActions(normalized.heldSymbols, normalized.orders);
}

export async function collectCleanupActions(tradeCtx: TradeContext): Promise<CleanupAction[]> {
  const snapshot = await fetchCleanupSnapshot(tradeCtx);
  return buildCleanupActionsFromSnapshot(snapshot);
}

export async function executeCleanupActions(
  tradeCtx: TradeContext,
  actions: CleanupAction[],
): Promise<number> {
  let cleaned = 0;

  for (const action of actions) {
    try {
      await tradeCtx.cancelOrder(action.orderId);
      console.log(formatCleanupAction(action, "execute"));
      cleaned++;
    } catch (err) {
      const label = roleLabel(action.role);
      console.error(`[WARN] 取消${label} ${action.orderId} 失败: ${err}`);
    }
    await delay(API_DELAY_MS);
  }

  if (cleaned > 0) {
    console.log(`✅ 清理完成，共取消 ${cleaned} 个孤儿订单`);
  } else {
    console.log("✅ 无孤儿订单");
  }

  return cleaned;
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
  const snapshot = await fetchCleanupSnapshot(tradeCtx);
  const actions = buildCleanupActionsFromSnapshot(snapshot);
  await executeCleanupActions(tradeCtx, actions);
}
