export function computeBuyLimitPrice(targetPrice: number, priceThresholdPct: number): number {
  return Number((targetPrice * (1 + priceThresholdPct / 100)).toFixed(2));
}
