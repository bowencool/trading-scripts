import { OrderStatus, type PushOrderChanged, TopicType, type TradeContext } from "longbridge";

interface PendingOrder {
  resolve: (event: PushOrderChanged) => void;
}

/** 超时触发的取消后等待 WS 推送的时间、之后强制解决 */
const CANCEL_PUSH_GRACE_MS = 10_000;

/**
 * OrderWatcher 包装了 TradeContext WebSocket 推送以提供:
 * waitForTerminal(orderId, timeoutMs?) — 当订单达到终下何状态时解决
 *
 * OCO 逻辑已被移除 — OCO 清理现在由 cleanup.ts 在启动时使用 todayOrders() API 检查处理
 */
export class OrderWatcher {
  private pending = new Map<string, PendingOrder>();
  private terminalEvents = new Map<string, PushOrderChanged>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;

  constructor(private tradeCtx: TradeContext) {}

  /** 开始下好 WebSocket 推送监听器不听订单变更事件 */
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

  /** 停止下好淡学个业清理所有待处理的状态 */
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
   * 等待订单到达终下何状态 (Filled/Canceled/Rejected/Expired)。
   * @param timeoutMs 如果设置，在这么多毫秒后自动取消订单。
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
