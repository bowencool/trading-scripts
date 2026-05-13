import assert from "node:assert/strict";
import test from "node:test";
import { buildPortfolioStateFromSnapshot } from "./portfolio.js";

function makeSnapshot() {
  return {
    positionsResp: {
      channels: [
        {
          positions: [
            {
              symbol: "AAPL.US",
              quantity: { toString: () => "100" },
              availableQuantity: { toString: () => "100" },
              costPrice: { toString: () => "98" },
            },
          ],
        },
      ],
    },
    todayOrders: [],
    historyOrdersResp: [],
  };
}

test("buildPortfolioStateFromSnapshot leaves cross-day uncovered holdings alone by default", () => {
  const portfolio = buildPortfolioStateFromSnapshot(makeSnapshot() as never);

  assert.deepEqual(portfolio.orphanWarnings, []);
});

test("buildPortfolioStateFromSnapshot flags cross-day uncovered holdings in strict mode", () => {
  const portfolio = buildPortfolioStateFromSnapshot(makeSnapshot() as never, true);

  assert.deepEqual(portfolio.orphanWarnings, ["AAPL.US"]);
});
