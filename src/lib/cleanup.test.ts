import assert from "node:assert/strict";
import test from "node:test";
import { OrderStatus } from "longbridge";
import { cleanupOrphanedOrders, selectOcoOrdersToCancel } from "./cleanup.js";

test("selectOcoOrdersToCancel only cancels the opposite order from the same record id", () => {
  const orders = [
    {
      orderId: "sl-old-filled",
      status: OrderStatus.Filled,
      remark: "auto-trade:sl:101",
    },
    {
      orderId: "tp-old-active",
      status: OrderStatus.New,
      remark: "auto-trade:tp:101",
    },
    {
      orderId: "sl-new-active",
      status: OrderStatus.New,
      remark: "auto-trade:sl:202",
    },
    {
      orderId: "tp-new-active",
      status: OrderStatus.New,
      remark: "auto-trade:tp:202",
    },
  ];

  const result = selectOcoOrdersToCancel(orders);
  assert.deepEqual(
    result.map((order) => order.orderId),
    ["tp-old-active"],
  );
});

test("selectOcoOrdersToCancel ignores unmatched or malformed remarks", () => {
  const orders = [
    {
      orderId: "sl-filled",
      status: OrderStatus.Filled,
      remark: "auto-trade:sl:333",
    },
    {
      orderId: "tp-missing-id",
      status: OrderStatus.New,
      remark: "auto-trade:tp:not-a-number",
    },
    {
      orderId: "tp-other-id",
      status: OrderStatus.New,
      remark: "auto-trade:tp:444",
    },
  ];

  const result = selectOcoOrdersToCancel(orders);
  assert.deepEqual(result, []);
});

test("selectOcoOrdersToCancel cancels stop loss when take profit is already filled", () => {
  const orders = [
    {
      orderId: "tp-filled",
      status: OrderStatus.Filled,
      remark: "auto-trade:tp:555",
    },
    {
      orderId: "sl-active",
      status: OrderStatus.VarietiesNotReported,
      remark: "auto-trade:sl:555",
    },
  ];

  const result = selectOcoOrdersToCancel(orders);
  assert.deepEqual(
    result.map((order) => order.orderId),
    ["sl-active"],
  );
});

test("selectOcoOrdersToCancel only returns one cancel target per order id", () => {
  const orders = [
    {
      orderId: "sl-filled",
      status: OrderStatus.Filled,
      remark: "auto-trade:sl:777",
    },
    {
      orderId: "tp-active",
      status: OrderStatus.New,
      remark: "auto-trade:tp:777",
    },
    {
      orderId: "tp-active",
      status: OrderStatus.VarietiesNotReported,
      remark: "auto-trade:tp:777",
    },
  ];

  const result = selectOcoOrdersToCancel(orders);
  assert.deepEqual(
    result.map((order) => order.orderId),
    ["tp-active"],
  );
});

test("cleanupOrphanedOrders uses filled history to cancel orphaned OCO orders", async () => {
  const canceled: string[] = [];
  const historyCalls: Array<{ status: OrderStatus[] }> = [];

  const tradeCtx = {
    async stockPositions() {
      return {
        channels: [
          {
            positions: [
              {
                symbol: "NVDA.US",
                quantity: { toString: () => "68" },
              },
            ],
          },
        ],
      };
    },
    async todayOrders() {
      return [
        {
          orderId: "sl-active",
          symbol: "NVDA.US",
          status: OrderStatus.VarietiesNotReported,
          remark: "auto-trade:sl:888",
        },
      ];
    },
    async historyOrders(opts: { status: OrderStatus[] }) {
      historyCalls.push(opts);
      if (opts.status.includes(OrderStatus.Filled)) {
        return [
          {
            orderId: "tp-filled",
            symbol: "NVDA.US",
            status: OrderStatus.Filled,
            remark: "auto-trade:tp:888",
          },
        ];
      }
      return [];
    },
    async cancelOrder(orderId: string) {
      canceled.push(orderId);
    },
  };

  await cleanupOrphanedOrders(tradeCtx as never);

  assert.deepEqual(canceled, ["sl-active"]);
  assert.equal(historyCalls.length, 2);
  assert.ok(historyCalls.some((call) => call.status.includes(OrderStatus.Filled)));
});
