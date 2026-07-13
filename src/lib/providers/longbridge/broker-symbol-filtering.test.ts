import assert from "node:assert/strict";
import test from "node:test";
import { OrderSide, OrderStatus, OrderType, OutsideRTH, TimeInForceType } from "longbridge";
import { LongbridgeBrokerAdapter } from "./broker.js";

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

function adapterWithTradeContext(tradeContext: object): LongbridgeBrokerAdapter {
  const adapter = Object.create(LongbridgeBrokerAdapter.prototype) as LongbridgeBrokerAdapter;
  Object.defineProperty(adapter, "tradeContext", { value: tradeContext });
  return adapter;
}

function order(orderId: string, symbol: string) {
  return {
    orderId,
    symbol,
    side: OrderSide.Buy,
    orderType: OrderType.LO,
    status: OrderStatus.New,
    quantity: decimal("10"),
    executedQuantity: decimal("0"),
    price: decimal("100"),
    triggerPrice: null,
    timeInForce: TimeInForceType.Day,
    outsideRth: OutsideRTH.RTHOnly,
    remark: "manual",
    submittedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: null,
    triggerStatus: null,
  };
}

test("getPositions skips unsupported markets while preserving supported positions", async () => {
  const adapter = adapterWithTradeContext({
    stockPositions: async () => ({
      channels: [
        {
          positions: [
            {
              symbol: "AAPL.US",
              quantity: decimal("12"),
              availableQuantity: decimal("10"),
              costPrice: decimal("190.5"),
            },
            {
              symbol: "7203.JP",
              quantity: decimal("3"),
              availableQuantity: decimal("3"),
              costPrice: decimal("2500"),
            },
          ],
        },
      ],
    }),
  });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    assert.deepEqual(await adapter.getPositions(), [
      {
        instrument: { symbol: "AAPL", market: "US" },
        quantity: 12,
        availableQuantity: 10,
        costPrice: 190.5,
      },
    ]);
    assert.deepEqual(warnings, [["[WARN] 跳过不支持市场的 Longbridge 持仓: 7203.JP"]]);
  } finally {
    console.warn = originalWarn;
  }
});

test("listOrders skips unsupported markets while preserving supported orders", async () => {
  const adapter = adapterWithTradeContext({
    todayOrders: async () => [order("order-hk", "00700.HK"), order("order-jp", "7203.JP")],
  });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const orders = await adapter.listOrders();
    assert.deepEqual(
      orders.map(({ id, instrument }) => ({ id, instrument })),
      [{ id: "order-hk", instrument: { symbol: "00700", market: "HK" } }],
    );
    assert.deepEqual(warnings, [["[WARN] 跳过不支持市场的 Longbridge 订单: order-jp (7203.JP)"]]);
  } finally {
    console.warn = originalWarn;
  }
});

test("position and order mapping errors outside unsupported markets still propagate", async () => {
  const invalidPositionAdapter = adapterWithTradeContext({
    stockPositions: async () => ({
      channels: [
        {
          positions: [
            {
              symbol: "AAPL",
              quantity: decimal("1"),
              availableQuantity: decimal("1"),
              costPrice: decimal("100"),
            },
          ],
        },
      ],
    }),
  });
  await assert.rejects(invalidPositionAdapter.getPositions(), /Invalid Longbridge symbol: AAPL/);

  const invalidOrder = order("order-invalid", "AAPL.US");
  invalidOrder.quantity = {
    toString: () => {
      throw new Error("quantity mapping failed");
    },
  };
  const invalidOrderAdapter = adapterWithTradeContext({
    todayOrders: async () => [invalidOrder],
  });
  await assert.rejects(invalidOrderAdapter.listOrders(), /quantity mapping failed/);
});
