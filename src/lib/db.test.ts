import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryAll } from "./db.js";

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

test("queryAll keeps sell signals even when take_profit is missing", () => {
  withTempDb((dbPath, db) => {
    db.prepare(`
      INSERT INTO analysis_history (
        id, code, name, report_type, sentiment_score, operation_advice,
        trend_prediction, analysis_summary, ideal_buy, secondary_buy,
        stop_loss, take_profit, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(1, "AAPL", "Apple", "agent", 35, "卖出", "看空", null, 100, null, 95, null);

    const result = queryAll(dbPath);

    assert.equal(result.sellSignals.length, 1);
    assert.equal(result.sellSignals[0]?.code, "AAPL");
    assert.equal(result.sellSignals[0]?.take_profit, null);
  });
});
