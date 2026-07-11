import assert from "node:assert/strict";
import test from "node:test";
import { parseTradeCliArgs, TRADE_CLI_USAGE } from "./cli.js";

test("parseTradeCliArgs accepts required providers separated by spaces", () => {
  assert.deepEqual(parseTradeCliArgs(["--market-data", "longbridge", "--broker", "longbridge"]), {
    kind: "run",
    options: {
      marketData: "longbridge",
      broker: "longbridge",
      dryRun: false,
      autoApprove: false,
    },
  });
});

test("parseTradeCliArgs accepts equals syntax and existing boolean flags", () => {
  assert.deepEqual(
    parseTradeCliArgs([
      "--market-data=longbridge",
      "--broker=longbridge",
      "--dry-run",
      "--auto-approve",
    ]),
    {
      kind: "run",
      options: {
        marketData: "longbridge",
        broker: "longbridge",
        dryRun: true,
        autoApprove: true,
      },
    },
  );
});

test("parseTradeCliArgs returns help without requiring providers", () => {
  assert.deepEqual(parseTradeCliArgs(["--help"]), { kind: "help", usage: TRADE_CLI_USAGE });
});

test("parseTradeCliArgs returns help before validating invalid environment values", () => {
  assert.deepEqual(
    parseTradeCliArgs(["--help"], {
      MARKET_DATA_PROVIDER: "invalid-market-data",
      BROKER_PROVIDER: "invalid-broker",
    }),
    { kind: "help", usage: TRADE_CLI_USAGE },
  );
});

test("parseTradeCliArgs falls back to environment providers", () => {
  assert.deepEqual(
    parseTradeCliArgs([], {
      MARKET_DATA_PROVIDER: "longbridge",
      BROKER_PROVIDER: "longbridge",
    }),
    {
      kind: "run",
      options: {
        marketData: "longbridge",
        broker: "longbridge",
        dryRun: false,
        autoApprove: false,
      },
    },
  );
});

test("parseTradeCliArgs resolves each provider independently", () => {
  assert.equal(
    parseTradeCliArgs(["--market-data", "longbridge"], {
      BROKER_PROVIDER: "longbridge",
    }).kind,
    "run",
  );
  assert.equal(
    parseTradeCliArgs(["--broker", "longbridge"], {
      MARKET_DATA_PROVIDER: "longbridge",
    }).kind,
    "run",
  );
});

test("parseTradeCliArgs does not validate environment values overridden by CLI", () => {
  const result = parseTradeCliArgs(["--market-data", "longbridge", "--broker", "longbridge"], {
    MARKET_DATA_PROVIDER: "invalid-market-data",
    BROKER_PROVIDER: "invalid-broker",
  });
  assert.equal(result.kind, "run");
});

test("parseTradeCliArgs reports each missing required provider", () => {
  const missingMarketData = parseTradeCliArgs(["--broker", "longbridge"]);
  assert.equal(missingMarketData.kind, "error");
  if (missingMarketData.kind === "error") {
    assert.match(missingMarketData.message, /--market-data.*MARKET_DATA_PROVIDER/);
    assert.equal(missingMarketData.usage, TRADE_CLI_USAGE);
  }

  const missingBroker = parseTradeCliArgs(["--market-data", "longbridge"]);
  assert.equal(missingBroker.kind, "error");
  if (missingBroker.kind === "error") {
    assert.match(missingBroker.message, /--broker.*BROKER_PROVIDER/);
    assert.equal(missingBroker.usage, TRADE_CLI_USAGE);
  }
});

test("parseTradeCliArgs rejects unknown provider names", () => {
  const unknownMarketData = parseTradeCliArgs([
    "--market-data",
    "schwab",
    "--broker",
    "longbridge",
  ]);
  assert.equal(unknownMarketData.kind, "error");
  if (unknownMarketData.kind === "error") {
    assert.match(
      unknownMarketData.message,
      /Unknown market data provider from --market-data: schwab/,
    );
  }

  const unknownBroker = parseTradeCliArgs(["--market-data", "longbridge", "--broker", "schwab"]);
  assert.equal(unknownBroker.kind, "error");
  if (unknownBroker.kind === "error") {
    assert.match(unknownBroker.message, /Unknown broker provider from --broker: schwab/);
  }
});

test("parseTradeCliArgs rejects unknown provider names from environment", () => {
  const unknownMarketData = parseTradeCliArgs([], {
    MARKET_DATA_PROVIDER: "schwab",
    BROKER_PROVIDER: "longbridge",
  });
  assert.equal(unknownMarketData.kind, "error");
  if (unknownMarketData.kind === "error") {
    assert.match(
      unknownMarketData.message,
      /Unknown market data provider from MARKET_DATA_PROVIDER: schwab/,
    );
  }

  const unknownBroker = parseTradeCliArgs([], {
    MARKET_DATA_PROVIDER: "longbridge",
    BROKER_PROVIDER: "schwab",
  });
  assert.equal(unknownBroker.kind, "error");
  if (unknownBroker.kind === "error") {
    assert.match(unknownBroker.message, /Unknown broker provider from BROKER_PROVIDER: schwab/);
  }
});

test("parseTradeCliArgs converts parse failures into error results", () => {
  const unknownOption = parseTradeCliArgs([
    "--market-data",
    "longbridge",
    "--broker",
    "longbridge",
    "--wat",
  ]);
  assert.equal(unknownOption.kind, "error");

  const positional = parseTradeCliArgs([
    "--market-data",
    "longbridge",
    "--broker",
    "longbridge",
    "unexpected",
  ]);
  assert.equal(positional.kind, "error");
});
