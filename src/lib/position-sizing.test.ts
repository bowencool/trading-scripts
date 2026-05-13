import assert from "node:assert/strict";
import test from "node:test";
import { calculateBuyQuantity } from "./position-sizing.js";

test("calculateBuyQuantity caps quantity by risk budget when stop loss is valid", () => {
  const result = calculateBuyQuantity({
    buyPower: 10_000,
    netAssets: 20_000,
    buyPct: 50,
    riskPctPerTrade: 1,
    entryPrice: 100,
    stopLoss: 95,
    lotSize: 1,
  });

  assert.equal(result.mode, "risk_budget");
  assert.equal(result.cashCapQuantity, 50);
  assert.equal(result.riskCapQuantity, 40);
  assert.equal(result.quantity, 40);
});

test("calculateBuyQuantity falls back to cash percentage without a valid stop loss", () => {
  const result = calculateBuyQuantity({
    buyPower: 10_000,
    netAssets: 20_000,
    buyPct: 15,
    riskPctPerTrade: 1,
    entryPrice: 100,
    stopLoss: null,
    lotSize: 10,
  });

  assert.equal(result.mode, "cash_pct");
  assert.equal(result.quantity, 10);
});
