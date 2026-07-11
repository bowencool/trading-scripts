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

export interface TradeCliEnvironment {
  readonly MARKET_DATA_PROVIDER?: string;
  readonly BROKER_PROVIDER?: string;
}

export type TradeCliParseResult =
  | { kind: "run"; options: TradeCliOptions }
  | { kind: "help"; usage: string }
  | { kind: "error"; message: string; usage: string };

export const TRADE_CLI_USAGE = `Usage:
  pnpm trade [--market-data <provider>] [--broker <provider>] [options]

Provider selection (CLI overrides environment):
  --market-data <provider>  Market data provider; fallback: MARKET_DATA_PROVIDER (${MARKET_DATA_PROVIDERS.join(", ")})
  --broker <provider>       Broker provider; fallback: BROKER_PROVIDER (${BROKER_PROVIDERS.join(", ")})

Options:
  --dry-run                 Show the trade plan without placing orders
  --auto-approve            Skip interactive confirmations
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
export function parseTradeCliArgs(
  argv: string[],
  env: TradeCliEnvironment = {},
): TradeCliParseResult {
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

  const marketDataFromCli = values["market-data"];
  const marketData = marketDataFromCli ?? env.MARKET_DATA_PROVIDER?.trim();
  if (marketData == null || marketData === "") {
    return parseError("Missing market data provider: use --market-data or MARKET_DATA_PROVIDER");
  }
  if (!isMarketDataProvider(marketData)) {
    const source = marketDataFromCli == null ? "MARKET_DATA_PROVIDER" : "--market-data";
    return parseError(`Unknown market data provider from ${source}: ${marketData}`);
  }

  const brokerFromCli = values.broker;
  const broker = brokerFromCli ?? env.BROKER_PROVIDER?.trim();
  if (broker == null || broker === "") {
    return parseError("Missing broker provider: use --broker or BROKER_PROVIDER");
  }
  if (!isBrokerProvider(broker)) {
    const source = brokerFromCli == null ? "BROKER_PROVIDER" : "--broker";
    return parseError(`Unknown broker provider from ${source}: ${broker}`);
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
