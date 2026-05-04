import https from "node:https";

interface KlineData {
  time: number;
  open: number;
  high: number;
  close: number;
  low: number;
  volume: number;
}

/**
 * Fetch recent klines (candlesticks) from Binance public API.
 * No API key required for public market data.
 */
function fetchKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<KlineData[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = "";
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          try {
            // Each element: [openTime, open, high, low, close, volume, ...]
            const rows: unknown[][] = JSON.parse(raw);
            resolve(
              rows.map((r) => ({
                time: r[0] as number,
                open: parseFloat(r[1] as string),
                high: parseFloat(r[2] as string),
                low: parseFloat(r[3] as string),
                close: parseFloat(r[4] as string),
                volume: parseFloat(r[5] as string),
              }))
            );
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Compute the Simple Moving Average of closing prices.
 */
function sma(klines: KlineData[], period: number): number {
  const closes = klines.slice(-period).map((k) => k.close);
  return closes.reduce((a, b) => a + b, 0) / closes.length;
}

/**
 * A minimal example: fetch BTC/USDT daily candles and print the last price
 * along with the 7-day and 25-day SMAs.
 */
async function main(): Promise<void> {
  const symbol = "BTCUSDT";
  const interval = "1d";
  const limit = 30;

  console.log(`Fetching ${limit} ${interval} klines for ${symbol}…`);
  const klines = await fetchKlines(symbol, interval, limit);

  const latest = klines[klines.length - 1];
  const date = new Date(latest.time).toISOString().slice(0, 10);
  const sma7 = sma(klines, 7);
  const sma25 = sma(klines, 25);

  console.log(`Date        : ${date}`);
  console.log(`Close price : ${latest.close.toFixed(2)} USDT`);
  console.log(`SMA  7      : ${sma7.toFixed(2)} USDT`);
  console.log(`SMA 25      : ${sma25.toFixed(2)} USDT`);

  if (sma7 > sma25) {
    console.log("Signal      : 📈 Bullish (SMA7 > SMA25)");
  } else if (sma7 < sma25) {
    console.log("Signal      : 📉 Bearish (SMA7 < SMA25)");
  } else {
    console.log("Signal      : ➡️  Neutral");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
