import type {
  AccountBalance,
  BracketOrderRequest,
  BracketOrderResult,
  BrokerOrder,
  CleanupResult,
  Currency,
  OrderQuery,
  Position,
  ProtectionMode,
  ProtectionOrderIds,
  ReplaceOrderRequest,
  SubmitOrderRequest,
  SubmitProtectionRequest,
  SyncProtectionRequest,
} from "./types.js";

export interface BrokerAdapter {
  readonly protectionMode: ProtectionMode;

  getAccountBalances(currency?: Currency): Promise<AccountBalance[]>;
  getPositions(): Promise<Position[]>;
  listOrders(query?: OrderQuery): Promise<BrokerOrder[]>;
  getOrder(orderId: string): Promise<BrokerOrder>;

  submitOrder(request: SubmitOrderRequest): Promise<BrokerOrder>;
  replaceOrder(request: ReplaceOrderRequest): Promise<BrokerOrder>;
  cancelOrder(orderId: string): Promise<void>;
  waitForTerminal(orderId: string, timeoutMs?: number): Promise<BrokerOrder>;

  submitBracketOrder(request: BracketOrderRequest): Promise<BracketOrderResult>;
  submitProtectionOrders(request: SubmitProtectionRequest): Promise<ProtectionOrderIds>;
  syncProtectionOrders(request: SyncProtectionRequest): Promise<ProtectionOrderIds>;
  cancelProtectionOrders(orderIds: ProtectionOrderIds): Promise<void>;

  /** Reconcile orphaned/sibling protection orders at process startup. */
  cleanupProtectionOrders(dryRun?: boolean): Promise<CleanupResult>;

  start(): Promise<void>;
  stop(): Promise<void>;
}
