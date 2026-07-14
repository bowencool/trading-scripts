import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCleanupActions,
  collectCleanupActions,
  collectCompletedBuySignalRecordIdsFromSnapshot,
  executeCleanupActions,
  formatCleanupAction,
  selectOcoOrdersToCancel,
} from "./cleanup.js";
import type { BrokerOrder, OrderRole, OrderStatus } from "./providers/types.js";

function order(
  id: string,
  status: OrderStatus,
  role: OrderRole,
  remark: string,
  symbol = "NVDA",
): BrokerOrder {
  return {
    id,
    instrument: { symbol, market: "US" },
    side: role === "buy" ? "buy" : "sell",
    type: "limit",
    status,
    quantity: 1,
    executedQuantity: status === "filled" ? 1 : 0,
    timeInForce: "good-til-canceled",
    outsideRegularHours: true,
    remark,
    role,
  };
}

test("selectOcoOrdersToCancel only cancels the opposite order from the same record id", () => {
  const orders = [
    order("sl-old-filled", "filled", "stop_loss", "auto-trade:sl:101"),
    order("tp-old-active", "pending", "take_profit", "auto-trade:tp:101"),
    order("sl-new-active", "pending", "stop_loss", "auto-trade:sl:202"),
    order("tp-new-active", "pending", "take_profit", "auto-trade:tp:202"),
  ];
  assert.deepEqual(
    selectOcoOrdersToCancel(orders).map((item) => item.id),
    ["tp-old-active"],
  );
});

test("selectOcoOrdersToCancel ignores unmatched or malformed remarks", () => {
  const orders = [
    order("sl-filled", "filled", "stop_loss", "auto-trade:sl:333"),
    order("tp-missing-id", "pending", "take_profit", "auto-trade:tp:not-a-number"),
    order("tp-other-id", "pending", "take_profit", "auto-trade:tp:444"),
  ];
  assert.deepEqual(selectOcoOrdersToCancel(orders), []);
});

test("buildCleanupActions marks active SL/TP without holding as orphan cleanup", () => {
  const result = buildCleanupActions(new Set<string>(), [
    order("sl-active", "pending", "stop_loss", "auto-trade:sl:301", "KO"),
    order("tp-active", "pending", "take_profit", "auto-trade:tp:301", "KO"),
  ]);
  assert.deepEqual(
    result.map(({ kind, orderId, role }) => ({ kind, orderId, role })),
    [
      { kind: "orphan", orderId: "sl-active", role: "stop_loss" },
      { kind: "orphan", orderId: "tp-active", role: "take_profit" },
    ],
  );
});

test("buildCleanupActions avoids duplicate cancellation when orphan and OCO overlap", () => {
  const result = buildCleanupActions(new Set<string>(), [
    order("sl-active", "pending", "stop_loss", "auto-trade:sl:888"),
    order("tp-filled", "filled", "take_profit", "auto-trade:tp:888"),
  ]);
  assert.deepEqual(result, [
    {
      kind: "orphan",
      orderId: "sl-active",
      symbol: "NVDA",
      role: "stop_loss",
      recordId: "888",
    },
  ]);
});

test("collectCleanupActions queries sequential snapshots including filled history", async () => {
  const calls: string[] = [];
  const broker = {
    async getPositions() {
      calls.push("positions");
      return [
        {
          instrument: { symbol: "NVDA", market: "US" as const },
          quantity: 68,
          availableQuantity: 68,
          costPrice: 100,
        },
      ];
    },
    async listOrders(query: { scope?: string; statuses?: OrderStatus[] }) {
      calls.push(query.statuses?.[0] ?? query.scope ?? "orders");
      if (query.statuses?.includes("filled")) {
        return [order("tp-filled", "filled", "take_profit", "auto-trade:tp:888")];
      }
      if (query.statuses?.includes("pending")) return [];
      return [order("sl-active", "pending", "stop_loss", "auto-trade:sl:888")];
    },
  };
  const result = await collectCleanupActions(broker as never);
  assert.deepEqual(result, [
    {
      kind: "oco",
      orderId: "sl-active",
      symbol: "NVDA",
      role: "stop_loss",
      recordId: "888",
    },
  ]);
  assert.deepEqual(calls, ["positions", "today", "pending", "filled"]);
});

test("collectCompletedBuySignalRecordIdsFromSnapshot only keeps filled SL/TP ids", () => {
  const recordIds = collectCompletedBuySignalRecordIdsFromSnapshot({
    positions: [],
    todayOrders: [
      order("tp", "filled", "take_profit", "auto-trade:tp:888"),
      order("buy", "filled", "buy", "auto-trade:buy:777"),
      order("pending", "pending", "take_profit", "auto-trade:tp:666"),
    ],
    historyActiveOrders: [],
    historyFilledOrders: [
      order("sl", "filled", "stop_loss", "auto-trade:sl:555", "AAPL"),
      order("malformed", "filled", "take_profit", "auto-trade:tp:nope", "AAPL"),
    ],
  });
  assert.deepEqual(
    [...recordIds].sort((a, b) => a - b),
    [555, 888],
  );
});

test("executeCleanupActions cancels only supplied actions", async () => {
  const canceled: string[] = [];
  await executeCleanupActions({ cancelOrder: async (id: string) => void canceled.push(id) }, [
    {
      kind: "orphan",
      orderId: "sl-active",
      symbol: "KO",
      role: "stop_loss",
      recordId: "301",
    },
    {
      kind: "oco",
      orderId: "tp-active",
      symbol: "NVDA",
      role: "take_profit",
      recordId: "888",
    },
  ]);
  assert.deepEqual(canceled, ["sl-active", "tp-active"]);
});

test("formatCleanupAction renders dry-run preview", () => {
  assert.equal(
    formatCleanupAction(
      {
        kind: "oco",
        orderId: "sl-active",
        symbol: "NVDA",
        role: "stop_loss",
        recordId: "888",
      },
      "dry-run",
    ),
    "[DRY RUN][OCO] 止盈已成交，将取消止损 sl-active (NVDA, record 888)",
  );
});
