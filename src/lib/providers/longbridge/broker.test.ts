import assert from "node:assert/strict";
import test from "node:test";
import {
  OrderSide,
  OrderStatus,
  OrderType,
  OutsideRTH,
  TimeInForceType,
  TriggerStatus,
} from "longbridge";
import {
  fromLongbridgeOrderStatus,
  LongbridgeBrokerAdapter,
  mapLongbridgeOrder,
} from "./broker.js";

for (const [status, expected] of [
  [OrderStatus.Filled, "filled"],
  [OrderStatus.Canceled, "canceled"],
  [OrderStatus.Rejected, "rejected"],
  [OrderStatus.Expired, "expired"],
] as const) {
  test(`fromLongbridgeOrderStatus preserves ${expected} when the trigger is active`, () => {
    assert.equal(fromLongbridgeOrderStatus(status, TriggerStatus.Active), expected);
  });
}

test("fromLongbridgeOrderStatus preserves a partial fill when the trigger is active", () => {
  assert.equal(
    fromLongbridgeOrderStatus(OrderStatus.PartialFilled, TriggerStatus.Active),
    "partially-filled",
  );
});

test("fromLongbridgeOrderStatus maps an active non-terminal conditional order to pending", () => {
  assert.equal(
    fromLongbridgeOrderStatus(OrderStatus.VarietiesNotReported, TriggerStatus.Active),
    "pending",
  );
});

test("mapLongbridgeOrder removes broker symbol suffix and Decimal values", () => {
  const mapped = mapLongbridgeOrder({
    orderId: "order-1",
    symbol: "AAPL.US",
    side: OrderSide.Sell,
    orderType: OrderType.LIT,
    status: OrderStatus.VarietiesNotReported,
    quantity: { toString: () => "12" },
    executedQuantity: { toString: () => "2" },
    price: { toString: () => "190.5" },
    triggerPrice: { toString: () => "190.5" },
    timeInForce: TimeInForceType.GoodTilCanceled,
    outsideRth: OutsideRTH.AnyTime,
    remark: "auto-trade:tp:42",
    submittedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: null,
    triggerStatus: TriggerStatus.Active,
  } as never);

  assert.deepEqual(mapped.instrument, { symbol: "AAPL", market: "US" });
  assert.equal(mapped.type, "limit-if-touched");
  assert.equal(mapped.status, "pending");
  assert.equal(mapped.quantity, 12);
  assert.equal(mapped.executedQuantity, 2);
  assert.equal(mapped.price, 190.5);
  assert.equal(mapped.role, "take_profit");
  assert.equal(mapped.outsideRegularHours, true);
});

test("mapLongbridgeOrder recognizes historical overnight orders as outside regular hours", () => {
  const mapped = mapLongbridgeOrder({
    orderId: "overnight-1",
    symbol: "AAPL.US",
    side: OrderSide.Buy,
    orderType: OrderType.LO,
    status: OrderStatus.New,
    quantity: { toString: () => "1" },
    executedQuantity: { toString: () => "0" },
    price: { toString: () => "200" },
    triggerPrice: null,
    timeInForce: TimeInForceType.Day,
    outsideRth: OutsideRTH.Overnight,
    remark: "auto-trade:buy:42",
    submittedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: null,
    triggerStatus: null,
  } as never);

  assert.equal(mapped.outsideRegularHours, true);
});

test("submitOrder maps provider-neutral execution sessions to Longbridge outsideRth", async () => {
  const submitted: Array<{ outsideRth?: OutsideRTH }> = [];
  const adapter = Object.create(LongbridgeBrokerAdapter.prototype) as LongbridgeBrokerAdapter;
  Object.assign(adapter, {
    tradeContext: {
      submitOrder: async (options: { outsideRth?: OutsideRTH }) => {
        submitted.push(options);
        return { orderId: `order-${submitted.length}` };
      },
    },
  });

  for (const executionSession of ["regular", "pre", "post", "any"] as const) {
    await adapter.submitOrder({
      instrument: { symbol: "AAPL", market: "US" },
      side: "buy",
      type: "limit",
      quantity: 1,
      price: 200,
      timeInForce: "day",
      executionSession,
    });
  }

  assert.deepEqual(
    submitted.map((options) => options.outsideRth),
    [OutsideRTH.RTHOnly, OutsideRTH.AnyTime, OutsideRTH.AnyTime, OutsideRTH.AnyTime],
  );

  await assert.rejects(
    adapter.submitOrder({
      instrument: { symbol: "AAPL", market: "US" },
      side: "buy",
      type: "limit",
      quantity: 1,
      price: 200,
      timeInForce: "day",
      executionSession: "overnight" as never,
    }),
    /Unsupported order execution session/,
  );
  assert.equal(submitted.length, 4);
});

test("mapLongbridgeOrder preserves unknown order types instead of guessing", () => {
  const mapped = mapLongbridgeOrder({
    orderId: "order-2",
    symbol: "00700.HK",
    side: OrderSide.Buy,
    orderType: OrderType.TSLPPCT,
    status: OrderStatus.New,
    quantity: { toString: () => "100" },
    executedQuantity: { toString: () => "0" },
    price: null,
    triggerPrice: null,
    timeInForce: TimeInForceType.Day,
    outsideRth: OutsideRTH.RTHOnly,
    remark: "manual",
    submittedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: null,
    triggerStatus: null,
  } as never);

  assert.equal(mapped.type, "unknown");
  assert.equal(mapped.role, "unknown");
  assert.deepEqual(mapped.instrument, { symbol: "00700", market: "HK" });
});

test("mapLongbridgeOrder preserves an unknown side instead of reporting a sell", () => {
  const mapped = mapLongbridgeOrder({
    orderId: "order-3",
    symbol: "AAPL.US",
    side: OrderSide.Unknown,
    orderType: OrderType.LO,
    status: OrderStatus.Unknown,
    quantity: { toString: () => "1" },
    executedQuantity: { toString: () => "0" },
    price: null,
    triggerPrice: null,
    timeInForce: TimeInForceType.Unknown,
    outsideRth: OutsideRTH.Unknown,
    remark: "",
    submittedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: null,
    triggerStatus: null,
  } as never);

  assert.equal(mapped.side, "unknown");
  assert.equal(mapped.status, "unknown");
  assert.equal(mapped.timeInForce, "unknown");
});

test("syncProtectionOrders still updates take profit when stop loss replacement fails", async () => {
  const adapter = Object.create(LongbridgeBrokerAdapter.prototype) as LongbridgeBrokerAdapter;
  const replaced: string[] = [];
  adapter.replaceOrder = async (request) => {
    replaced.push(request.orderId);
    if (request.orderId === "sl-1") throw new Error("stop loss failed");
    return {} as never;
  };

  await assert.rejects(
    adapter.syncProtectionOrders({
      instrument: { symbol: "AAPL", market: "US" },
      quantity: 10,
      recordId: 42,
      stopLoss: 90,
      takeProfit: 120,
      existing: { stopLossOrderId: "sl-1", takeProfitOrderId: "tp-1" },
    }),
    AggregateError,
  );
  assert.deepEqual(replaced, ["sl-1", "tp-1"]);
});

test("stop cleans local state when unsubscribe fails", async () => {
  const adapter = Object.create(LongbridgeBrokerAdapter.prototype) as LongbridgeBrokerAdapter;
  let unsubscribeCalls = 0;
  let cancelCalls = 0;
  const tradeContext = {
    setOnOrderChanged: () => {},
    subscribe: async () => {},
    unsubscribe: async () => {
      unsubscribeCalls += 1;
      throw new Error("connection closed");
    },
    cancelOrder: async () => {
      cancelCalls += 1;
    },
  };
  const pendingWaits = new Map();
  const terminalEvents = new Map([["cached-order", {}]]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  Object.assign(adapter, { tradeContext, pendingWaits, terminalEvents, timers, started: false });

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message) => warnings.push(String(message));

  try {
    await adapter.start();
    const pendingOrder = adapter.waitForTerminal("order-1", 10);

    await adapter.stop();

    await assert.rejects(pendingOrder, /Broker adapter stopped while waiting for order order-1/);
    assert.equal(unsubscribeCalls, 1);
    assert.equal(pendingWaits.size, 0);
    assert.equal(terminalEvents.size, 0);
    assert.equal(timers.size, 0);
    assert.match(warnings[0] ?? "", /connection closed/);
    await assert.rejects(adapter.waitForTerminal("order-2"), /start\(\) must be called/);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cancelCalls, 0);

    await adapter.stop();
    assert.equal(unsubscribeCalls, 1);
  } finally {
    console.warn = originalWarn;
  }
});
