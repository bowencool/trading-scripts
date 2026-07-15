import type { Instrument, InstrumentInfo, MarketQuote, OrderBook, TradingStatus } from "./types.js";

export interface MarketDataProvider {
  getTradingStatus(instrument: Instrument): Promise<TradingStatus>;
  getQuotes(instruments: Instrument[]): Promise<MarketQuote[]>;
  getOrderBook(instrument: Instrument): Promise<OrderBook>;
  getInstrumentInfo(instruments: Instrument[]): Promise<InstrumentInfo[]>;
}
