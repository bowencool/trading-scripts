import assert from "node:assert/strict";
import test from "node:test";
import {
  type ExecutorConfig,
  executeAction,
  getEffectivePrice,
  getRemainingPositionQuantity,
} from "./executor.js";
import type { BrokerAdapter } from "./providers/broker.js";
import type { MarketDataProvider } from "./providers/market-data.js";
import type {
  BracketOrderRequest,
  BrokerOrder,
  Instrument,
  SyncProtectionRequest,
} from "./providers/types.js";
import type { ActionPlan, AnalysisRecord } from "./types.js";

const instrument: Instrument = { symbol: "AAPL", market: "US" };

function makeRecord(): AnalysisRecord {
  return {
    id: 42,
    query_id: null,
    code: "AAPL",
    name: "Apple",
    report_type: "agent",
    sentiment_score: 80,
    action: "buy",
    operation_advice: "买入",
    trend_prediction: "看多",
    analysis_summary: null,
    raw_result: null,
    news_content: null,
    context_snapshot: null,
    ideal_buy: 100,
    secondary_buy: null,
    stop_loss: 95,
    take_profit: 110,
    created_at: "2026-07-11 09:00:00",
  };
}

function makeOrder(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    id: "entry-1",
    instrument,
    side: "buy",
    type: "limit",
    status: "filled",
    quantity: 9,
    executedQuantity: 9,
    price: 102,
    timeInForce: "day",
    outsideRegularHours: true,
    remark: "auto-trade:buy:42",
    role: "buy",
    ...overrides,
  };
}

function makeMarketData(overrides: Partial<MarketDataProvider> = {}): MarketDataProvider {
  return {
    getTradingStatus: async () => ({
      isTrading: true,
      reason: "trading",
      session: "regular",
    }),
    getOrderBook: async (requested) => ({
      instrument: requested,
      bids: [{ price: 99, quantity: 10 }],
      asks: [{ price: 100, quantity: 10 }],
    }),
    getQuotes: async (requested) => requested.map((item) => ({ instrument: item, lastPrice: 98 })),
    getInstrumentInfo: async (requested) =>
      requested.map((item) => ({ instrument: item, lotSize: 1 })),
    ...overrides,
  };
}

function makeBroker(overrides: Partial<BrokerAdapter> = {}): BrokerAdapter {
  return {
    protectionMode: "reconciled-orders",
    getAccountBalances: async () => [
      { currency: "USD", buyingPower: 10_000, netAssets: 10_000, cash: 10_000 },
    ],
    ...overrides,
  } as BrokerAdapter;
}

function makeConfig(
  broker: BrokerAdapter,
  marketData: MarketDataProvider = makeMarketData(),
): ExecutorConfig {
  return {
    broker,
    marketData,
    autoApprove: true,
    buyPct: 10,
    sellPct: 50,
    riskPctPerTrade: 0,
    maxPositionPct: 0,
    priceThresholdPct: 2,
  };
}

test("getRemainingPositionQuantity returns zero when position is fully sold", () => {
  assert.equal(getRemainingPositionQuantity(100, 100), 0);
});

test("getRemainingPositionQuantity keeps the unsold remainder protected", () => {
  assert.equal(getRemainingPositionQuantity(100, 40), 60);
});

test("getRemainingPositionQuantity never returns a negative position", () => {
  assert.equal(getRemainingPositionQuantity(100, 120), 0);
});

test("getEffectivePrice prefers order book and falls back through pre/post sessions", async () => {
  assert.deepEqual(await getEffectivePrice(makeMarketData(), instrument, "buy"), {
    price: 100,
    source: "卖一",
  });

  const fallback = makeMarketData({
    getOrderBook: async () => {
      throw new Error("depth unavailable");
    },
    getQuotes: async () => [
      {
        instrument,
        lastPrice: 98,
        preMarket: { price: 0 },
        postMarket: { price: 101 },
      },
    ],
  });
  assert.deepEqual(await getEffectivePrice(fallback, instrument, "sell"), {
    price: 101,
    source: "盘后",
  });
});

test("getEffectivePrice uses only the active pre/post session quote", async () => {
  let depthCalls = 0;
  const marketData = makeMarketData({
    getOrderBook: async (requested) => {
      depthCalls += 1;
      return {
        instrument: requested,
        bids: [{ price: 205, quantity: 10 }],
        asks: [{ price: 206, quantity: 10 }],
      };
    },
    getQuotes: async () => [
      {
        instrument,
        lastPrice: 204,
        preMarket: { price: 202 },
        postMarket: { price: 201 },
      },
    ],
  });

  assert.deepEqual(await getEffectivePrice(marketData, instrument, "buy", "pre"), {
    price: 202,
    source: "盘前",
  });
  assert.deepEqual(await getEffectivePrice(marketData, instrument, "sell", "post"), {
    price: 201,
    source: "盘后",
  });
  assert.equal(depthCalls, 0);
});

test("new buys submit a provider-neutral bracket order", async () => {
  let captured: BracketOrderRequest | undefined;
  const apiCalls: string[] = [];
  const broker = makeBroker({
    getAccountBalances: async () => {
      apiCalls.push("account-balances");
      return [{ currency: "USD", buyingPower: 10_000, netAssets: 10_000, cash: 10_000 }];
    },
    submitBracketOrder: async (request) => {
      apiCalls.push("submit-bracket");
      captured = request;
      return {
        mode: "reconciled-orders",
        entryOrder: makeOrder(),
        protectionOrders: { stopLossOrderId: "sl-1", takeProfitOrderId: "tp-1" },
      };
    },
  });
  const plan: ActionPlan = {
    action: "NEW_BUY",
    instrument,
    symbol: "AAPL",
    record: makeRecord(),
  };
  const marketData = makeMarketData({
    getTradingStatus: async () => {
      apiCalls.push("trading-status");
      return { isTrading: true, reason: "trading", session: "regular" };
    },
    getInstrumentInfo: async (requested) => {
      apiCalls.push("instrument-info");
      return requested.map((item) => ({ instrument: item, lotSize: 1 }));
    },
    getOrderBook: async (requested) => {
      apiCalls.push("order-book");
      return {
        instrument: requested,
        bids: [{ price: 99, quantity: 10 }],
        asks: [{ price: 100, quantity: 10 }],
      };
    },
  });

  await executeAction(makeConfig(broker, marketData), plan);

  assert.deepEqual(apiCalls, [
    "trading-status",
    "instrument-info",
    "account-balances",
    "order-book",
    "trading-status",
    "submit-bracket",
  ]);
  assert.deepEqual(captured, {
    entry: {
      instrument,
      type: "limit",
      side: "buy",
      timeInForce: "day",
      quantity: 9,
      price: 102,
      executionSession: "regular",
      remark: "auto-trade:buy:42",
    },
    protection: { stopLoss: 95, takeProfit: 110 },
    recordId: 42,
    waitTimeoutMs: 10_000,
  });
});

test("add-position buys wait for the entry and sync protection to total quantity", async () => {
  let synced: SyncProtectionRequest | undefined;
  const broker = makeBroker({
    submitOrder: async () => makeOrder({ status: "pending", executedQuantity: 0 }),
    waitForTerminal: async () => makeOrder(),
    getOrder: async () => makeOrder({ quantity: 5, executedQuantity: 5 }),
    syncProtectionOrders: async (request) => {
      synced = request;
      return { stopLossOrderId: "sl-1", takeProfitOrderId: "tp-1" };
    },
  });
  const plan: ActionPlan = {
    action: "ADD_POSITION",
    instrument,
    symbol: "AAPL",
    record: { ...makeRecord(), action: "add", operation_advice: "加仓" },
    holding: {
      instrument,
      symbol: "AAPL",
      quantity: 100,
      availableQuantity: 100,
      costPrice: 90,
    },
    existingSlOrder: {
      orderId: "sl-1",
      symbol: "AAPL",
      side: "Sell",
      orderType: "market-if-touched",
      price: "0",
      triggerPrice: "94",
      quantity: "100",
      status: "pending",
      role: "stop_loss",
      remark: "auto-trade:sl:1",
    },
    existingTpOrder: {
      orderId: "tp-1",
      symbol: "AAPL",
      side: "Sell",
      orderType: "limit-if-touched",
      price: "109",
      triggerPrice: "109",
      quantity: "100",
      status: "pending",
      role: "take_profit",
      remark: "auto-trade:tp:1",
    },
  };

  await executeAction(makeConfig(broker), plan);

  assert.deepEqual(synced, {
    instrument,
    quantity: 105,
    recordId: 42,
    stopLoss: 95,
    takeProfit: 110,
    existing: { stopLossOrderId: "sl-1", takeProfitOrderId: "tp-1" },
  });
});

test("closed markets skip new orders before querying balances or prices", async () => {
  let submitted = false;
  let queriedBalance = false;
  const broker = makeBroker({
    getAccountBalances: async () => {
      queriedBalance = true;
      return [];
    },
    submitBracketOrder: async () => {
      submitted = true;
      throw new Error("must not submit");
    },
  });
  const marketData = makeMarketData({
    getTradingStatus: async () => ({ isTrading: false, reason: "non-trading-day" }),
  });

  await executeAction(makeConfig(broker, marketData), {
    action: "NEW_BUY",
    instrument,
    symbol: "AAPL",
    record: makeRecord(),
  });

  assert.equal(queriedBalance, false);
  assert.equal(submitted, false);
});

test("unsupported provider sessions fail closed before a buy", async () => {
  let submitted = false;
  let queriedBalance = false;
  const broker = makeBroker({
    getAccountBalances: async () => {
      queriedBalance = true;
      return [];
    },
    submitBracketOrder: async () => {
      submitted = true;
      throw new Error("must not submit");
    },
  });

  await executeAction(
    makeConfig(
      broker,
      makeMarketData({
        getTradingStatus: async () => ({
          isTrading: true,
          reason: "trading",
          session: "unsupported" as never,
        }),
      }),
    ),
    {
      action: "NEW_BUY",
      instrument,
      symbol: "AAPL",
      record: makeRecord(),
    },
  );

  assert.equal(queriedBalance, false);
  assert.equal(submitted, false);
});

test("new orders re-check the session immediately before submission", async () => {
  let statusChecks = 0;
  let submitted = false;
  const broker = makeBroker({
    submitBracketOrder: async () => {
      submitted = true;
      throw new Error("must not submit");
    },
  });
  const marketData = makeMarketData({
    getTradingStatus: async () => {
      statusChecks += 1;
      return statusChecks === 1
        ? { isTrading: true, reason: "trading", session: "regular" }
        : { isTrading: false, reason: "outside-trading-session" };
    },
  });

  await executeAction(makeConfig(broker, marketData), {
    action: "NEW_BUY",
    instrument,
    symbol: "AAPL",
    record: makeRecord(),
  });

  assert.equal(statusChecks, 2);
  assert.equal(submitted, false);
});

test("closed markets skip sells before canceling protection orders", async () => {
  let canceled = false;
  let submitted = false;
  const broker = makeBroker({
    cancelOrder: async () => {
      canceled = true;
    },
    submitOrder: async () => {
      submitted = true;
      return makeOrder();
    },
  });

  await executeAction(
    makeConfig(
      broker,
      makeMarketData({
        getTradingStatus: async () => ({
          isTrading: false,
          reason: "outside-trading-session",
        }),
      }),
    ),
    {
      action: "SELL_FULL",
      instrument,
      symbol: "AAPL",
      record: { ...makeRecord(), operation_advice: "卖出" },
      holding: {
        instrument,
        symbol: "AAPL",
        quantity: 100,
        availableQuantity: 100,
        costPrice: 90,
      },
      existingSlOrder: {
        orderId: "sl-1",
        symbol: "AAPL",
        side: "Sell",
        orderType: "market-if-touched",
        price: "0",
        triggerPrice: "95",
        quantity: "100",
        status: "pending",
        role: "stop_loss",
        remark: "auto-trade:sl:42",
      },
    },
  );

  assert.equal(canceled, false);
  assert.equal(submitted, false);
});

test("sells restore canceled protection when the session closes before submission", async () => {
  const calls: string[] = [];
  let statusChecks = 0;
  const broker = makeBroker({
    cancelOrder: async (orderId) => {
      calls.push(`cancel:${orderId}`);
    },
    submitOrder: async () => {
      calls.push("submit-sell");
      return makeOrder();
    },
    submitProtectionOrders: async (request) => {
      calls.push("restore-protection");
      assert.deepEqual(request, {
        instrument,
        quantity: 100,
        recordId: 42,
        stopLoss: 95,
        takeProfit: 110,
      });
      return { stopLossOrderId: "sl-restored", takeProfitOrderId: "tp-restored" };
    },
  });
  const marketData = makeMarketData({
    getTradingStatus: async () => {
      statusChecks += 1;
      calls.push(`status:${statusChecks}`);
      return statusChecks === 1
        ? { isTrading: true, reason: "trading", session: "regular" }
        : { isTrading: false, reason: "outside-trading-session" };
    },
  });

  await executeAction(makeConfig(broker, marketData), {
    action: "SELL_FULL",
    instrument,
    symbol: "AAPL",
    record: { ...makeRecord(), operation_advice: "卖出" },
    holding: {
      instrument,
      symbol: "AAPL",
      quantity: 100,
      availableQuantity: 100,
      costPrice: 90,
    },
    existingSlOrder: {
      orderId: "sl-1",
      symbol: "AAPL",
      side: "Sell",
      orderType: "market-if-touched",
      price: "0",
      triggerPrice: "95",
      quantity: "100",
      status: "pending",
      role: "stop_loss",
      remark: "auto-trade:sl:42",
    },
    existingTpOrder: {
      orderId: "tp-1",
      symbol: "AAPL",
      side: "Sell",
      orderType: "limit-if-touched",
      price: "110",
      triggerPrice: "110",
      quantity: "100",
      status: "pending",
      role: "take_profit",
      remark: "auto-trade:tp:42",
    },
  });

  assert.equal(statusChecks, 2);
  assert.deepEqual(calls, [
    "status:1",
    "cancel:sl-1",
    "cancel:tp-1",
    "status:2",
    "restore-protection",
  ]);
});

test("unsupported provider sessions fail closed before a sell", async () => {
  let submitted = false;
  const broker = makeBroker({
    submitOrder: async () => {
      submitted = true;
      return makeOrder();
    },
  });
  const marketData = makeMarketData({
    getTradingStatus: async () => ({
      isTrading: true,
      reason: "trading",
      session: "unsupported" as never,
    }),
  });

  await executeAction(makeConfig(broker, marketData), {
    action: "SELL_FULL",
    instrument,
    symbol: "AAPL",
    record: { ...makeRecord(), operation_advice: "卖出" },
    holding: {
      instrument,
      symbol: "AAPL",
      quantity: 100,
      availableQuantity: 100,
      costPrice: 90,
    },
  });

  assert.equal(submitted, false);
});

test("closed markets skip replacing pending entry orders", async () => {
  let replaced = false;
  const broker = makeBroker({
    replaceOrder: async () => {
      replaced = true;
      return makeOrder();
    },
  });

  await executeAction(
    makeConfig(
      broker,
      makeMarketData({
        getTradingStatus: async () => ({
          isTrading: false,
          reason: "outside-trading-session",
        }),
      }),
    ),
    {
      action: "UPDATE_BUY",
      instrument,
      symbol: "AAPL",
      record: makeRecord(),
      pendingBuyOrder: {
        orderId: "buy-1",
        symbol: "AAPL",
        side: "Buy",
        orderType: "limit",
        price: "101",
        triggerPrice: "0",
        quantity: "9",
        status: "pending",
        role: "buy",
        remark: "auto-trade:buy:41",
      },
    },
  );

  assert.equal(replaced, false);
});

test("unsupported provider sessions skip replacing an order", async () => {
  let replaced = false;
  const broker = makeBroker({
    replaceOrder: async () => {
      replaced = true;
      return makeOrder();
    },
  });

  await executeAction(
    makeConfig(
      broker,
      makeMarketData({
        getTradingStatus: async () => ({
          isTrading: true,
          reason: "trading",
          session: "unsupported" as never,
        }),
      }),
    ),
    {
      action: "UPDATE_BUY",
      instrument,
      symbol: "AAPL",
      record: makeRecord(),
      pendingBuyOrder: {
        orderId: "buy-1",
        symbol: "AAPL",
        side: "Buy",
        orderType: "limit",
        price: "101",
        triggerPrice: "0",
        quantity: "9",
        status: "pending",
        role: "buy",
        remark: "auto-trade:buy:41",
      },
    },
  );

  assert.equal(replaced, false);
});

test("protection recovery remains available outside trading sessions", async () => {
  let checkedStatus = false;
  let submittedProtection = false;
  const broker = makeBroker({
    submitProtectionOrders: async () => {
      submittedProtection = true;
      return { stopLossOrderId: "sl-1" };
    },
  });

  await executeAction(
    makeConfig(
      broker,
      makeMarketData({
        getTradingStatus: async () => {
          checkedStatus = true;
          return { isTrading: false, reason: "outside-trading-session" };
        },
      }),
    ),
    {
      action: "RECOVER_SL_TP",
      instrument,
      symbol: "AAPL",
      record: makeRecord(),
      holding: {
        instrument,
        symbol: "AAPL",
        quantity: 100,
        availableQuantity: 100,
        costPrice: 90,
      },
    },
  );

  assert.equal(checkedStatus, false);
  assert.equal(submittedProtection, true);
});
