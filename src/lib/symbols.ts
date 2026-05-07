/**
 * Convert a DB stock code to Longbridge symbol format.
 *
 * Rules (by priority):
 * 1. "HK01810" → "01810.HK" (HK prefix)
 * 2. "00700" (5-digit numeric) → "00700.HK" (HK stock)
 * 3. "AAPL", "BRK.B" (alpha or alpha+dot) → "AAPL.US", "BRK.B.US"
 * 4. Everything else → null (including 6-digit A-share codes)
 */
export function toLongbridgeSymbol(code: string): string | null {
  const trimmed = code.trim().toUpperCase();

  // Rule 1: HK prefix
  if (trimmed.startsWith("HK")) {
    const numPart = trimmed.slice(2);
    if (/^\d{1,5}$/.test(numPart)) {
      return `${numPart.padStart(5, "0")}.HK`;
    }
    return null;
  }

  // Rule 2: 5-digit numeric = HK stock
  if (/^\d{5}$/.test(trimmed)) {
    return `${trimmed}.HK`;
  }

  // Rule 3: Alpha or alpha+dot = US stock
  // Matches "AAPL", "BRK.B", "GOOG", etc.
  if (/^[A-Z]+(\.[A-Z]+)?$/.test(trimmed)) {
    return `${trimmed}.US`;
  }

  // Rule 4: Everything else (6-digit A-shares, unknown formats)
  return null;
}

const A_SHARE_RE = /^[036]\d+$/;

/**
 * Check if a DB code is an A-share (6-digit starting with 0/3/6).
 */
export function isAShare(code: string): boolean {
  return A_SHARE_RE.test(code.trim());
}

/**
 * Reverse: extract symbol from remark like "auto-trade:buy:123" → undefined
 * (remark doesn't contain symbol — this is a placeholder for future use).
 * Mainly used to identify our auto-trade remarks.
 */
export function isAutoTradeRemark(remark: string): boolean {
  return remark.startsWith("auto-trade:");
}

/**
 * Parse role from remark string.
 * "auto-trade:buy:123" → "buy", "auto-trade:sl:123" → "stop_loss", etc.
 */
export function parseRemarkRole(
  remark: string,
): "buy" | "sell" | "stop_loss" | "take_profit" | null {
  if (!remark.startsWith("auto-trade:")) return null;
  const parts = remark.split(":");
  const tag = parts[1];
  if (tag === "buy") return "buy";
  if (tag === "sell" || tag === "reduce") return "sell";
  if (tag === "sl") return "stop_loss";
  if (tag === "tp") return "take_profit";
  return null;
}
