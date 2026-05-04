import { TradeContext, OrderStatus, TopicType, type PushOrderChanged } from "longbridge";
import { removeOrder } from "./tracker.js";

/** Terminal states where the order is no longer active on the exchange. */
function isTerminal(status: OrderStatus): boolean {
  return (
    status === OrderStatus.Filled ||
    status === OrderStatus.Canceled ||
    status === OrderStatus.Rejected ||
    status === OrderStatus.Expired
  );
}

function orderStatusName(status: OrderStatus): string {
  switch (status) {
    case OrderStatus.Filled: return "Filled";
    case OrderStatus.Canceled: return "Canceled";
    case OrderStatus.Rejected: return "Rejected";
    case OrderStatus.Expired: return "Expired";
    case OrderStatus.New: return "New";
    case OrderStatus.PartialFilled: return "PartialFilled";
    case OrderStatus.NotReported: return "NotReported";
    default: return `Status(${status})`;
  }
}

interface PendingOrder {
  resolve: (event: PushOrderChanged) => void;
}

/**
 * OrderWatcher wraps TradeContext WebSocket push to provide:
 * 1. waitForTerminal(orderId) — resolves when an order reaches a terminal state
 * 2. watchOcoPair(slOrderId, tpOrderId) — when one fills, cancels the other in real-time
 */
export class OrderWatcher {
  private pending = new Map<string, PendingOrder>();
  private ocoPairs = new Map<string, string>(); // orderId → pairOrderId
  private started = false;

  constructor(private tradeCtx: TradeContext) {}

  /** Start listening for order change events via WebSocket. */
  async start(): Promise<void> {
    if (this.started) return;

    this.tradeCtx.setOnOrderChanged((err, event) => {
      if (err) {
        console.error(`[WS] 订单推送错误: ${err}`);
        return;
      }
      this.handleChange(event);
    });

    await this.tradeCtx.subscribe([TopicType.Private]);
    this.started = true;
    console.log("[WS] 订单推送已订阅");
  }

  /** Stop listening. */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.tradeCtx.unsubscribe([TopicType.Private]);
    this.started = false;
  }

  /**
   * Wait for an order to reach a terminal state (Filled/Canceled/Rejected/Expired).
   * Returns the PushOrderChanged event that caused the terminal transition.
   */
  waitForTerminal(orderId: string): Promise<PushOrderChanged> {
    return new Promise<PushOrderChanged>((resolve) => {
      this.pending.set(orderId, { resolve });
    });
  }

  /**
   * Register an OCO pair. When one side fills, the other is automatically cancelled.
   * Returns immediately — cleanup runs in the background via push events.
   */
  watchOcoPair(orderId1: string, orderId2: string): void {
    this.ocoPairs.set(orderId1, orderId2);
    this.ocoPairs.set(orderId2, orderId1);
  }

  private handleChange(event: PushOrderChanged): void {
    const orderId = event.orderId;
    const status = event.status;

    // Check OCO pairs first
    if (status === OrderStatus.Filled && this.ocoPairs.has(orderId)) {
      const pairId = this.ocoPairs.get(orderId)!;
      this.handleOcoFill(orderId, pairId);
    }

    // Resolve any pending waitForTerminal
    if (isTerminal(status) && this.pending.has(orderId)) {
      this.pending.get(orderId)!.resolve(event);
      this.pending.delete(orderId);
    }
  }

  private async handleOcoFill(filledOrderId: string, pairOrderId: string): Promise<void> {
    // Clean up the OCO pair mapping
    this.ocoPairs.delete(filledOrderId);
    this.ocoPairs.delete(pairOrderId);

    // Cancel the surviving order
    try {
      await this.tradeCtx.cancelOrder(pairOrderId);
      console.log(`[OCO] 订单 ${filledOrderId} 已成交，实时取消对端 ${pairOrderId}`);
    } catch (err) {
      console.error(`[WARN] OCO 实时取消 ${pairOrderId} 失败: ${err}`);
    }

    // Clean up tracking records
    removeOrder(filledOrderId);
    removeOrder(pairOrderId);
  }
}
