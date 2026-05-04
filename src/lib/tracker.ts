import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { TrackedOrder } from "./types.js";

const TRACKER_FILE = "./submitted_orders.json";

export function loadTrackedOrders(): TrackedOrder[] {
  if (!existsSync(TRACKER_FILE)) return [];
  try {
    const data = readFileSync(TRACKER_FILE, "utf-8");
    return JSON.parse(data) as TrackedOrder[];
  } catch {
    return [];
  }
}

export function trackOrder(order: TrackedOrder): void {
  const orders = loadTrackedOrders();
  orders.push(order);
  writeFileSync(TRACKER_FILE, JSON.stringify(orders, null, 2), "utf-8");
}

export function getSubmittedRecordIds(): Set<number> {
  const orders = loadTrackedOrders();
  return new Set(orders.filter((o) => o.role === "buy").map((o) => o.signalRecordId));
}
