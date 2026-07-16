export type Market = "US" | "HK" | "CN" | "SG";

export type Currency = "USD" | "HKD" | "CNY" | "SGD";

/** Provider-neutral instrument. Symbols never contain a broker suffix such as `.US`. */
export interface Instrument {
  symbol: string;
  market: Market;
}

export interface SessionPrice {
  price: number;
  timestamp?: Date;
}

export interface MarketQuote {
  instrument: Instrument;
  lastPrice: number;
  preMarket?: SessionPrice;
  postMarket?: SessionPrice;
  timestamp?: Date;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  instrument: Instrument;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface InstrumentInfo {
  instrument: Instrument;
  lotSize: number;
}

export type TradingStatusReason =
  | "trading"
  | "non-trading-day"
  | "outside-trading-session"
  | "instrument-unavailable";

export type TradingSession = "regular" | "pre" | "post";
export type OrderExecutionSession = TradingSession | "any";

/** Provider-neutral snapshot used to fail closed before submitting an entry/exit order. */
export type TradingStatus =
  | { isTrading: true; reason: "trading"; session: TradingSession }
  | { isTrading: false; reason: Exclude<TradingStatusReason, "trading"> };

export interface AccountBalance {
  currency: Currency;
  buyingPower: number;
  netAssets: number;
  cash: number;
}

export interface Position {
  instrument: Instrument;
  quantity: number;
  availableQuantity: number;
  costPrice: number;
}

export type OrderSide = "buy" | "sell" | "unknown";
export type OrderType = "limit" | "market" | "market-if-touched" | "limit-if-touched" | "unknown";
export type TimeInForce = "day" | "good-til-canceled" | "unknown";
export type OrderRole = "buy" | "sell" | "stop_loss" | "take_profit" | "unknown";

export type OrderStatus =
  | "pending"
  | "partially-filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  | "unknown";

export interface BrokerOrder {
  id: string;
  instrument: Instrument;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  quantity: number;
  executedQuantity: number;
  price?: number;
  triggerPrice?: number;
  timeInForce: TimeInForce;
  outsideRegularHours: boolean;
  remark: string;
  role: OrderRole;
  submittedAt?: Date;
  updatedAt?: Date;
}

export interface OrderQuery {
  scope?: "today" | "history";
  statuses?: OrderStatus[];
  startAt?: Date;
  endAt?: Date;
  instrument?: Instrument;
}

export interface SubmitOrderRequest {
  instrument: Instrument;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  timeInForce: TimeInForce;
  executionSession?: OrderExecutionSession;
  remark?: string;
}

export interface ReplaceOrderRequest {
  orderId: string;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  remark?: string;
}

export interface ProtectionSpec {
  stopLoss?: number;
  takeProfit?: number;
}

export type ProtectionMode = "native-bracket" | "reconciled-orders";

export interface ProtectionOrderIds {
  stopLossOrderId?: string;
  takeProfitOrderId?: string;
}

export interface SubmitProtectionRequest extends ProtectionSpec {
  instrument: Instrument;
  quantity: number;
  recordId: number;
}

export interface SyncProtectionRequest extends SubmitProtectionRequest {
  existing: ProtectionOrderIds;
}

export interface BracketOrderRequest {
  entry: SubmitOrderRequest;
  protection: ProtectionSpec;
  recordId: number;
  waitTimeoutMs?: number;
}

export interface BracketOrderResult {
  mode: ProtectionMode;
  entryOrder: BrokerOrder;
  protectionOrders: ProtectionOrderIds;
}

export interface CleanupResult {
  canceledOrderIds: string[];
  completedRecordIds: Set<number>;
}

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return (
    status === "filled" || status === "canceled" || status === "rejected" || status === "expired"
  );
}
