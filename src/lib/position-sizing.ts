export interface BuySizingInput {
  buyPower: number;
  netAssets: number;
  buyPct: number;
  riskPctPerTrade: number;
  maxPositionPct: number;
  existingPositionValue: number;
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
  positionCapValue: number | null;
  positionCapQuantity: number | null;
}

function roundLot(quantity: number, lotSize: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.floor(quantity / lotSize) * lotSize;
}

export function calculateBuyQuantity(input: BuySizingInput): BuySizingResult {
  const cashCapValue = (input.buyPower * input.buyPct) / 100;
  const cashCapQuantity = roundLot(cashCapValue / input.entryPrice, input.lotSize);
  const hasPositionCap = input.maxPositionPct > 0 && input.netAssets > 0;
  const positionCapValue = hasPositionCap ? (input.netAssets * input.maxPositionPct) / 100 : null;
  const remainingPositionValue =
    positionCapValue == null ? null : Math.max(0, positionCapValue - input.existingPositionValue);
  const positionCapQuantity =
    remainingPositionValue == null
      ? null
      : roundLot(remainingPositionValue / input.entryPrice, input.lotSize);
  const stopLoss = input.stopLoss;

  if (
    input.riskPctPerTrade <= 0 ||
    stopLoss == null ||
    input.entryPrice <= stopLoss ||
    input.lotSize <= 0
  ) {
    return {
      quantity: Math.min(cashCapQuantity, positionCapQuantity ?? Number.POSITIVE_INFINITY),
      mode: "cash_pct",
      cashCapValue,
      cashCapQuantity,
      riskBudgetValue: null,
      riskCapQuantity: null,
      riskPerShare: null,
      positionCapValue,
      positionCapQuantity,
    };
  }

  const riskBase = input.netAssets > 0 ? input.netAssets : input.buyPower;
  const riskBudgetValue = (riskBase * input.riskPctPerTrade) / 100;
  const riskPerShare = input.entryPrice - stopLoss;
  const riskCapQuantity = roundLot(riskBudgetValue / riskPerShare, input.lotSize);

  return {
    quantity: Math.min(
      cashCapQuantity,
      riskCapQuantity,
      positionCapQuantity ?? Number.POSITIVE_INFINITY,
    ),
    mode: "risk_budget",
    cashCapValue,
    cashCapQuantity,
    riskBudgetValue,
    riskCapQuantity,
    riskPerShare,
    positionCapValue,
    positionCapQuantity,
  };
}
