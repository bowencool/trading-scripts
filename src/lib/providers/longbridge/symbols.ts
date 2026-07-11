import type { Instrument } from "../types.js";

const LONGBRIDGE_MARKET_SUFFIXES = new Set(["US", "HK", "SH", "SZ", "SG"]);

function normalizedBaseSymbol(instrument: Instrument): string {
  const symbol = instrument.symbol.trim().toUpperCase();
  const suffix = symbol.split(".").at(-1);
  if (!symbol || (suffix && LONGBRIDGE_MARKET_SUFFIXES.has(suffix))) {
    throw new Error(`Instrument symbol must not contain a market suffix: ${instrument.symbol}`);
  }
  return symbol;
}

/** Convert a provider-neutral instrument into Longbridge's suffixed symbol format. */
export function toLongbridgeSymbol(instrument: Instrument): string {
  const symbol = normalizedBaseSymbol(instrument);

  switch (instrument.market) {
    case "US":
      return `${symbol}.US`;
    case "HK": {
      const hkSymbol = /^\d{1,5}$/.test(symbol) ? symbol.padStart(5, "0") : symbol;
      return `${hkSymbol}.HK`;
    }
    case "CN":
      if (/^6\d{5}$/.test(symbol)) return `${symbol}.SH`;
      if (/^[03]\d{5}$/.test(symbol)) return `${symbol}.SZ`;
      throw new Error(`Cannot determine the Longbridge exchange for CN symbol: ${symbol}`);
    case "SG":
      return `${symbol}.SG`;
  }
}

/** Convert a Longbridge suffixed symbol into a provider-neutral instrument. */
export function fromLongbridgeSymbol(symbol: string): Instrument {
  const normalized = symbol.trim().toUpperCase();
  const separator = normalized.lastIndexOf(".");
  if (separator <= 0) {
    throw new Error(`Invalid Longbridge symbol: ${symbol}`);
  }

  const baseSymbol = normalized.slice(0, separator);
  const suffix = normalized.slice(separator + 1);
  switch (suffix) {
    case "US":
      return { symbol: baseSymbol, market: "US" };
    case "HK":
      return { symbol: baseSymbol, market: "HK" };
    case "SH":
    case "SZ":
      return { symbol: baseSymbol, market: "CN" };
    case "SG":
      return { symbol: baseSymbol, market: "SG" };
    default:
      throw new Error(`Unsupported Longbridge market suffix: ${suffix}`);
  }
}
