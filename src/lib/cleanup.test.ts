import assert from "node:assert/strict";
import test from "node:test";
import { OrderStatus } from "longbridge";
import {
  buildCleanupActions,
  collectCleanupActions,
  collectCompletedBuySignalRecordIdsFromSnapshot,
  executeCleanupActions,
  formatCleanupAction,
  selectOcoOrdersToCancel,
} from "./cleanup.js";

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

test("buildCleanupActions marks active SL/TP without holding as orphan cleanup", () => {
  const result = buildCleanupActions(new Set<string>(), [
    {
      orderId: "sl-active",
      symbol: "KO.US",
      status: OrderStatus.New,
      remark: "auto-trade:sl:301",
    },
    {
      orderId: "tp-active",
      symbol: "KO.US",
      status: OrderStatus.VarietiesNotReported,
      remark: "auto-trade:tp:301",
    },
  ]);

  assert.deepEqual(
    result.map((action) => ({
      kind: action.kind,
      orderId: action.orderId,
      role: action.role,
    })),
    [
      { kind: "orphan", orderId: "sl-active", role: "stop_loss" },
      { kind: "orphan", orderId: "tp-active", role: "take_profit" },
    ],
  );
});

test("buildCleanupActions avoids duplicate cancellation when orphan and OCO rules overlap", () => {
  const result = buildCleanupActions(new Set<string>(), [
    {
      orderId: "sl-active",
      symbol: "NVDA.US",
      status: OrderStatus.VarietiesNotReported,
      remark: "auto-trade:sl:888",
    },
    {
      orderId: "tp-filled",
      symbol: "NVDA.US",
      status: OrderStatus.Filled,
      remark: "auto-trade:tp:888",
    },
  ]);

  assert.deepEqual(result, [
    {
      kind: "orphan",
      orderId: "sl-active",
      symbol: "NVDA.US",
      role: "stop_loss",
      recordId: "888",
    },
  ]);
});

test("collectCleanupActions uses filled history to identify orphaned OCO orders", async () => {
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
  };

  const result = await collectCleanupActions(tradeCtx as never);

  assert.deepEqual(result, [
    {
      kind: "oco",
      orderId: "sl-active",
      symbol: "NVDA.US",
      role: "stop_loss",
      recordId: "888",
    },
  ]);
  assert.equal(historyCalls.length, 2);
  assert.ok(historyCalls.some((call) => call.status.includes(OrderStatus.Filled)));
});

test("collectCompletedBuySignalRecordIdsFromSnapshot only keeps filled SL/TP record ids", () => {
  const recordIds = collectCompletedBuySignalRecordIdsFromSnapshot({
    positionsResp: { channels: [] },
    todayOrders: [
      {
        orderId: "tp-today",
        symbol: "NVDA.US",
        status: OrderStatus.Filled,
        remark: "auto-trade:tp:888",
      },
      {
        orderId: "buy-filled",
        symbol: "NVDA.US",
        status: OrderStatus.Filled,
        remark: "auto-trade:buy:777",
      },
      {
        orderId: "tp-pending",
        symbol: "NVDA.US",
        status: OrderStatus.New,
        remark: "auto-trade:tp:666",
      },
    ],
    historyActiveOrders: [],
    historyFilledOrders: [
      {
        orderId: "sl-history",
        symbol: "AAPL.US",
        status: OrderStatus.Filled,
        remark: "auto-trade:sl:555",
      },
      {
        orderId: "tp-malformed",
        symbol: "AAPL.US",
        status: OrderStatus.Filled,
        remark: "auto-trade:tp:not-a-number",
      },
      {
        orderId: "tp-duplicate",
        symbol: "NVDA.US",
        status: OrderStatus.Filled,
        remark: "auto-trade:tp:888",
      },
    ],
  } as never);

  assert.deepEqual(
    [...recordIds].sort((a, b) => a - b),
    [555, 888],
  );
});

test("executeCleanupActions cancels only the supplied actions", async () => {
  const canceled: string[] = [];

  const tradeCtx = {
    async cancelOrder(orderId: string) {
      canceled.push(orderId);
    },
  };

  await executeCleanupActions(tradeCtx as never, [
    {
      kind: "orphan",
      orderId: "sl-active",
      symbol: "KO.US",
      role: "stop_loss",
      recordId: "301",
    },
    {
      kind: "oco",
      orderId: "tp-active",
      symbol: "NVDA.US",
      role: "take_profit",
      recordId: "888",
    },
  ]);

  assert.deepEqual(canceled, ["sl-active", "tp-active"]);
});

test("formatCleanupAction renders dry-run preview text", () => {
  const text = formatCleanupAction(
    {
      kind: "oco",
      orderId: "sl-active",
      symbol: "NVDA.US",
      role: "stop_loss",
      recordId: "888",
    },
    "dry-run",
  );

  assert.equal(text, "[DRY RUN][OCO] 止盈已成交，将取消止损 sl-active (NVDA.US, record 888)");
});
