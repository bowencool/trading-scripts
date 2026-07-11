import assert from "node:assert/strict";
import test from "node:test";
import { LongbridgeMarketDataProvider } from "./market-data.js";
import { fromLongbridgeSymbol, toLongbridgeSymbol } from "./symbols.js";

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

test("maps provider-neutral instruments to and from Longbridge symbols", () => {
  assert.equal(toLongbridgeSymbol({ symbol: "aapl", market: "US" }), "AAPL.US");
  assert.equal(toLongbridgeSymbol({ symbol: "700", market: "HK" }), "00700.HK");
  assert.equal(toLongbridgeSymbol({ symbol: "600519", market: "CN" }), "600519.SH");
  assert.equal(toLongbridgeSymbol({ symbol: "300750", market: "CN" }), "300750.SZ");
  assert.deepEqual(fromLongbridgeSymbol("BRK.B.US"), { symbol: "BRK.B", market: "US" });
  assert.deepEqual(fromLongbridgeSymbol("00700.HK"), { symbol: "00700", market: "HK" });
});

test("rejects already suffixed and ambiguous CN symbols", () => {
  assert.throws(
    () => toLongbridgeSymbol({ symbol: "AAPL.US", market: "US" }),
    /must not contain a market suffix/,
  );
  assert.throws(
    () => toLongbridgeSymbol({ symbol: "900001", market: "CN" }),
    /Cannot determine the Longbridge exchange/,
  );
});

test("maps quotes including extended trading sessions", async () => {
  const timestamp = new Date("2026-07-11T12:00:00Z");
  const preTimestamp = new Date("2026-07-11T08:00:00Z");
  const quoteContext = {
    quote: async (symbols: string[]) => {
      assert.deepEqual(symbols, ["AAPL.US"]);
      return [
        {
          symbol: "AAPL.US",
          lastDone: decimal("211.25"),
          preMarketQuote: { lastDone: decimal("210.5"), timestamp: preTimestamp },
          postMarketQuote: null,
          overnightQuote: { lastDone: decimal("209.75"), timestamp },
          timestamp,
        },
      ];
    },
  };
  const provider = new LongbridgeMarketDataProvider(quoteContext as never);

  assert.deepEqual(await provider.getQuotes([{ symbol: "AAPL", market: "US" }]), [
    {
      instrument: { symbol: "AAPL", market: "US" },
      lastPrice: 211.25,
      preMarket: { price: 210.5, timestamp: preTimestamp },
      postMarket: undefined,
      overnight: { price: 209.75, timestamp },
      timestamp,
    },
  ]);
});

test("maps order book levels and ignores missing or invalid prices", async () => {
  const quoteContext = {
    depth: async (symbol: string) => {
      assert.equal(symbol, "AAPL.US");
      return {
        bids: [
          { price: decimal("211.1"), volume: 20 },
          { price: null, volume: 30 },
        ],
        asks: [
          { price: decimal("211.2"), volume: 10 },
          { price: decimal("0"), volume: 50 },
        ],
      };
    },
  };
  const provider = new LongbridgeMarketDataProvider(quoteContext as never);

  assert.deepEqual(await provider.getOrderBook({ symbol: "AAPL", market: "US" }), {
    instrument: { symbol: "AAPL", market: "US" },
    bids: [{ price: 211.1, quantity: 20 }],
    asks: [{ price: 211.2, quantity: 10 }],
  });
});

test("maps instrument lot sizes and avoids SDK calls for empty batches", async () => {
  let calls = 0;
  const quoteContext = {
    quote: async () => {
      calls += 1;
      return [];
    },
    staticInfo: async (symbols: string[]) => {
      calls += 1;
      assert.deepEqual(symbols, ["00700.HK"]);
      return [{ symbol: "00700.HK", lotSize: 100 }];
    },
  };
  const provider = new LongbridgeMarketDataProvider(quoteContext as never);

  assert.deepEqual(await provider.getQuotes([]), []);
  assert.deepEqual(await provider.getInstrumentInfo([]), []);
  assert.equal(calls, 0);
  assert.deepEqual(await provider.getInstrumentInfo([{ symbol: "00700", market: "HK" }]), [
    { instrument: { symbol: "00700", market: "HK" }, lotSize: 100 },
  ]);
  assert.equal(calls, 1);
});
