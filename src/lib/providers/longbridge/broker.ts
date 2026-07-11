import {
  type Config,
  Decimal,
  type Order as LongbridgeOrder,
  OrderSide as LongbridgeOrderSide,
  OrderStatus as LongbridgeOrderStatus,
  OrderType as LongbridgeOrderType,
  TimeInForceType as LongbridgeTimeInForce,
  OutsideRTH,
  type PushOrderChanged,
  TopicType,
  TradeContext,
  TriggerStatus,
} from "longbridge";
import { parseRemarkRole } from "../../symbols.js";
import type { BrokerAdapter } from "../broker.js";
import {
  type AccountBalance,
  type BracketOrderRequest,
  type BracketOrderResult,
  type BrokerOrder,
  type CleanupResult,
  type Currency,
  isTerminalOrderStatus,
  type OrderQuery,
  type OrderRole,
  type OrderStatus,
  type OrderType,
  type Position,
  type ProtectionOrderIds,
  type ReplaceOrderRequest,
  type SubmitOrderRequest,
  type SubmitProtectionRequest,
  type SyncProtectionRequest,
  type TimeInForce,
} from "../types.js";
import { fromLongbridgeSymbol, toLongbridgeSymbol } from "./symbols.js";

const CANCEL_PUSH_GRACE_MS = 10_000;
const MAX_SUBMIT_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

const PENDING_STATUSES = [
  LongbridgeOrderStatus.New,
  LongbridgeOrderStatus.NotReported,
  LongbridgeOrderStatus.ReplacedNotReported,
  LongbridgeOrderStatus.ProtectedNotReported,
  LongbridgeOrderStatus.VarietiesNotReported,
  LongbridgeOrderStatus.WaitToNew,
  LongbridgeOrderStatus.WaitToReplace,
  LongbridgeOrderStatus.PendingReplace,
  LongbridgeOrderStatus.WaitToCancel,
  LongbridgeOrderStatus.PendingCancel,
];

interface PendingWait {
  resolve: (order: BrokerOrder) => void;
  reject: (error: unknown) => void;
}

export class LongbridgeBrokerAdapter implements BrokerAdapter {
  readonly protectionMode = "reconciled-orders" as const;

  private readonly tradeContext: TradeContext;
  private readonly pendingWaits = new Map<string, PendingWait>();
  private readonly terminalEvents = new Map<string, PushOrderChanged>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;

  constructor(config: Config) {
    this.tradeContext = TradeContext.new(config);
    console.log(
      "[BROKER] Longbridge protection mode: reconciled-orders（保护单在下次启动时对账，不是实时 OCO）",
    );
  }

  async getAccountBalances(currency?: Currency): Promise<AccountBalance[]> {
    const balances = await this.tradeContext.accountBalance(currency);
    return balances.map((balance) => ({
      currency: toCurrency(balance.currency),
      buyingPower: Number(balance.buyPower.toString()),
      netAssets: Number(balance.netAssets.toString()),
      cash: Number(balance.totalCash.toString()),
    }));
  }

  async getPositions(): Promise<Position[]> {
    const response = await this.tradeContext.stockPositions();
    return response.channels.flatMap((channel) =>
      channel.positions.map((position) => ({
        instrument: fromLongbridgeSymbol(position.symbol),
        quantity: Number(position.quantity.toString()),
        availableQuantity: Number(position.availableQuantity.toString()),
        costPrice: Number(position.costPrice.toString()),
      })),
    );
  }

  async listOrders(query: OrderQuery = {}): Promise<BrokerOrder[]> {
    const options = {
      ...(query.instrument ? { symbol: toLongbridgeSymbol(query.instrument) } : {}),
      ...(query.statuses ? { status: toLongbridgeStatuses(query.statuses) } : {}),
    };

    const orders =
      query.scope === "history"
        ? await this.tradeContext.historyOrders({
            ...options,
            ...(query.startAt ? { startAt: query.startAt } : {}),
            ...(query.endAt ? { endAt: query.endAt } : {}),
          })
        : await this.tradeContext.todayOrders(options);

    return orders.map(mapLongbridgeOrder);
  }

  async getOrder(orderId: string): Promise<BrokerOrder> {
    return mapLongbridgeOrder(await this.tradeContext.orderDetail(orderId));
  }

  async submitOrder(request: SubmitOrderRequest): Promise<BrokerOrder> {
    const orderId = await this.submitOrderId(request);
    return {
      id: orderId,
      instrument: request.instrument,
      side: request.side,
      type: request.type,
      status: "pending",
      quantity: request.quantity,
      executedQuantity: 0,
      ...(request.price == null ? {} : { price: request.price }),
      ...(request.triggerPrice == null ? {} : { triggerPrice: request.triggerPrice }),
      timeInForce: request.timeInForce,
      outsideRegularHours: request.outsideRegularHours ?? false,
      remark: request.remark ?? "",
      role: toOrderRole(request.remark ?? ""),
    };
  }

  private async submitOrderId(request: SubmitOrderRequest): Promise<string> {
    const response = await this.tradeContext.submitOrder({
      symbol: toLongbridgeSymbol(request.instrument),
      orderType: toLongbridgeOrderType(request.type),
      side: toLongbridgeOrderSide(request.side),
      timeInForce: toLongbridgeTimeInForce(request.timeInForce),
      submittedQuantity: decimal(request.quantity),
      ...(request.price == null ? {} : { submittedPrice: decimal(request.price) }),
      ...(request.triggerPrice == null ? {} : { triggerPrice: decimal(request.triggerPrice) }),
      ...(request.outsideRegularHours == null
        ? {}
        : { outsideRth: request.outsideRegularHours ? OutsideRTH.AnyTime : OutsideRTH.RTHOnly }),
      ...(request.remark == null ? {} : { remark: request.remark }),
    });
    return response.orderId;
  }

  async replaceOrder(request: ReplaceOrderRequest): Promise<BrokerOrder> {
    await this.tradeContext.replaceOrder({
      orderId: request.orderId,
      quantity: decimal(request.quantity),
      ...(request.price == null ? {} : { price: decimal(request.price) }),
      ...(request.triggerPrice == null ? {} : { triggerPrice: decimal(request.triggerPrice) }),
      ...(request.remark == null ? {} : { remark: request.remark }),
    });
    return this.getOrder(request.orderId);
  }

  cancelOrder(orderId: string): Promise<void> {
    return this.tradeContext.cancelOrder(orderId);
  }

  async waitForTerminal(orderId: string, timeoutMs?: number): Promise<BrokerOrder> {
    if (!this.started) {
      throw new Error("LongbridgeBrokerAdapter.start() must be called before waitForTerminal()");
    }
    const cached = this.terminalEvents.get(orderId);
    if (cached) {
      this.terminalEvents.delete(orderId);
      return this.getOrder(orderId);
    }

    return new Promise<BrokerOrder>((resolve, reject) => {
      this.pendingWaits.set(orderId, { resolve, reject });
      if (timeoutMs && timeoutMs > 0) {
        this.timers.set(
          `timeout:${orderId}`,
          setTimeout(() => void this.handleTimeout(orderId), timeoutMs),
        );
      }
    });
  }

  async submitBracketOrder(request: BracketOrderRequest): Promise<BracketOrderResult> {
    const submittedEntry = await this.submitOrder(request.entry);
    const entryOrder = await this.waitForTerminal(submittedEntry.id, request.waitTimeoutMs);
    const protectionOrders =
      entryOrder.executedQuantity > 0
        ? await this.submitProtectionOrders({
            instrument: request.entry.instrument,
            quantity: entryOrder.executedQuantity,
            recordId: request.recordId,
            ...request.protection,
          })
        : {};

    return { mode: this.protectionMode, entryOrder, protectionOrders };
  }

  async submitProtectionOrders(request: SubmitProtectionRequest): Promise<ProtectionOrderIds> {
    const result: ProtectionOrderIds = {};

    if (request.stopLoss != null) {
      result.stopLossOrderId = await this.submitProtectionWithRetry(
        {
          instrument: request.instrument,
          side: "sell",
          type: "market-if-touched",
          quantity: request.quantity,
          triggerPrice: request.stopLoss,
          timeInForce: "good-til-canceled",
          outsideRegularHours: true,
          remark: `auto-trade:sl:${request.recordId}`,
        },
        "止损单",
      );
    }

    if (request.takeProfit != null) {
      result.takeProfitOrderId = await this.submitProtectionWithRetry(
        {
          instrument: request.instrument,
          side: "sell",
          type: "limit-if-touched",
          quantity: request.quantity,
          price: request.takeProfit,
          triggerPrice: request.takeProfit,
          timeInForce: "good-til-canceled",
          outsideRegularHours: true,
          remark: `auto-trade:tp:${request.recordId}`,
        },
        "止盈单",
      );
    }

    return result;
  }

  async syncProtectionOrders(request: SyncProtectionRequest): Promise<ProtectionOrderIds> {
    const result: ProtectionOrderIds = { ...request.existing };
    const errors: unknown[] = [];

    if (request.existing.stopLossOrderId && request.stopLoss != null) {
      try {
        await this.replaceOrder({
          orderId: request.existing.stopLossOrderId,
          quantity: request.quantity,
          triggerPrice: request.stopLoss,
          remark: `auto-trade:sl:${request.recordId}`,
        });
      } catch (error) {
        errors.push(error);
      }
    } else if (!request.existing.stopLossOrderId && request.stopLoss != null) {
      try {
        const submitted = await this.submitProtectionOrders({ ...request, takeProfit: undefined });
        result.stopLossOrderId = submitted.stopLossOrderId;
      } catch (error) {
        errors.push(error);
      }
    }

    if (request.existing.takeProfitOrderId && request.takeProfit != null) {
      try {
        await this.replaceOrder({
          orderId: request.existing.takeProfitOrderId,
          quantity: request.quantity,
          price: request.takeProfit,
          triggerPrice: request.takeProfit,
          remark: `auto-trade:tp:${request.recordId}`,
        });
      } catch (error) {
        errors.push(error);
      }
    } else if (!request.existing.takeProfitOrderId && request.takeProfit != null) {
      try {
        const submitted = await this.submitProtectionOrders({ ...request, stopLoss: undefined });
        result.takeProfitOrderId = submitted.takeProfitOrderId;
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) throw new AggregateError(errors, "Failed to sync protection orders");
    return result;
  }

  async cancelProtectionOrders(orderIds: ProtectionOrderIds): Promise<void> {
    const errors: unknown[] = [];
    for (const orderId of [orderIds.stopLossOrderId, orderIds.takeProfitOrderId]) {
      if (!orderId) continue;
      try {
        await this.cancelOrder(orderId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to cancel protection orders");
  }

  async cleanupProtectionOrders(dryRun = false): Promise<CleanupResult> {
    const { buildCleanupActionsFromSnapshot, collectCompletedBuySignalRecordIdsFromSnapshot } =
      await import("../../cleanup.js");
    const snapshot = await this.getCleanupSnapshot();
    const actions = buildCleanupActionsFromSnapshot(snapshot);
    const completedRecordIds = collectCompletedBuySignalRecordIdsFromSnapshot(snapshot);
    const canceledOrderIds: string[] = [];

    if (!dryRun) {
      for (const action of actions) {
        try {
          await this.cancelOrder(action.orderId);
          canceledOrderIds.push(action.orderId);
        } catch (error) {
          console.error(`[WARN] 取消保护单 ${action.orderId} 失败: ${error}`);
        }
        await delay(200);
      }
    }

    return { canceledOrderIds, completedRecordIds };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.tradeContext.setOnOrderChanged((error, event) => {
      if (error) {
        console.error(`[WS] 订单推送错误: ${error}`);
        return;
      }
      this.handleChange(event);
    });
    await this.tradeContext.subscribe([TopicType.Private]);
    this.started = true;
    console.log("[WS] 订单推送已订阅");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.tradeContext.unsubscribe([TopicType.Private]);
    this.started = false;

    for (const [orderId, pending] of this.pendingWaits) {
      pending.reject(new Error(`Broker adapter stopped while waiting for order ${orderId}`));
    }
    this.pendingWaits.clear();
    this.terminalEvents.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async getCleanupSnapshot() {
    const endAt = new Date();
    const startAt = new Date(endAt.getTime() - 30 * 24 * 60 * 60 * 1000);
    const positions = await this.getPositions();
    await delay(200);
    const todayOrders = await this.listOrders({ scope: "today" });
    await delay(200);
    const historyActiveOrders = await this.listOrders({
      scope: "history",
      statuses: ["pending", "partially-filled"],
      startAt,
      endAt,
    });
    await delay(200);
    const historyFilledOrders = await this.listOrders({
      scope: "history",
      statuses: ["filled"],
      startAt,
      endAt,
    });
    return { positions, todayOrders, historyActiveOrders, historyFilledOrders };
  }

  private async submitProtectionWithRetry(
    request: SubmitOrderRequest,
    label: string,
  ): Promise<string | undefined> {
    for (let attempt = 0; attempt <= MAX_SUBMIT_RETRIES; attempt++) {
      try {
        return await this.submitOrderId(request);
      } catch (error) {
        if (attempt < MAX_SUBMIT_RETRIES) {
          console.warn(
            `[RETRY] ${label} ${request.instrument.symbol} 第 ${attempt + 1} 次提交失败: ${error}，${RETRY_DELAY_MS}ms 后重试...`,
          );
          await delay(RETRY_DELAY_MS);
        } else {
          console.error(
            `[ERR] ${label} ${request.instrument.symbol} 提交失败（已重试 ${MAX_SUBMIT_RETRIES} 次）: ${error}`,
          );
        }
      }
    }
    return undefined;
  }

  private async handleTimeout(orderId: string): Promise<void> {
    if (!this.pendingWaits.has(orderId)) return;
    console.log(`[TIMEUP] 订单 ${orderId} 超时未成交，尝试取消...`);
    try {
      await this.cancelOrder(orderId);
      this.timers.set(
        `fallback:${orderId}`,
        setTimeout(() => void this.resolveFromOrderDetail(orderId), CANCEL_PUSH_GRACE_MS),
      );
    } catch (error) {
      console.error(`[ERR] 取消订单 ${orderId} 失败: ${error}`);
      await this.resolveFromOrderDetail(orderId);
    }
  }

  private handleChange(event: PushOrderChanged): void {
    if (!isTerminalLongbridgeStatus(event.status)) return;
    if (this.pendingWaits.has(event.orderId)) {
      void this.resolveFromOrderDetail(event.orderId);
    } else {
      this.terminalEvents.set(event.orderId, event);
    }
  }

  private async resolveFromOrderDetail(orderId: string): Promise<void> {
    if (!this.pendingWaits.has(orderId)) return;
    try {
      this.resolvePending(orderId, await this.getOrder(orderId));
    } catch (error) {
      this.rejectPending(orderId, error);
    }
  }

  private resolvePending(orderId: string, order: BrokerOrder): void {
    const pending = this.pendingWaits.get(orderId);
    if (!pending) return;
    pending.resolve(order);
    this.clearPending(orderId);
  }

  private rejectPending(orderId: string, error: unknown): void {
    const pending = this.pendingWaits.get(orderId);
    if (!pending) return;
    pending.reject(error);
    this.clearPending(orderId);
  }

  private clearPending(orderId: string): void {
    this.pendingWaits.delete(orderId);
    for (const key of [`timeout:${orderId}`, `fallback:${orderId}`]) {
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}

export function mapLongbridgeOrder(order: LongbridgeOrder): BrokerOrder {
  return {
    id: order.orderId,
    instrument: fromLongbridgeSymbol(order.symbol),
    side: fromLongbridgeOrderSide(order.side),
    type: fromLongbridgeOrderType(order.orderType),
    status: fromLongbridgeOrderStatus(order.status, order.triggerStatus),
    quantity: Number(order.quantity.toString()),
    executedQuantity: Number(order.executedQuantity.toString()),
    ...(order.price == null ? {} : { price: Number(order.price.toString()) }),
    ...(order.triggerPrice == null ? {} : { triggerPrice: Number(order.triggerPrice.toString()) }),
    timeInForce: fromLongbridgeTimeInForce(order.timeInForce),
    outsideRegularHours: order.outsideRth === OutsideRTH.AnyTime,
    remark: order.remark ?? "",
    role: toOrderRole(order.remark ?? ""),
    submittedAt: order.submittedAt,
    ...(order.updatedAt == null ? {} : { updatedAt: order.updatedAt }),
  };
}

export function fromLongbridgeOrderStatus(
  status: LongbridgeOrderStatus,
  triggerStatus?: TriggerStatus | null,
): OrderStatus {
  if (triggerStatus === TriggerStatus.Active) return "pending";
  if (status === LongbridgeOrderStatus.Filled) return "filled";
  if (status === LongbridgeOrderStatus.PartialFilled) return "partially-filled";
  if (status === LongbridgeOrderStatus.Canceled) return "canceled";
  if (status === LongbridgeOrderStatus.Rejected) return "rejected";
  if (status === LongbridgeOrderStatus.Expired) return "expired";
  if (PENDING_STATUSES.includes(status)) return "pending";
  return "unknown";
}

function isTerminalLongbridgeStatus(status: LongbridgeOrderStatus): boolean {
  return isTerminalOrderStatus(fromLongbridgeOrderStatus(status));
}

function toLongbridgeStatuses(statuses: OrderStatus[]): LongbridgeOrderStatus[] {
  const mapped = new Set<LongbridgeOrderStatus>();
  for (const status of statuses) {
    if (status === "pending") for (const item of PENDING_STATUSES) mapped.add(item);
    else if (status === "partially-filled") mapped.add(LongbridgeOrderStatus.PartialFilled);
    else if (status === "filled") mapped.add(LongbridgeOrderStatus.Filled);
    else if (status === "canceled") mapped.add(LongbridgeOrderStatus.Canceled);
    else if (status === "rejected") mapped.add(LongbridgeOrderStatus.Rejected);
    else if (status === "expired") mapped.add(LongbridgeOrderStatus.Expired);
    else mapped.add(LongbridgeOrderStatus.Unknown);
  }
  return [...mapped];
}

function fromLongbridgeOrderType(type: LongbridgeOrderType): OrderType {
  if (type === LongbridgeOrderType.MO) return "market";
  if (type === LongbridgeOrderType.MIT) return "market-if-touched";
  if (type === LongbridgeOrderType.LIT) return "limit-if-touched";
  if (type === LongbridgeOrderType.LO) return "limit";
  return "unknown";
}

function toLongbridgeOrderType(type: OrderType): LongbridgeOrderType {
  if (type === "limit") return LongbridgeOrderType.LO;
  if (type === "market") return LongbridgeOrderType.MO;
  if (type === "market-if-touched") return LongbridgeOrderType.MIT;
  if (type === "limit-if-touched") return LongbridgeOrderType.LIT;
  throw new Error(`Unsupported order type: ${type}`);
}

function toLongbridgeOrderSide(side: "buy" | "sell" | "unknown"): LongbridgeOrderSide {
  if (side === "buy") return LongbridgeOrderSide.Buy;
  if (side === "sell") return LongbridgeOrderSide.Sell;
  throw new Error("Cannot submit an order with an unknown side");
}

function fromLongbridgeOrderSide(side: LongbridgeOrderSide): "buy" | "sell" | "unknown" {
  if (side === LongbridgeOrderSide.Buy) return "buy";
  if (side === LongbridgeOrderSide.Sell) return "sell";
  return "unknown";
}

function fromLongbridgeTimeInForce(value: LongbridgeTimeInForce): TimeInForce {
  if (value === LongbridgeTimeInForce.Day) return "day";
  if (value === LongbridgeTimeInForce.GoodTilCanceled) return "good-til-canceled";
  return "unknown";
}

function toLongbridgeTimeInForce(value: TimeInForce): LongbridgeTimeInForce {
  if (value === "day") return LongbridgeTimeInForce.Day;
  if (value === "good-til-canceled") return LongbridgeTimeInForce.GoodTilCanceled;
  throw new Error(`Unsupported time in force: ${value}`);
}

function toOrderRole(remark: string): OrderRole {
  const role = parseRemarkRole(remark);
  return role ?? "unknown";
}

function decimal(value: number): Decimal {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`Expected positive number, got ${value}`);
  return new Decimal(String(value));
}

function toCurrency(value: string): Currency {
  if (value === "USD" || value === "HKD" || value === "CNY" || value === "SGD") return value;
  throw new Error(`Unsupported currency: ${value}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
