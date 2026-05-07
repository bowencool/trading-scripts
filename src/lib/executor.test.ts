import assert from "node:assert/strict";
import test from "node:test";
import { getRemainingPositionQuantity } from "./executor.js";

test("getRemainingPositionQuantity returns zero when position is fully sold", () => {
  assert.equal(getRemainingPositionQuantity(100, 100), 0);
});

test("getRemainingPositionQuantity keeps the unsold remainder protected", () => {
  assert.equal(getRemainingPositionQuantity(100, 40), 60);
});

test("getRemainingPositionQuantity never returns a negative position", () => {
  assert.equal(getRemainingPositionQuantity(100, 120), 0);
});
