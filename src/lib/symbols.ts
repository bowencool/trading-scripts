import type { Instrument } from "./providers/types.js";

/** Convert a DB stock code to a provider-neutral instrument. */
export function toInstrument(code: string): Instrument | null {
  const trimmed = code.trim().toUpperCase();

  if (trimmed.startsWith("HK")) {
    const numPart = trimmed.slice(2);
    if (/^\d{1,5}$/.test(numPart)) {
      return { symbol: numPart.padStart(5, "0"), market: "HK" };
    }
    return null;
  }

  if (/^\d{5}$/.test(trimmed)) {
    return { symbol: trimmed, market: "HK" };
  }

  if (/^[A-Z]+(\.[A-Z]+)?$/.test(trimmed)) {
    return { symbol: trimmed, market: "US" };
  }

  return null;
}

const A_SHARE_RE = /^[036]\d+$/;

/**
 * 检查 DB 代码是否是 A 股 (6 位数字以 0/3/6 开头)
 */
export function isAShare(code: string): boolean {
  return A_SHARE_RE.test(code.trim());
}

/** 判断订单备注是否由自动交易流程生成。 */
export function isAutoTradeRemark(remark: string): boolean {
  return remark.startsWith("auto-trade:");
}

/**
 * 从备注字符串中解析角色
 * "auto-trade:buy:123" → "buy", "auto-trade:sl:123" → "stop_loss" 等等
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

/**
 * 从备注字符串中解析分析记录 ID
 * "auto-trade:sl:123" → "123"
 */
export function parseRemarkRecordId(remark: string): string | null {
  if (!remark.startsWith("auto-trade:")) return null;
  const parts = remark.split(":");
  const recordId = parts[2];
  if (!recordId || !/^\d+$/.test(recordId)) {
    return null;
  }
  return recordId;
}
