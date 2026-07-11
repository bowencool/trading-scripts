import { parseArgs } from "node:util";

const MARKET_DATA_PROVIDERS = ["longbridge"] as const;
const BROKER_PROVIDERS = ["longbridge"] as const;
const CLI_OPTIONS = {
  "market-data": { type: "string" },
  broker: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  "auto-approve": { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} as const;

export type MarketDataProviderName = (typeof MARKET_DATA_PROVIDERS)[number];
export type BrokerProviderName = (typeof BROKER_PROVIDERS)[number];

export interface TradeCliOptions {
  marketData: MarketDataProviderName;
  broker: BrokerProviderName;
  dryRun: boolean;
  autoApprove: boolean;
}

export type TradeCliParseResult =
  | { kind: "run"; options: TradeCliOptions }
  | { kind: "help"; usage: string }
  | { kind: "error"; message: string; usage: string };

export const TRADE_CLI_USAGE = `Usage:
  pnpm trade --market-data <provider> --broker <provider> [options]

Required:
  --market-data <provider>  Market data provider (${MARKET_DATA_PROVIDERS.join(", ")})
  --broker <provider>       Broker provider (${BROKER_PROVIDERS.join(", ")})

Options:
  --dry-run                 Show the trade plan without placing orders
  --auto-approve             Skip interactive confirmations
  --help                    Show this help message`;

function isMarketDataProvider(value: string): value is MarketDataProviderName {
  return MARKET_DATA_PROVIDERS.some((provider) => provider === value);
}

function isBrokerProvider(value: string): value is BrokerProviderName {
  return BROKER_PROVIDERS.some((provider) => provider === value);
}

function parseError(message: string): TradeCliParseResult {
  return { kind: "error", message, usage: TRADE_CLI_USAGE };
}

/** Parse CLI arguments without creating providers or performing any I/O. */
export function parseTradeCliArgs(argv: string[]): TradeCliParseResult {
  let values: {
    "market-data"?: string;
    broker?: string;
    "dry-run": boolean;
    "auto-approve": boolean;
    help: boolean;
  };

  try {
    ({ values } = parseArgs({
      args: argv,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return parseError(error instanceof Error ? error.message : String(error));
  }

  if (values.help) {
    return { kind: "help", usage: TRADE_CLI_USAGE };
  }

  const marketData = values["market-data"];
  if (!marketData) {
    return parseError("Missing required option: --market-data");
  }
  if (!isMarketDataProvider(marketData)) {
    return parseError(`Unknown market data provider: ${marketData}`);
  }

  const broker = values.broker;
  if (!broker) {
    return parseError("Missing required option: --broker");
  }
  if (!isBrokerProvider(broker)) {
    return parseError(`Unknown broker provider: ${broker}`);
  }

  return {
    kind: "run",
    options: {
      marketData,
      broker,
      dryRun: values["dry-run"],
      autoApprove: values["auto-approve"],
    },
  };
}
