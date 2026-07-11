import type { BrokerProviderName, MarketDataProviderName } from "../cli.js";
import type { BrokerAdapter } from "./broker.js";
import {
  initializeLongbridgeProviders,
  type LongbridgeProviderFactory,
} from "./longbridge/factory.js";
import type { MarketDataProvider } from "./market-data.js";

export interface ProviderSelection {
  marketData: MarketDataProviderName;
  broker: BrokerProviderName;
}

export interface ProviderCredentials {
  longbridgeClientId: string;
}

export interface ProviderBundle {
  marketData: MarketDataProvider;
  broker: BrokerAdapter;
}

export interface ProviderFactoryDependencies {
  initializeLongbridge(clientId: string): Promise<LongbridgeProviderFactory>;
}

const DEFAULT_DEPENDENCIES: ProviderFactoryDependencies = {
  initializeLongbridge: initializeLongbridgeProviders,
};

export async function createProviders(
  selection: ProviderSelection,
  credentials: ProviderCredentials,
  dependencies: ProviderFactoryDependencies = DEFAULT_DEPENDENCIES,
): Promise<ProviderBundle> {
  // Initialize each selected vendor once. Market data and trading remain separate interfaces.
  const longbridge = await dependencies.initializeLongbridge(credentials.longbridgeClientId);

  return {
    marketData: selectMarketDataProvider(selection.marketData, longbridge),
    broker: selectBrokerAdapter(selection.broker, longbridge),
  };
}

function selectMarketDataProvider(
  provider: MarketDataProviderName,
  longbridge: LongbridgeProviderFactory,
): MarketDataProvider {
  switch (provider) {
    case "longbridge":
      return longbridge.createMarketDataProvider();
  }
}

function selectBrokerAdapter(
  provider: BrokerProviderName,
  longbridge: LongbridgeProviderFactory,
): BrokerAdapter {
  switch (provider) {
    case "longbridge":
      return longbridge.createBrokerAdapter();
  }
}
