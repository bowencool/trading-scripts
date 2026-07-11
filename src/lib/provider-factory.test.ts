import assert from "node:assert/strict";
import test from "node:test";
import type { BrokerAdapter } from "./providers/broker.js";
import { createProviders } from "./providers/factory.js";
import type { MarketDataProvider } from "./providers/market-data.js";

test("createProviders initializes Longbridge once and creates independent providers", async () => {
  const marketData = {} as MarketDataProvider;
  const broker = {} as BrokerAdapter;
  const initializedClientIds: string[] = [];
  let marketDataCreates = 0;
  let brokerCreates = 0;

  const providers = await createProviders(
    { marketData: "longbridge", broker: "longbridge" },
    { longbridgeClientId: "client-id" },
    {
      initializeLongbridge: async (clientId) => {
        initializedClientIds.push(clientId);
        return {
          createMarketDataProvider: () => {
            marketDataCreates++;
            return marketData;
          },
          createBrokerAdapter: () => {
            brokerCreates++;
            return broker;
          },
        };
      },
    },
  );

  assert.deepEqual(initializedClientIds, ["client-id"]);
  assert.equal(marketDataCreates, 1);
  assert.equal(brokerCreates, 1);
  assert.equal(providers.marketData, marketData);
  assert.equal(providers.broker, broker);
});
