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
