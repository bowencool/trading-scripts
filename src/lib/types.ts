import type { Instrument } from "./providers/types.js";

// ── DB record ─────────────────────────────────────────────────────────────────

export type AnalysisAction =
  | "buy"
  | "add"
  | "reduce"
  | "sell"
  | "hold"
  | "watch"
  | "avoid"
  | "alert";

export interface AnalysisRecord {
  id: number;
  query_id: string | null;
  code: string;
  name: string | null;
  report_type: string | null;
  sentiment_score: number | null;
  /** Normalized action used by trading control flow. */
  action: AnalysisAction | null;
  analysis_summary: string | null;
  raw_result: string | null;
  news_content: string | null;
  context_snapshot: string | null;
  ideal_buy: number | null;
  secondary_buy: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  created_at: string;
}

// ── Portfolio state ───────────────────────────────────────────────────────────

export interface Holding {
  symbol: string;
  /** Provider-neutral instrument identity. */
  instrument: Instrument;
  /** 持仓总数量 */
  quantity: number;
  /** 可卖数量（未被待成交订单锁定） */
  availableQuantity: number;
  /** 平均成本价 */
  costPrice: number;
}

export interface ActiveOrder {
  orderId: string;
  symbol: string;
  side: "Buy" | "Sell";
  orderType: string;
  /** 限价（MIT 等触发单的值为 0） */
  price: string;
  /** MIT/LIT 订单的触发价 */
  triggerPrice: string;
  quantity: string;
  status: string;
  /** 从备注推断的角色: buy | sell | stop_loss | take_profit */
  role: "buy" | "sell" | "stop_loss" | "take_profit";
  /** 对于 SL/TP 订单，原始提交时的备注 */
  remark: string;
}

export interface PortfolioState {
  holdings: Map<string, Holding>;
  activeOrders: ActiveOrder[];
  /** 有持仓但未检测到 SL/TP 订单且需要恢复的标的 */
  orphanWarnings: string[];
}

// ── Action plan ───────────────────────────────────────────────────────────────

export type ActionKind =
  | "CANCEL_CONFLICTING_ORDERS"
  | "NEW_BUY"
  | "ADD_POSITION"
  | "UPDATE_BUY"
  | "SELL_FULL"
  | "SELL_PARTIAL"
  | "SYNC_SL_TP"
  | "RECOVER_SL_TP"
  | "MERGE_SL_TP"
  | "HOLD";

export interface ActionPlan {
  action: ActionKind;
  instrument: Instrument;
  symbol: string;
  /** 触发此操作的信号记录 */
  record: AnalysisRecord;
  /** 当前持仓（如有） */
  holding?: Holding;
  /** 对于 NEW_BUY/UPDATE_BUY: 要更新的待成交买单（如有） */
  pendingBuyOrder?: ActiveOrder;
  /** 对于 SYNC_SL_TP/RECOVER_SL_TP: 现存的止损单（如有） */
  existingSlOrder?: ActiveOrder;
  /** 对于 SYNC_SL_TP/RECOVER_SL_TP: 现存的止盈单（如有） */
  existingTpOrder?: ActiveOrder;
  /** 对于 SELL_PARTIAL: 卖出的百分比 */
  sellPct?: number;
  /** 需要取消的订单（冲突的待成交订单或重复的 SL/TP） */
  ordersToCancel?: ActiveOrder[];
}
