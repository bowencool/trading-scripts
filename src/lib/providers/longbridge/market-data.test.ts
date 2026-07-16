import assert from "node:assert/strict";
import test from "node:test";
import { Market, TradeSession, TradeStatus } from "longbridge";
import { LongbridgeMarketDataProvider } from "./market-data.js";
import { fromLongbridgeSymbol, toLongbridgeSymbol } from "./symbols.js";

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

function time(hour: number, minute: number) {
  return { hour, minute };
}

function tradingDay(year: number, month: number, day: number) {
  return { year, month, day };
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

test("maps quotes including pre/post trading sessions", async () => {
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

test("reports a weekend without querying security status", async () => {
  const calls: string[] = [];
  const quoteContext = {
    tradingDays: async (
      market: Market,
      begin: { toString(): string },
      end: { toString(): string },
    ) => {
      calls.push("trading-days");
      assert.equal(market, Market.HK);
      assert.equal(begin.toString(), "2026-07-18");
      assert.equal(end.toString(), "2026-07-18");
      return { tradingDays: [] };
    },
    tradingSession: async () => {
      calls.push("trading-session");
      return [
        {
          market: Market.HK,
          tradeSessions: [
            {
              beginTime: time(9, 30),
              endTime: time(16, 0),
              tradeSession: TradeSession.Intraday,
            },
          ],
        },
      ];
    },
    quote: async () => {
      calls.push("quote");
      return [];
    },
  };
  const provider = new LongbridgeMarketDataProvider(
    quoteContext as never,
    () => new Date("2026-07-18T02:00:00Z"),
  );

  assert.deepEqual(await provider.getTradingStatus({ symbol: "00700", market: "HK" }), {
    isTrading: false,
    reason: "non-trading-day",
  });
  assert.deepEqual(calls, ["trading-days"]);
});

test("reports Hong Kong lunch break and after-hours as outside trading sessions", async () => {
  const makeProvider = (now: string) =>
    new LongbridgeMarketDataProvider(
      {
        tradingDays: async () => ({ tradingDays: [tradingDay(2026, 7, 15)] }),
        tradingSession: async () => [
          {
            market: Market.HK,
            tradeSessions: [
              {
                beginTime: time(9, 30),
                endTime: time(12, 0),
                tradeSession: TradeSession.Intraday,
              },
              {
                beginTime: time(13, 0),
                endTime: time(16, 0),
                tradeSession: TradeSession.Intraday,
              },
            ],
          },
        ],
        quote: async () => {
          throw new Error("outside sessions must not query a quote");
        },
      } as never,
      () => new Date(now),
    );

  assert.deepEqual(
    await makeProvider("2026-07-15T04:30:00Z").getTradingStatus({
      symbol: "00700",
      market: "HK",
    }),
    { isTrading: false, reason: "outside-trading-session" },
  );
  assert.deepEqual(
    await makeProvider("2026-07-15T09:00:00Z").getTradingStatus({
      symbol: "00700",
      market: "HK",
    }),
    { isTrading: false, reason: "outside-trading-session" },
  );
});

test("reports an open session only when the security is tradable", async () => {
  const calls: string[] = [];
  const quoteContext = {
    tradingDays: async () => {
      calls.push("trading-days");
      return { tradingDays: [tradingDay(2026, 7, 15)] };
    },
    tradingSession: async () => {
      calls.push("trading-session");
      return [
        {
          market: Market.HK,
          tradeSessions: [
            {
              beginTime: time(9, 30),
              endTime: time(12, 0),
              tradeSession: TradeSession.Intraday,
            },
          ],
        },
      ];
    },
    quote: async (symbols: string[]) => {
      calls.push("quote");
      assert.deepEqual(symbols, ["00700.HK"]);
      return [{ tradeStatus: TradeStatus.Normal }];
    },
  };
  const provider = new LongbridgeMarketDataProvider(
    quoteContext as never,
    () => new Date("2026-07-15T02:00:00Z"),
  );

  assert.deepEqual(await provider.getTradingStatus({ symbol: "00700", market: "HK" }), {
    isTrading: true,
    reason: "trading",
    session: "regular",
  });
  assert.deepEqual(calls, ["trading-days", "trading-session", "quote"]);
});

test("treats half trading days as tradable during regular and pre-market sessions", async () => {
  for (const scenario of [
    {
      now: "2026-11-27T15:00:00Z",
      begin: time(9, 30),
      end: time(13, 0),
      longbridgeSession: TradeSession.Intraday,
      expectedSession: "regular",
    },
    {
      now: "2026-11-27T13:00:00Z",
      begin: time(4, 0),
      end: time(9, 30),
      longbridgeSession: TradeSession.Pre,
      expectedSession: "pre",
    },
  ] as const) {
    const provider = new LongbridgeMarketDataProvider(
      {
        tradingDays: async () => ({
          tradingDays: [],
          halfTradingDays: [tradingDay(2026, 11, 27)],
        }),
        tradingSession: async () => [
          {
            market: Market.US,
            tradeSessions: [
              {
                beginTime: scenario.begin,
                endTime: scenario.end,
                tradeSession: scenario.longbridgeSession,
              },
            ],
          },
        ],
        quote: async () => [{ tradeStatus: TradeStatus.Normal }],
      } as never,
      () => new Date(scenario.now),
    );

    assert.deepEqual(await provider.getTradingStatus({ symbol: "AAPL", market: "US" }), {
      isTrading: true,
      reason: "trading",
      session: scenario.expectedSession,
    });
  }
});

test("derives the New York market date and time from an absolute Date", async () => {
  const provider = new LongbridgeMarketDataProvider(
    {
      tradingDays: async (
        _market: Market,
        begin: { year: number; month: number; day: number },
        end: { year: number; month: number; day: number },
      ) => {
        assert.deepEqual([begin.year, begin.month, begin.day], [2026, 7, 15]);
        assert.deepEqual([end.year, end.month, end.day], [2026, 7, 15]);
        return { tradingDays: [tradingDay(2026, 7, 15)] };
      },
      tradingSession: async () => [
        {
          market: Market.US,
          tradeSessions: [
            {
              beginTime: time(16, 0),
              endTime: time(20, 0),
              tradeSession: TradeSession.Post,
            },
          ],
        },
      ],
      quote: async () => [{ tradeStatus: TradeStatus.Normal }],
    } as never,
    // The absolute instant is July 16 in Asia/Shanghai but July 15 19:00 in New York.
    () => new Date("2026-07-15T23:00:00Z"),
  );

  assert.deepEqual(await provider.getTradingStatus({ symbol: "AAPL", market: "US" }), {
    isTrading: true,
    reason: "trading",
    session: "post",
  });
});

test("maps Longbridge pre-market and post-market sessions to provider-neutral sessions", async () => {
  for (const scenario of [
    { now: "2026-07-15T12:00:00Z", expected: "pre" },
    { now: "2026-07-15T21:00:00Z", expected: "post" },
  ] as const) {
    const provider = new LongbridgeMarketDataProvider(
      {
        tradingDays: async () => ({
          tradingDays: [tradingDay(2026, 7, 15), tradingDay(2026, 7, 16)],
        }),
        tradingSession: async () => [
          {
            market: Market.US,
            tradeSessions: [
              {
                beginTime: time(4, 0),
                endTime: time(9, 30),
                tradeSession: TradeSession.Pre,
              },
              {
                beginTime: time(16, 0),
                endTime: time(20, 0),
                tradeSession: TradeSession.Post,
              },
            ],
          },
        ],
        quote: async () => [{ tradeStatus: TradeStatus.Normal }],
      } as never,
      () => new Date(scenario.now),
    );

    assert.deepEqual(await provider.getTradingStatus({ symbol: "AAPL", market: "US" }), {
      isTrading: true,
      reason: "trading",
      session: scenario.expected,
    });
  }
});

test("fails closed for unknown Longbridge sessions", async () => {
  let quoteCalls = 0;
  const provider = new LongbridgeMarketDataProvider(
    {
      tradingDays: async () => ({ tradingDays: [tradingDay(2026, 7, 15)] }),
      tradingSession: async () => [
        {
          market: Market.US,
          tradeSessions: [
            {
              beginTime: time(9, 30),
              endTime: time(16, 0),
              tradeSession: 99 as TradeSession,
            },
          ],
        },
      ],
      quote: async () => {
        quoteCalls += 1;
        return [{ tradeStatus: TradeStatus.Normal }];
      },
    } as never,
    () => new Date("2026-07-15T14:00:00Z"),
  );

  assert.deepEqual(await provider.getTradingStatus({ symbol: "AAPL", market: "US" }), {
    isTrading: false,
    reason: "outside-trading-session",
  });
  assert.equal(quoteCalls, 0);
});
