export interface BuySizingInput {
  buyPower: number;
  netAssets: number;
  buyPct: number;
  riskPctPerTrade: number;
  entryPrice: number;
  stopLoss: number | null;
  lotSize: number;
}

export interface BuySizingResult {
  quantity: number;
  mode: "risk_budget" | "cash_pct";
  cashCapValue: number;
  cashCapQuantity: number;
  riskBudgetValue: number | null;
  riskCapQuantity: number | null;
  riskPerShare: number | null;
}

function roundLot(quantity: number, lotSize: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.floor(quantity / lotSize) * lotSize;
}

export function calculateBuyQuantity(input: BuySizingInput): BuySizingResult {
  const cashCapValue = (input.buyPower * input.buyPct) / 100;
  const cashCapQuantity = roundLot(cashCapValue / input.entryPrice, input.lotSize);
  const stopLoss = input.stopLoss;

  if (
    input.riskPctPerTrade <= 0 ||
    stopLoss == null ||
    input.entryPrice <= stopLoss ||
    input.lotSize <= 0
  ) {
    return {
      quantity: cashCapQuantity,
      mode: "cash_pct",
      cashCapValue,
      cashCapQuantity,
      riskBudgetValue: null,
      riskCapQuantity: null,
      riskPerShare: null,
    };
  }

  const riskBase = input.netAssets > 0 ? input.netAssets : input.buyPower;
  const riskBudgetValue = (riskBase * input.riskPctPerTrade) / 100;
  const riskPerShare = input.entryPrice - stopLoss;
  const riskCapQuantity = roundLot(riskBudgetValue / riskPerShare, input.lotSize);

  return {
    quantity: Math.min(cashCapQuantity, riskCapQuantity),
    mode: "risk_budget",
    cashCapValue,
    cashCapQuantity,
    riskBudgetValue,
    riskCapQuantity,
    riskPerShare,
  };
}
