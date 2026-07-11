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

test("fromLongbridgeOrderStatus normalizes active conditional and terminal states", () => {
  assert.equal(
    fromLongbridgeOrderStatus(OrderStatus.VarietiesNotReported, TriggerStatus.Active),
    "pending",
  );
  assert.equal(fromLongbridgeOrderStatus(OrderStatus.PartialFilled), "partially-filled");
  assert.equal(fromLongbridgeOrderStatus(OrderStatus.Filled), "filled");
  assert.equal(fromLongbridgeOrderStatus(OrderStatus.Canceled), "canceled");
  assert.equal(fromLongbridgeOrderStatus(OrderStatus.Rejected), "rejected");
  assert.equal(fromLongbridgeOrderStatus(OrderStatus.Expired), "expired");
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
