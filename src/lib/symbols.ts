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
