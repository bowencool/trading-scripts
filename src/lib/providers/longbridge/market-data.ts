import type { QuoteContext } from "longbridge";
import type { MarketDataProvider } from "../market-data.js";
import type {
  Instrument,
  InstrumentInfo,
  MarketQuote,
  OrderBook,
  OrderBookLevel,
  SessionPrice,
} from "../types.js";
import { fromLongbridgeSymbol, toLongbridgeSymbol } from "./symbols.js";

type LongbridgeQuoteClient = Pick<QuoteContext, "depth" | "quote" | "staticInfo">;

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
  constructor(private readonly quoteContext: LongbridgeQuoteClient) {}

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
