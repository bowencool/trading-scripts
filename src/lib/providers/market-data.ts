import type { Instrument, InstrumentInfo, MarketQuote, OrderBook } from "./types.js";

export interface MarketDataProvider {
  getQuotes(instruments: Instrument[]): Promise<MarketQuote[]>;
  getOrderBook(instrument: Instrument): Promise<OrderBook>;
  getInstrumentInfo(instruments: Instrument[]): Promise<InstrumentInfo[]>;
}
