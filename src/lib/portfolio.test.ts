import assert from "node:assert/strict";
import test from "node:test";
import type { PortfolioSnapshot } from "./portfolio.js";
import { buildPortfolioStateFromSnapshot } from "./portfolio.js";

function makeSnapshot(): PortfolioSnapshot {
  return {
    positions: [
      {
        instrument: { symbol: "AAPL", market: "US" },
        quantity: 100,
        availableQuantity: 100,
        costPrice: 98,
      },
    ],
    todayOrders: [],
    historyOrders: [],
  };
}

test("buildPortfolioStateFromSnapshot leaves cross-day uncovered holdings alone by default", () => {
  assert.deepEqual(buildPortfolioStateFromSnapshot(makeSnapshot()).orphanWarnings, []);
});

test("buildPortfolioStateFromSnapshot flags cross-day uncovered holdings in strict mode", () => {
  assert.deepEqual(buildPortfolioStateFromSnapshot(makeSnapshot(), true).orphanWarnings, ["AAPL"]);
});

test("buildPortfolioStateFromSnapshot maps provider-neutral orders", () => {
  const snapshot = makeSnapshot();
  snapshot.todayOrders.push({
    id: "buy-1",
    instrument: { symbol: "AAPL", market: "US" },
    side: "buy",
    type: "limit",
    status: "pending",
    quantity: 10,
    executedQuantity: 0,
    price: 100,
    timeInForce: "day",
    outsideRegularHours: true,
    remark: "auto-trade:buy:1",
    role: "buy",
  });
  const portfolio = buildPortfolioStateFromSnapshot(snapshot);
  assert.equal(portfolio.activeOrders[0]?.symbol, "AAPL");
  assert.equal(portfolio.activeOrders[0]?.orderId, "buy-1");
});
