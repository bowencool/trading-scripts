import assert from "node:assert/strict";
import test from "node:test";
import type { BrokerAdapter } from "./broker.js";
import type { MarketDataProvider } from "./market-data.js";
import {
  type AccountBalance,
  type BracketOrderRequest,
  type BracketOrderResult,
  type BrokerOrder,
  type CleanupResult,
  type Currency,
  type Instrument,
  isTerminalOrderStatus,
  type OrderQuery,
  type Position,
  type ProtectionOrderIds,
  type ReplaceOrderRequest,
  type SubmitOrderRequest,
  type SubmitProtectionRequest,
  type SyncProtectionRequest,
} from "./types.js";

const apple: Instrument = { symbol: "AAPL", market: "US" };

function order(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    id: "order-1",
    instrument: apple,
    side: "buy",
    type: "limit",
    status: "pending",
    quantity: 10,
    executedQuantity: 0,
    price: 200,
    timeInForce: "day",
    outsideRegularHours: true,
    remark: "auto-trade:buy:1",
    role: "buy",
    ...overrides,
  };
}

class ContractMarketDataProvider implements MarketDataProvider {
  async getTradingStatus(_instrument: Instrument) {
    return { isTrading: true as const, reason: "trading" as const, session: "regular" as const };
  }

  async getQuotes(instruments: Instrument[]) {
    return instruments.map((instrument) => ({ instrument, lastPrice: 200 }));
  }

  async getOrderBook(instrument: Instrument) {
    return { instrument, bids: [{ price: 199, quantity: 5 }], asks: [{ price: 201, quantity: 5 }] };
  }

  async getInstrumentInfo(instruments: Instrument[]) {
    return instruments.map((instrument) => ({ instrument, lotSize: 1 }));
  }
}

class ContractBrokerAdapter implements BrokerAdapter {
  readonly protectionMode = "reconciled-orders" as const;

  async getAccountBalances(_currency?: Currency): Promise<AccountBalance[]> {
    return [{ currency: "USD", buyingPower: 1_000, netAssets: 2_000, cash: 500 }];
  }

  async getPositions(): Promise<Position[]> {
    return [{ instrument: apple, quantity: 10, availableQuantity: 10, costPrice: 180 }];
  }

  async listOrders(_query?: OrderQuery): Promise<BrokerOrder[]> {
    return [order()];
  }

  async getOrder(_orderId: string): Promise<BrokerOrder> {
    return order();
  }

  async submitOrder(_request: SubmitOrderRequest): Promise<BrokerOrder> {
    return order();
  }

  async replaceOrder(request: ReplaceOrderRequest): Promise<BrokerOrder> {
    return order({ id: request.orderId, quantity: request.quantity });
  }

  async cancelOrder(_orderId: string): Promise<void> {}

  async waitForTerminal(orderId: string, _timeoutMs?: number): Promise<BrokerOrder> {
    return order({ id: orderId, status: "filled", executedQuantity: 10 });
  }

  async submitBracketOrder(request: BracketOrderRequest): Promise<BracketOrderResult> {
    return {
      mode: this.protectionMode,
      entryOrder: order({ instrument: request.entry.instrument }),
      protectionOrders: { stopLossOrderId: "sl-1", takeProfitOrderId: "tp-1" },
    };
  }

  async submitProtectionOrders(_request: SubmitProtectionRequest): Promise<ProtectionOrderIds> {
    return { stopLossOrderId: "sl-1", takeProfitOrderId: "tp-1" };
  }

  async syncProtectionOrders(_request: SyncProtectionRequest): Promise<ProtectionOrderIds> {
    return { stopLossOrderId: "sl-1", takeProfitOrderId: "tp-1" };
  }

  async cancelProtectionOrders(_orderIds: ProtectionOrderIds): Promise<void> {}

  async cleanupProtectionOrders(_dryRun?: boolean): Promise<CleanupResult> {
    return { canceledOrderIds: [], completedRecordIds: new Set() };
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

test("MarketDataProvider contract exposes provider-neutral status, prices and lot sizes", async () => {
  const provider: MarketDataProvider = new ContractMarketDataProvider();

  assert.deepEqual(await provider.getTradingStatus(apple), {
    isTrading: true,
    reason: "trading",
    session: "regular",
  });
  assert.deepEqual(await provider.getQuotes([apple]), [{ instrument: apple, lastPrice: 200 }]);
  assert.equal((await provider.getOrderBook(apple)).asks[0]?.price, 201);
  assert.equal((await provider.getInstrumentInfo([apple]))[0]?.lotSize, 1);
});

test("BrokerAdapter contract supports lifecycle and reconciled protection", async () => {
  const broker: BrokerAdapter = new ContractBrokerAdapter();
  const submitted = await broker.submitOrder({
    instrument: apple,
    side: "buy",
    type: "limit",
    quantity: 10,
    price: 200,
    timeInForce: "day",
  });
  const terminal = await broker.waitForTerminal(submitted.id, 10_000);
  const protection = await broker.submitProtectionOrders({
    instrument: apple,
    quantity: terminal.executedQuantity,
    stopLoss: 180,
    takeProfit: 240,
    recordId: 1,
  });

  assert.equal(broker.protectionMode, "reconciled-orders");
  assert.equal(terminal.status, "filled");
  assert.deepEqual(protection, { stopLossOrderId: "sl-1", takeProfitOrderId: "tp-1" });
});

test("terminal status helper excludes working orders", () => {
  assert.equal(isTerminalOrderStatus("pending"), false);
  assert.equal(isTerminalOrderStatus("partially-filled"), false);
  for (const status of ["filled", "canceled", "rejected", "expired"] as const) {
    assert.equal(isTerminalOrderStatus(status), true);
  }
});
