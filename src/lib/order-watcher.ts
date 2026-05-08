import { OrderStatus, type PushOrderChanged, TopicType, type TradeContext } from "longbridge";

interface PendingOrder {
  resolve: (event: PushOrderChanged) => void;
}

/** Time to wait for WS push after a timeout-triggered cancel before force-resolving. */
const CANCEL_PUSH_GRACE_MS = 10_000;

/**
 * OrderWatcher wraps TradeContext WebSocket push to provide:
 * waitForTerminal(orderId, timeoutMs?) — resolves when an order reaches a terminal state
 *
 * OCO logic has been removed — OCO cleanup is now handled by cleanup.ts at startup
 * using todayOrders() API checks.
 */
export class OrderWatcher {
  private pending = new Map<string, PendingOrder>();
  private terminalEvents = new Map<string, PushOrderChanged>();
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

  /** Stop listening and clean up all pending state. */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.tradeCtx.unsubscribe([TopicType.Private]);
    this.started = false;

    for (const [, { resolve }] of this.pending) {
      resolve({ orderId: "", status: OrderStatus.Canceled } as PushOrderChanged);
    }
    this.pending.clear();
    this.terminalEvents.clear();
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  /**
   * Wait for an order to reach a terminal state (Filled/Canceled/Rejected/Expired).
   * @param timeoutMs If set, automatically cancel the order after this many ms.
   */
  waitForTerminal(orderId: string, timeoutMs?: number): Promise<PushOrderChanged> {
    const cached = this.terminalEvents.get(orderId);
    if (cached) {
      this.terminalEvents.delete(orderId);
      return Promise.resolve(cached);
    }

    return new Promise<PushOrderChanged>((resolve) => {
      this.pending.set(orderId, { resolve });

      if (timeoutMs && timeoutMs > 0) {
        const timer = setTimeout(() => this.handleTimeout(orderId), timeoutMs);
        this.timers.set(`timeout:${orderId}`, timer);
      }
    });
  }

  private async handleTimeout(orderId: string): Promise<void> {
    if (!this.pending.has(orderId)) return;

    console.log(`[TIMEUP] 订单 ${orderId} 超时未成交，尝试取消...`);
    try {
      await this.tradeCtx.cancelOrder(orderId);
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

    if (isTerminal(event.status)) {
      if (this.pending.has(orderId)) {
        this.resolvePending(orderId, event);
        return;
      }

      this.terminalEvents.set(orderId, event);
    }
  }

  private resolvePending(orderId: string, event: PushOrderChanged): void {
    const pending = this.pending.get(orderId);
    if (!pending) return;

    pending.resolve(event);
    this.pending.delete(orderId);

    for (const key of [`timeout:${orderId}`, `fallback:${orderId}`]) {
      const t = this.timers.get(key);
      if (t) {
        clearTimeout(t);
        this.timers.delete(key);
      }
    }
  }
}

function isTerminal(status: OrderStatus): boolean {
  return (
    status === OrderStatus.Filled ||
    status === OrderStatus.Canceled ||
    status === OrderStatus.Rejected ||
    status === OrderStatus.Expired
  );
}
