// ── DB record ─────────────────────────────────────────────────────────────────

export interface AnalysisRecord {
  id: number;
  query_id: string | null;
  code: string;
  name: string | null;
  report_type: string | null;
  sentiment_score: number | null;
  operation_advice: string | null;
  trend_prediction: string | null;
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
  /** Total quantity held. */
  quantity: number;
  /** Quantity available for sell (not locked by pending orders). */
  availableQuantity: number;
  /** Average cost price. */
  costPrice: number;
}

export interface ActiveOrder {
  orderId: string;
  symbol: string;
  side: "Buy" | "Sell";
  orderType: string;
  /** Limit price (0 for trigger-only orders like MIT). */
  price: string;
  /** Trigger price for MIT/LIT orders. */
  triggerPrice: string;
  quantity: string;
  status: string;
  /** Role inferred from remark: buy | sell | stop_loss | take_profit */
  role: "buy" | "sell" | "stop_loss" | "take_profit";
  /** For SL/TP orders, the remark from the original submission. */
  remark: string;
}

export interface PortfolioState {
  holdings: Map<string, Holding>;
  activeOrders: ActiveOrder[];
  /** Symbols with a holding but no SL/TP orders detected (cross-day orphan warning). */
  orphanWarnings: string[];
}

// ── Action plan ───────────────────────────────────────────────────────────────

export type ActionKind =
  | "CANCEL_CONFLICTING_ORDERS"
  | "NEW_BUY"
  | "UPDATE_BUY"
  | "SELL_FULL"
  | "SELL_PARTIAL"
  | "SYNC_SL_TP"
  | "RECOVER_SL_TP"
  | "MERGE_SL_TP"
  | "HOLD";

export interface ActionPlan {
  action: ActionKind;
  symbol: string;
  /** The signal record that triggered this action. */
  record: AnalysisRecord;
  /** Current holding (if any). */
  holding?: Holding;
  /** For NEW_BUY/UPDATE_BUY: the pending buy order to update (if any). */
  pendingBuyOrder?: ActiveOrder;
  /** For SYNC_SL_TP/RECOVER_SL_TP: existing SL order (if any). */
  existingSlOrder?: ActiveOrder;
  /** For SYNC_SL_TP/RECOVER_SL_TP: existing TP order (if any). */
  existingTpOrder?: ActiveOrder;
  /** For SELL_PARTIAL: percentage to sell. */
  sellPct?: number;
  /** Orders to cancel before continuing (conflicting pending orders or duplicate SL/TP). */
  ordersToCancel?: ActiveOrder[];
}
