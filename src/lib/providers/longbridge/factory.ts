import { QuoteContext } from "longbridge";
import { buildConfig } from "../../auth.js";
import type { BrokerAdapter } from "../broker.js";
import type { MarketDataProvider } from "../market-data.js";
import { LongbridgeBrokerAdapter } from "./broker.js";
import { LongbridgeMarketDataProvider } from "./market-data.js";

export interface LongbridgeProviderFactory {
  createMarketDataProvider(): MarketDataProvider;
  createBrokerAdapter(): BrokerAdapter;
}

/** Authenticate once, then create independent Longbridge market-data and broker providers. */
export async function initializeLongbridgeProviders(
  clientId: string,
): Promise<LongbridgeProviderFactory> {
  const config = await buildConfig(clientId);

  return {
    createMarketDataProvider: () => new LongbridgeMarketDataProvider(QuoteContext.new(config)),
    createBrokerAdapter: () => new LongbridgeBrokerAdapter(config),
  };
}
