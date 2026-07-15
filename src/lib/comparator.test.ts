import assert from "node:assert/strict";
import test from "node:test";
import { buildActionPlan, buildPreflightPlan } from "./comparator.js";
import type { ActiveOrder, AnalysisRecord, PortfolioState } from "./types.js";

function makeRecord(overrides: Partial<AnalysisRecord> = {}): AnalysisRecord {
  return {
    id: 1,
    query_id: null,
    code: "AAPL",
    name: "Apple",
    report_type: "agent",
    sentiment_score: 80,
    action: "sell",
    operation_advice: "卖出",
    trend_prediction: "看空",
    analysis_summary: null,
    raw_result: null,
    news_content: null,
    context_snapshot: null,
    ideal_buy: 100,
    secondary_buy: null,
    stop_loss: 95,
    take_profit: 110,
    created_at: "2026-05-08 09:00:00",
    ...overrides,
  };
}

function makeOrder(overrides: Partial<ActiveOrder> = {}): ActiveOrder {
  return {
    orderId: "ord-1",
    symbol: "AAPL",
    side: "Sell",
    orderType: "MIT",
    price: "0",
    triggerPrice: "95",
    quantity: "100",
    status: "New",
    role: "stop_loss",
    remark: "auto-trade:sl:1",
    ...overrides,
  };
}

test("buildActionPlan includes existing SL/TP orders on sell actions", () => {
  const portfolio: PortfolioState = {
    holdings: new Map([
      [
        "AAPL",
        {
          symbol: "AAPL",
          instrument: { symbol: "AAPL", market: "US" },
          quantity: 100,
          availableQuantity: 100,
          costPrice: 98,
        },
      ],
    ]),
    activeOrders: [
      makeOrder(),
      makeOrder({
        orderId: "ord-2",
        orderType: "LIT",
        price: "110",
        triggerPrice: "110",
        role: "take_profit",
        remark: "auto-trade:tp:1",
      }),
    ],
    orphanWarnings: [],
  };

  const plans = buildActionPlan(portfolio, [], [makeRecord({})], new Map());
  assert.equal(plans.length, 1);

  const [plan] = plans;
  assert.equal(plan.action, "SELL_FULL");
  assert.equal(plan.existingSlOrder?.orderId, "ord-1");
  assert.equal(plan.existingTpOrder?.orderId, "ord-2");
  assert.deepEqual(
    plan.ordersToCancel?.map((order) => order.orderId),
    ["ord-1", "ord-2"],
  );
});

test("buildActionPlan does not update a pending buy when the threshold price already matches", () => {
  const portfolio: PortfolioState = {
    holdings: new Map(),
    activeOrders: [
      makeOrder({
        orderId: "buy-1",
        side: "Buy",
        orderType: "LO",
        price: "102",
        triggerPrice: "0",
        quantity: "100",
        role: "buy",
        remark: "auto-trade:buy:1",
      }),
    ],
    orphanWarnings: [],
  };

  const plans = buildActionPlan(
    portfolio,
    [makeRecord({ action: "buy", operation_advice: "买入", trend_prediction: "看多" })],
    [],
    new Map(),
    2,
  );

  assert.equal(plans.length, 0);
});

test("buildActionPlan skips a completed buy signal when its record id already hit SL/TP", () => {
  const portfolio: PortfolioState = {
    holdings: new Map(),
    activeOrders: [],
    orphanWarnings: [],
  };

  const plans = buildActionPlan(
    portfolio,
    [
      makeRecord({
        id: 88,
        action: "buy",
        operation_advice: "买入",
        trend_prediction: "看多",
      }),
    ],
    [],
    new Map(),
    2,
    new Set([88]),
  );

  assert.equal(plans.length, 0);
});

test("buildActionPlan still buys when only an older record id was completed", () => {
  const portfolio: PortfolioState = {
    holdings: new Map(),
    activeOrders: [],
    orphanWarnings: [],
  };

  const plans = buildActionPlan(
    portfolio,
    [
      makeRecord({
        id: 99,
        action: "buy",
        operation_advice: "买入",
        trend_prediction: "看多",
      }),
    ],
    [],
    new Map(),
    2,
    new Set([88]),
  );

  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.action, "NEW_BUY");
  assert.equal(plans[0]?.record.id, 99);
});

test("buildActionPlan creates add-position action for held symbols with add signal", () => {
  const portfolio: PortfolioState = {
    holdings: new Map([
      [
        "AAPL",
        {
          symbol: "AAPL",
          instrument: { symbol: "AAPL", market: "US" },
          quantity: 100,
          availableQuantity: 100,
          costPrice: 98,
        },
      ],
    ]),
    activeOrders: [
      makeOrder(),
      makeOrder({
        orderId: "tp-1",
        orderType: "LIT",
        price: "110",
        triggerPrice: "110",
        role: "take_profit",
        remark: "auto-trade:tp:1",
      }),
    ],
    orphanWarnings: [],
  };

  const plans = buildActionPlan(
    portfolio,
    [makeRecord({ action: "add", operation_advice: "观望", trend_prediction: "震荡" })],
    [],
    new Map(),
  );

  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.action, "ADD_POSITION");
  assert.equal(plans[0]?.holding?.quantity, 100);
  assert.equal(plans[0]?.existingSlOrder?.orderId, "ord-1");
  assert.equal(plans[0]?.existingTpOrder?.orderId, "tp-1");
});

test("buildActionPlan creates partial sell from reduce action without Chinese advice", () => {
  const portfolio: PortfolioState = {
    holdings: new Map([
      [
        "AAPL",
        {
          symbol: "AAPL",
          instrument: { symbol: "AAPL", market: "US" },
          quantity: 100,
          availableQuantity: 100,
          costPrice: 98,
        },
      ],
    ]),
    activeOrders: [],
    orphanWarnings: [],
  };

  const plans = buildActionPlan(
    portfolio,
    [],
    [makeRecord({ action: "reduce", operation_advice: "观望", trend_prediction: "震荡" })],
    new Map(),
  );

  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.action, "SELL_PARTIAL");
  assert.equal(plans[0]?.sellPct, 50);
});

test("buildActionPlan skips new positions when max holdings is reached", () => {
  const portfolio: PortfolioState = {
    holdings: new Map([
      [
        "AAPL",
        {
          symbol: "AAPL",
          instrument: { symbol: "AAPL", market: "US" },
          quantity: 100,
          availableQuantity: 100,
          costPrice: 98,
        },
      ],
    ]),
    activeOrders: [],
    orphanWarnings: [],
  };

  const plans = buildActionPlan(
    portfolio,
    [
      makeRecord({
        code: "MSFT",
        action: "buy",
        operation_advice: "买入",
        trend_prediction: "看多",
      }),
    ],
    [],
    new Map(),
    2,
    new Set(),
    1,
  );

  assert.equal(
    plans.some((plan) => plan.action === "NEW_BUY"),
    false,
  );
});

test("buildPreflightPlan cancels a stale pending buy when the latest signal turns sell", () => {
  const portfolio: PortfolioState = {
    holdings: new Map(),
    activeOrders: [
      makeOrder({
        orderId: "buy-1",
        side: "Buy",
        orderType: "LO",
        price: "100",
        triggerPrice: "0",
        quantity: "100",
        role: "buy",
        remark: "auto-trade:buy:1",
      }),
    ],
    orphanWarnings: [],
  };

  const plans = buildPreflightPlan(
    portfolio,
    [],
    [makeRecord({ operation_advice: "卖出" })],
    new Map(),
  );

  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.action, "CANCEL_CONFLICTING_ORDERS");
  assert.deepEqual(
    plans[0]?.ordersToCancel?.map((order) => order.orderId),
    ["buy-1"],
  );
});

test("buildPreflightPlan cancels a stale pending sell when the latest signal turns buy", () => {
  const portfolio: PortfolioState = {
    holdings: new Map([
      [
        "AAPL",
        {
          symbol: "AAPL",
          instrument: { symbol: "AAPL", market: "US" },
          quantity: 100,
          availableQuantity: 0,
          costPrice: 98,
        },
      ],
    ]),
    activeOrders: [
      makeOrder({
        orderId: "sell-1",
        orderType: "LO",
        price: "105",
        triggerPrice: "0",
        quantity: "100",
        role: "sell",
        remark: "auto-trade:sell:1",
      }),
    ],
    orphanWarnings: [],
  };

  const plans = buildPreflightPlan(
    portfolio,
    [makeRecord({ action: "buy", operation_advice: "买入", trend_prediction: "看多" })],
    [],
    new Map(),
  );

  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.action, "CANCEL_CONFLICTING_ORDERS");
  assert.deepEqual(
    plans[0]?.ordersToCancel?.map((order) => order.orderId),
    ["sell-1"],
  );
});
