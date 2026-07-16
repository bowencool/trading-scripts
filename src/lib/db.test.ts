import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryAll, queryRecordById, querySlTpRecord } from "./db.js";

interface TestRecord {
  id: number;
  code: string;
  name: string | null;
  report_type: string | null;
  sentiment_score: number | null;
  analysis_summary: string | null;
  raw_result: string | null;
  ideal_buy: number | null;
  secondary_buy: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  created_at: string;
}

function withTempDb(
  fn: (dbPath: string, db: DatabaseSync) => void,
  options: { rawResultColumn?: boolean } = {},
): void {
  const dir = mkdtempSync(join(tmpdir(), "trading-scripts-db-"));
  const dbPath = join(dir, "stock_analysis.db");
  const db = new DatabaseSync(dbPath);
  const rawResultColumn = options.rawResultColumn === false ? "" : "raw_result TEXT,";

  try {
    db.exec(`
      CREATE TABLE analysis_history (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT,
        report_type TEXT,
        sentiment_score INTEGER,
        analysis_summary TEXT,
        ${rawResultColumn}
        ideal_buy REAL,
        secondary_buy REAL,
        stop_loss REAL,
        take_profit REAL,
        created_at TEXT NOT NULL
      )
    `);
    fn(dbPath, db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertRecord(
  db: DatabaseSync,
  overrides: Partial<TestRecord> = {},
  options: { rawResultColumn?: boolean } = {},
): void {
  const record: TestRecord = {
    id: 1,
    code: "AAPL",
    name: "Apple",
    report_type: "agent",
    sentiment_score: 65,
    analysis_summary: null,
    raw_result: null,
    ideal_buy: 100,
    secondary_buy: null,
    stop_loss: 95,
    take_profit: 110,
    created_at: new Date().toISOString(),
    ...overrides,
  };

  if (options.rawResultColumn === false) {
    db.prepare(`
      INSERT INTO analysis_history (
        id, code, name, report_type, sentiment_score, analysis_summary,
        ideal_buy, secondary_buy, stop_loss, take_profit, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.code,
      record.name,
      record.report_type,
      record.sentiment_score,
      record.analysis_summary,
      record.ideal_buy,
      record.secondary_buy,
      record.stop_loss,
      record.take_profit,
      record.created_at,
    );
    return;
  }

  db.prepare(`
    INSERT INTO analysis_history (
      id, code, name, report_type, sentiment_score, analysis_summary,
      raw_result, ideal_buy, secondary_buy, stop_loss, take_profit, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.code,
    record.name,
    record.report_type,
    record.sentiment_score,
    record.analysis_summary,
    record.raw_result,
    record.ideal_buy,
    record.secondary_buy,
    record.stop_loss,
    record.take_profit,
    record.created_at,
  );
}

const ACTION_CASES = [
  { action: "buy", side: "buy" },
  { action: "add", side: "buy" },
  { action: "reduce", side: "sell" },
  { action: "sell", side: "sell" },
  { action: "hold", side: "neutral" },
  { action: "watch", side: "neutral" },
  { action: "avoid", side: "neutral" },
  { action: "alert", side: "neutral" },
] as const;

for (const { action, side } of ACTION_CASES) {
  test(`queryAll classifies action ${action} as ${side}`, () => {
    withTempDb((dbPath, db) => {
      insertRecord(db, { raw_result: JSON.stringify({ action }) });

      const result = queryAll(dbPath);

      assert.equal(result.buySignals.length, side === "buy" ? 1 : 0);
      assert.equal(result.sellSignals.length, side === "sell" ? 1 : 0);
      assert.equal(result.recentReports.length, 1);
      assert.equal(result.recentReports[0]?.action, action);
    });
  });
}

test("queryAll normalizes action whitespace and casing", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, { raw_result: JSON.stringify({ action: "  BuY\n" }) });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 1);
    assert.equal(result.buySignals[0]?.action, "buy");
  });
});

for (const { label, rawResult } of [
  { label: "missing action", rawResult: JSON.stringify({}) },
  { label: "invalid JSON", rawResult: "not json" },
  { label: "non-string action", rawResult: JSON.stringify({ action: 1 }) },
  { label: "unknown action", rawResult: JSON.stringify({ action: "strong_buy" }) },
  { label: "nested action", rawResult: JSON.stringify({ result: { action: "buy" } }) },
]) {
  test(`queryAll produces no signal for ${label}`, () => {
    withTempDb((dbPath, db) => {
      insertRecord(db, { raw_result: rawResult });

      const result = queryAll(dbPath);

      assert.equal(result.buySignals.length, 0);
      assert.equal(result.sellSignals.length, 0);
      assert.equal(result.recentReports.length, 1);
      assert.equal(result.recentReports[0]?.action, null);
    });
  });
}

test("queryAll requires ideal_buy for buy and add actions", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      id: 1,
      code: "AAPL",
      raw_result: JSON.stringify({ action: "buy" }),
      ideal_buy: null,
    });
    insertRecord(db, {
      id: 2,
      code: "MSFT",
      raw_result: JSON.stringify({ action: "add" }),
      ideal_buy: null,
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 0);
    assert.equal(result.sellSignals.length, 0);
    assert.equal(result.recentReports.length, 2);
  });
});

test("queryAll does not require take_profit for reduce and sell actions", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      id: 1,
      code: "AAPL",
      raw_result: JSON.stringify({ action: "reduce" }),
      take_profit: null,
    });
    insertRecord(db, {
      id: 2,
      code: "MSFT",
      raw_result: JSON.stringify({ action: "sell" }),
      take_profit: null,
    });

    const result = queryAll(dbPath);

    assert.deepEqual(result.sellSignals.map((record) => record.action).sort(), ["reduce", "sell"]);
  });
});

test("queryAll does not fall back when the latest action is invalid", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      id: 1,
      raw_result: JSON.stringify({ action: "buy" }),
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    insertRecord(db, {
      id: 2,
      raw_result: "not json",
      created_at: new Date().toISOString(),
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 0);
    assert.equal(result.sellSignals.length, 0);
    assert.equal(result.recentReports.length, 1);
    assert.equal(result.recentReports[0]?.id, 2);
    assert.equal(result.recentReports[0]?.action, null);
  });
});

test("queries databases without raw_result as action-less reports", () => {
  withTempDb(
    (dbPath, db) => {
      insertRecord(db, {}, { rawResultColumn: false });

      const result = queryAll(dbPath);
      const record = queryRecordById(dbPath, 1);

      assert.equal(result.buySignals.length, 0);
      assert.equal(result.sellSignals.length, 0);
      assert.equal(result.recentReports.length, 1);
      assert.equal(result.recentReports[0]?.raw_result, null);
      assert.equal(result.recentReports[0]?.action, null);
      assert.equal(record?.action, null);
    },
    { rawResultColumn: false },
  );
});

test("querySlTpRecord returns prices independently of action validity", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      raw_result: "not json",
      stop_loss: 90,
      take_profit: 120,
    });

    const record = querySlTpRecord(dbPath, "AAPL");

    assert.equal(record?.action, null);
    assert.equal(record?.stop_loss, 90);
    assert.equal(record?.take_profit, 120);
  });
});
