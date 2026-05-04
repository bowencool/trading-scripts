export interface AnalysisRecord {
  id: number;
  code: string;
  name: string | null;
  report_type: string | null;
  sentiment_score: number | null;
  operation_advice: string | null;
  trend_prediction: string | null;
  analysis_summary: string | null;
  ideal_buy: number | null;
  secondary_buy: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  created_at: string;
}

export interface TradeSignal {
  record: AnalysisRecord;
  symbol: string;
  side: "Buy" | "Sell";
  targetPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface TrackedOrder {
  orderId: string;
  symbol: string;
  side: string;
  orderType: string;
  price: string;
  triggerPrice?: string;
  quantity: string;
  submittedAt: string;
  signalRecordId: number;
  role: "buy" | "stop_loss" | "take_profit";
  linkedBuyOrderId?: string;
  /** When set, this order and the one at ocoPairOrderId form an OCO pair — filling one cancels the other. */
  ocoPairOrderId?: string;
}
