import assert from "node:assert/strict";
import test from "node:test";
import { parseRemarkRecordId, toInstrument } from "./symbols.js";

test("toInstrument normalizes supported DB stock codes without broker suffixes", () => {
  assert.deepEqual(toInstrument("aapl"), { symbol: "AAPL", market: "US" });
  assert.deepEqual(toInstrument("brk.b"), { symbol: "BRK.B", market: "US" });
  assert.deepEqual(toInstrument("HK1810"), { symbol: "01810", market: "HK" });
  assert.deepEqual(toInstrument("00700"), { symbol: "00700", market: "HK" });
  assert.equal(toInstrument("600519"), null);
});

test("parseRemarkRecordId extracts the analysis record id from remark", () => {
  assert.equal(parseRemarkRecordId("auto-trade:tp:123"), "123");
  assert.equal(parseRemarkRecordId("auto-trade:sl:456"), "456");
});

test("parseRemarkRecordId rejects malformed remarks", () => {
  assert.equal(parseRemarkRecordId("auto-trade:tp:not-a-number"), null);
  assert.equal(parseRemarkRecordId("auto-trade:tp"), null);
  assert.equal(parseRemarkRecordId("manual-order"), null);
});
