import assert from "node:assert/strict";
import test from "node:test";
import { calculateBuyQuantity } from "./position-sizing.js";

test("calculateBuyQuantity caps quantity by risk budget when stop loss is valid", () => {
  const result = calculateBuyQuantity({
    buyPower: 10_000,
    netAssets: 20_000,
    buyPct: 50,
    riskPctPerTrade: 1,
    maxPositionPct: 0,
    existingPositionValue: 0,
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
    maxPositionPct: 0,
    existingPositionValue: 0,
    entryPrice: 100,
    stopLoss: null,
    lotSize: 10,
  });

  assert.equal(result.mode, "cash_pct");
  assert.equal(result.quantity, 10);
});

test("calculateBuyQuantity caps add-on quantity by max position exposure", () => {
  const result = calculateBuyQuantity({
    buyPower: 50_000,
    netAssets: 100_000,
    buyPct: 50,
    riskPctPerTrade: 0,
    maxPositionPct: 20,
    existingPositionValue: 18_000,
    entryPrice: 100,
    stopLoss: null,
    lotSize: 10,
  });

  assert.equal(result.positionCapValue, 20_000);
  assert.equal(result.positionCapQuantity, 20);
  assert.equal(result.quantity, 20);
});
