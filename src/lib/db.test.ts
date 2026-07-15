import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryAll } from "./db.js";
import type { AnalysisRecord } from "./types.js";

function withTempDb(fn: (dbPath: string, db: DatabaseSync) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "trading-scripts-db-"));
  const dbPath = join(dir, "stock_analysis.db");
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(`
      CREATE TABLE analysis_history (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT,
        report_type TEXT,
        sentiment_score INTEGER,
        operation_advice TEXT,
        trend_prediction TEXT,
        analysis_summary TEXT,
        raw_result TEXT,
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

function withLegacyTempDb(fn: (dbPath: string, db: DatabaseSync) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "trading-scripts-db-"));
  const dbPath = join(dir, "stock_analysis.db");
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(`
      CREATE TABLE analysis_history (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT,
        report_type TEXT,
        sentiment_score INTEGER,
        operation_advice TEXT,
        trend_prediction TEXT,
        analysis_summary TEXT,
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

function insertRecord(db: DatabaseSync, overrides: Partial<AnalysisRecord> = {}): void {
  const record: AnalysisRecord = {
    id: 1,
    query_id: null,
    code: "AAPL",
    name: "Apple",
    report_type: "agent",
    sentiment_score: 65,
    action: null,
    operation_advice: "观望",
    trend_prediction: "震荡",
    analysis_summary: null,
    raw_result: null,
    news_content: null,
    context_snapshot: null,
    ideal_buy: 100,
    secondary_buy: null,
    stop_loss: 95,
    take_profit: 110,
    created_at: "datetime('now')",
    ...overrides,
  };

  db.prepare(`
    INSERT INTO analysis_history (
      id, code, name, report_type, sentiment_score, operation_advice,
      trend_prediction, analysis_summary, raw_result, ideal_buy, secondary_buy,
      stop_loss, take_profit, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    record.id,
    record.code,
    record.name,
    record.report_type,
    record.sentiment_score,
    record.operation_advice,
    record.trend_prediction,
    record.analysis_summary,
    record.raw_result,
    record.ideal_buy,
    record.secondary_buy,
    record.stop_loss,
    record.take_profit,
  );
}

function insertLegacyRecord(db: DatabaseSync, overrides: Partial<AnalysisRecord> = {}): void {
  const record: AnalysisRecord = {
    id: 1,
    query_id: null,
    code: "AAPL",
    name: "Apple",
    report_type: "agent",
    sentiment_score: 65,
    action: null,
    operation_advice: "观望",
    trend_prediction: "震荡",
    analysis_summary: null,
    raw_result: null,
    news_content: null,
    context_snapshot: null,
    ideal_buy: 100,
    secondary_buy: null,
    stop_loss: 95,
    take_profit: 110,
    created_at: "datetime('now')",
    ...overrides,
  };

  db.prepare(`
    INSERT INTO analysis_history (
      id, code, name, report_type, sentiment_score, operation_advice,
      trend_prediction, analysis_summary, ideal_buy, secondary_buy,
      stop_loss, take_profit, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    record.id,
    record.code,
    record.name,
    record.report_type,
    record.sentiment_score,
    record.operation_advice,
    record.trend_prediction,
    record.analysis_summary,
    record.ideal_buy,
    record.secondary_buy,
    record.stop_loss,
    record.take_profit,
  );
}

test("queryAll keeps sell signals even when take_profit is missing", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      sentiment_score: 35,
      operation_advice: "卖出",
      trend_prediction: "看空",
      take_profit: null,
    });

    const result = queryAll(dbPath);

    assert.equal(result.sellSignals.length, 1);
    assert.equal(result.sellSignals[0]?.code, "AAPL");
    assert.equal(result.sellSignals[0]?.take_profit, null);
    assert.equal(result.sellSignals[0]?.action, "sell");
  });
});

test("queryAll treats bullish trend on hold advice as buy signal", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      operation_advice: "持有",
      trend_prediction: "看多",
      ideal_buy: 100,
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 1);
    assert.equal(result.buySignals[0]?.code, "AAPL");
    assert.equal(result.buySignals[0]?.action, "buy");
    assert.equal(result.sellSignals.length, 0);
  });
});

test("queryAll treats strongly bearish trend on watch advice as sell signal", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      operation_advice: "观望",
      trend_prediction: "强烈看空",
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 0);
    assert.equal(result.sellSignals.length, 1);
    assert.equal(result.sellSignals[0]?.code, "AAPL");
  });
});

test("queryAll skips bullish trend buy signal without ideal buy price", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      operation_advice: "持有",
      trend_prediction: "看多",
      ideal_buy: null,
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 0);
    assert.equal(result.sellSignals.length, 0);
  });
});

test("queryAll keeps explicit operation advice ahead of trend prediction", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      operation_advice: "卖出",
      trend_prediction: "看多",
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 0);
    assert.equal(result.sellSignals.length, 1);
    assert.equal(result.sellSignals[0]?.operation_advice, "卖出");
    assert.equal(result.sellSignals[0]?.action, "sell");
  });
});

test("queryAll uses structured buy action ahead of neutral text", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      operation_advice: "观望",
      trend_prediction: "震荡",
      sentiment_score: 60,
      raw_result: JSON.stringify({ action: "buy" }),
      ideal_buy: 100,
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 1);
    assert.equal(result.buySignals[0]?.code, "AAPL");
    assert.equal(result.buySignals[0]?.action, "buy");
    assert.equal(result.sellSignals.length, 0);
  });
});

test("queryAll preserves structured add action without rewriting display advice", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      operation_advice: "观望",
      trend_prediction: "震荡",
      raw_result: JSON.stringify({ action: "add" }),
      ideal_buy: 100,
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 1);
    assert.equal(result.buySignals[0]?.action, "add");
    assert.equal(result.buySignals[0]?.operation_advice, "观望");
  });
});

test("queryAll preserves structured reduce action without rewriting display advice", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      operation_advice: "观望",
      trend_prediction: "震荡",
      raw_result: JSON.stringify({ action: "reduce" }),
    });

    const result = queryAll(dbPath);

    assert.equal(result.sellSignals.length, 1);
    assert.equal(result.sellSignals[0]?.action, "reduce");
    assert.equal(result.sellSignals[0]?.operation_advice, "观望");
    assert.equal(result.buySignals.length, 0);
  });
});

test("queryAll lets structured watch action override bullish text", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      operation_advice: "持有",
      trend_prediction: "看多",
      sentiment_score: 72,
      raw_result: JSON.stringify({ action: "watch" }),
      ideal_buy: 100,
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 0);
    assert.equal(result.sellSignals.length, 0);
  });
});

test("queryAll falls back to legacy text rules when structured action is invalid", () => {
  withTempDb((dbPath, db) => {
    insertRecord(db, {
      operation_advice: "持有",
      trend_prediction: "看多",
      raw_result: "not json",
      ideal_buy: 100,
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 1);
    assert.equal(result.buySignals[0]?.code, "AAPL");
    assert.equal(result.buySignals[0]?.action, "buy");
  });
});

test("queryAll falls back to legacy text rules when raw_result column is missing", () => {
  withLegacyTempDb((dbPath, db) => {
    insertLegacyRecord(db, {
      operation_advice: "持有",
      trend_prediction: "看多",
      ideal_buy: 100,
    });

    const result = queryAll(dbPath);

    assert.equal(result.buySignals.length, 1);
    assert.equal(result.buySignals[0]?.code, "AAPL");
    assert.equal(result.buySignals[0]?.action, "buy");
    assert.equal(result.buySignals[0]?.raw_result, null);
  });
});
