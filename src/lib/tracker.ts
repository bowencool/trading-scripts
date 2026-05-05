import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import type { TrackedOrder } from "./types.js";

const TRACKER_FILE = "./submitted_orders.json";

export function loadTrackedOrders(): TrackedOrder[] {
  if (!existsSync(TRACKER_FILE)) return [];
  try {
    const data = readFileSync(TRACKER_FILE, "utf-8");
    return JSON.parse(data) as TrackedOrder[];
  } catch (err) {
    console.error(`Failed to read or parse ${TRACKER_FILE}:`, err);
    throw err;
  }
}

export function trackOrder(order: TrackedOrder): void {
  const orders = loadTrackedOrders();
  orders.push(order);
  saveOrders(orders);
}

export function removeOrder(orderId: string): void {
  const orders = loadTrackedOrders().filter((o) => o.orderId !== orderId);
  saveOrders(orders);
}

function saveOrders(orders: TrackedOrder[]): void {
  // Atomic write: write to temp file first, then rename
  const tmpFile = `${TRACKER_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(orders, null, 2), "utf-8");
  renameSync(tmpFile, TRACKER_FILE);
}

export function getSubmittedRecordIds(): Set<number> {
  const orders = loadTrackedOrders();
  return new Set(orders.filter((o) => o.role === "buy").map((o) => o.signalRecordId));
}

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

/** Remove tracking records older than 2 weeks. Returns the number of pruned records. */
export function pruneExpiredOrders(): number {
  const now = Date.now();
  const orders = loadTrackedOrders();
  const [kept, expired] = partition(orders, (o) => now - new Date(o.submittedAt).getTime() < MAX_AGE_MS);
  if (expired.length > 0) {
    saveOrders(kept);
  }
  return expired.length;
}

function partition<T>(arr: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const a: T[] = [];
  const b: T[] = [];
  for (const item of arr) {
    (predicate(item) ? a : b).push(item);
  }
  return [a, b];
}

/** Link two orders as an OCO pair so that filling one cancels the other. */
export function linkOcoOrders(orderId1: string, orderId2: string): void {
  const orders = loadTrackedOrders();
  let changed = false;
  for (const o of orders) {
    if (o.orderId === orderId1) {
      o.ocoPairOrderId = orderId2;
      changed = true;
    } else if (o.orderId === orderId2) {
      o.ocoPairOrderId = orderId1;
      changed = true;
    }
  }
  if (changed) saveOrders(orders);
}
