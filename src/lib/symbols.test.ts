import assert from "node:assert/strict";
import test from "node:test";
import { parseRemarkRecordId } from "./symbols.js";

test("parseRemarkRecordId extracts the analysis record id from remark", () => {
  assert.equal(parseRemarkRecordId("auto-trade:tp:123"), "123");
  assert.equal(parseRemarkRecordId("auto-trade:sl:456"), "456");
});

test("parseRemarkRecordId rejects malformed remarks", () => {
  assert.equal(parseRemarkRecordId("auto-trade:tp:not-a-number"), null);
  assert.equal(parseRemarkRecordId("auto-trade:tp"), null);
  assert.equal(parseRemarkRecordId("manual-order"), null);
});
