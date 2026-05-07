import assert from "node:assert/strict";
import test from "node:test";
import { OrderStatus } from "longbridge";
import { selectOcoOrdersToCancel } from "./cleanup.js";

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
