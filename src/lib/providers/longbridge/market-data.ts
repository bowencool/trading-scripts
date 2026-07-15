import { Market, NaiveDate, type QuoteContext, TradeStatus } from "longbridge";
import type { MarketDataProvider } from "../market-data.js";
import type {
  Instrument,
  InstrumentInfo,
  MarketQuote,
  OrderBook,
  OrderBookLevel,
  SessionPrice,
  TradingStatus,
} from "../types.js";
import { fromLongbridgeSymbol, toLongbridgeSymbol } from "./symbols.js";

type LongbridgeQuoteClient = Pick<
  QuoteContext,
  "depth" | "quote" | "staticInfo" | "tradingDays" | "tradingSession"
>;

const MARKET_TIME_ZONES: Record<Instrument["market"], string> = {
  US: "America/New_York",
  HK: "Asia/Hong_Kong",
  CN: "Asia/Shanghai",
  SG: "Asia/Singapore",
};

function decimalToNumber(value: { toString(): string } | null | undefined): number {
  if (value == null) return 0;
  const number = Number(value.toString());
  return Number.isFinite(number) ? number : 0;
}

function mapSessionPrice(
  quote: { lastDone: { toString(): string }; timestamp: Date } | null,
): SessionPrice | undefined {
  if (!quote) return undefined;
  return {
    price: decimalToNumber(quote.lastDone),
    timestamp: quote.timestamp,
  };
}

function mapDepthLevels(
  levels: Array<{ price: { toString(): string } | null; volume: number }>,
): OrderBookLevel[] {
  return levels.flatMap((level) => {
    const price = decimalToNumber(level.price);
    if (price <= 0) return [];
    return [{ price, quantity: level.volume }];
  });
}

export class LongbridgeMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly quoteContext: LongbridgeQuoteClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getTradingStatus(instrument: Instrument): Promise<TradingStatus> {
    const market = toLongbridgeMarket(instrument.market);
    const local = getMarketLocalDateTime(this.now(), MARKET_TIME_ZONES[instrument.market]);
    const date = new NaiveDate(local.year, local.month, local.day);

    const calendar = await this.quoteContext.tradingDays(market, date, date);
    const isTradingDay = calendar.tradingDays.some(
      (day) => day.year === local.year && day.month === local.month && day.day === local.day,
    );
    if (!isTradingDay) return { isTrading: false, reason: "non-trading-day" };

    const marketSessions = await this.quoteContext.tradingSession();
    const sessions =
      marketSessions.find((session) => session.market === market)?.tradeSessions ?? [];
    const currentSecond = local.hour * 3600 + local.minute * 60 + local.second;
    const isInsideSession = sessions.some((session) => {
      const begin = session.beginTime.hour * 3600 + session.beginTime.minute * 60;
      const end = session.endTime.hour * 3600 + session.endTime.minute * 60;
      return begin <= end
        ? currentSecond >= begin && currentSecond < end
        : currentSecond >= begin || currentSecond < end;
    });
    if (!isInsideSession) return { isTrading: false, reason: "outside-trading-session" };

    const [quote] = await this.quoteContext.quote([toLongbridgeSymbol(instrument)]);
    if (!quote || quote.tradeStatus !== TradeStatus.Normal) {
      return { isTrading: false, reason: "instrument-unavailable" };
    }
    return { isTrading: true, reason: "trading" };
  }

  async getQuotes(instruments: Instrument[]): Promise<MarketQuote[]> {
    if (instruments.length === 0) return [];

    const quotes = await this.quoteContext.quote(instruments.map(toLongbridgeSymbol));
    return quotes.map((quote) => ({
      instrument: fromLongbridgeSymbol(quote.symbol),
      lastPrice: decimalToNumber(quote.lastDone),
      preMarket: mapSessionPrice(quote.preMarketQuote),
      postMarket: mapSessionPrice(quote.postMarketQuote),
      overnight: mapSessionPrice(quote.overnightQuote),
      timestamp: quote.timestamp,
    }));
  }

  async getOrderBook(instrument: Instrument): Promise<OrderBook> {
    const depth = await this.quoteContext.depth(toLongbridgeSymbol(instrument));
    return {
      instrument,
      bids: mapDepthLevels(depth.bids),
      asks: mapDepthLevels(depth.asks),
    };
  }

  async getInstrumentInfo(instruments: Instrument[]): Promise<InstrumentInfo[]> {
    if (instruments.length === 0) return [];

    const staticInfos = await this.quoteContext.staticInfo(instruments.map(toLongbridgeSymbol));
    return staticInfos.map((info) => ({
      instrument: fromLongbridgeSymbol(info.symbol),
      lotSize: info.lotSize,
    }));
  }
}

function toLongbridgeMarket(market: Instrument["market"]): Market {
  const markets: Record<Instrument["market"], Market> = {
    US: Market.US,
    HK: Market.HK,
    CN: Market.CN,
    SG: Market.SG,
  };
  return markets[market];
}

function getMarketLocalDateTime(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: numberPart("year"),
    month: numberPart("month"),
    day: numberPart("day"),
    hour: numberPart("hour"),
    minute: numberPart("minute"),
    second: numberPart("second"),
  };
}
