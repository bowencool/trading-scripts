import { OrderStatus, type PushOrderChanged, TopicType, type TradeContext } from "longbridge";
import { removeOrder } from "./tracker.js";
import { isTerminal } from "./utils.js";

interface PendingOrder {
  resolve: (event: PushOrderChanged) => void;
}

/** Time to wait for WS push after a timeout-triggered cancel before force-resolving. */
const CANCEL_PUSH_GRACE_MS = 10_000;

/**
 * OrderWatcher wraps TradeContext WebSocket push to provide:
 * 1. waitForTerminal(orderId, timeoutMs?) — resolves when an order reaches a terminal state
 * 2. watchOcoPair(slOrderId, tpOrderId) — when one fills, cancels the other in real-time
 */
export class OrderWatcher {
  private pending = new Map<string, PendingOrder>();
  private ocoPairs = new Map<string, string>(); // orderId → pairOrderId
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
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
   * @param timeoutMs If set, automatically cancel the order after this many ms.
   *   The cancel triggers a WS push which resolves the promise naturally.
   *   A safety-net fallback force-resolves after CANCEL_PUSH_GRACE_MS.
   */
  waitForTerminal(orderId: string, timeoutMs?: number): Promise<PushOrderChanged> {
    return new Promise<PushOrderChanged>((resolve) => {
      this.pending.set(orderId, { resolve });

      if (timeoutMs && timeoutMs > 0) {
        const timer = setTimeout(() => this.handleTimeout(orderId), timeoutMs);
        this.timers.set(`timeout:${orderId}`, timer);
      }
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

  private async handleTimeout(orderId: string): Promise<void> {
    if (!this.pending.has(orderId)) return; // already resolved

    console.log(`[TIMEUP] 订单 ${orderId} 超时未成交，尝试取消...`);
    try {
      await this.tradeCtx.cancelOrder(orderId);
      // cancelOrder triggers WS push → handleChange → resolvePending
      // Safety net: force resolve if WS push doesn't arrive within grace period
      const fallback = setTimeout(() => {
        if (this.pending.has(orderId)) {
          console.warn(`[WARN] 订单 ${orderId} 取消后未收到 WS 推送，强制结束等待`);
          this.resolvePending(orderId, {
            orderId,
            status: OrderStatus.Canceled,
          } as PushOrderChanged);
        }
      }, CANCEL_PUSH_GRACE_MS);
      this.timers.set(`fallback:${orderId}`, fallback);
    } catch (err) {
      console.error(`[ERR] 取消订单 ${orderId} 失败: ${err}`);
      this.resolvePending(orderId, { orderId, status: OrderStatus.Canceled } as PushOrderChanged);
    }
  }

  private handleChange(event: PushOrderChanged): void {
    const orderId = event.orderId;
    const status = event.status;

    // Check OCO pairs first
    if (status === OrderStatus.Filled && this.ocoPairs.has(orderId)) {
      // biome-ignore lint/style/noNonNullAssertion: just checked has(orderId)
      const pairId = this.ocoPairs.get(orderId)!;
      this.handleOcoFill(orderId, pairId);
    }

    // Resolve any pending waitForTerminal
    if (isTerminal(status) && this.pending.has(orderId)) {
      this.resolvePending(orderId, event);
    }
  }

  private resolvePending(orderId: string, event: PushOrderChanged): void {
    const pending = this.pending.get(orderId);
    if (!pending) return;

    pending.resolve(event);
    this.pending.delete(orderId);

    // Clean up all timers for this order
    for (const key of [`timeout:${orderId}`, `fallback:${orderId}`]) {
      const t = this.timers.get(key);
      if (t) {
        clearTimeout(t);
        this.timers.delete(key);
      }
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
