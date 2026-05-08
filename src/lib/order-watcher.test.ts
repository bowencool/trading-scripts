import assert from "node:assert/strict";
import test from "node:test";
import { OrderStatus, type PushOrderChanged, TopicType } from "longbridge";
import { OrderWatcher } from "./order-watcher.js";

test("waitForTerminal resolves immediately when a terminal push arrives before registration", async () => {
  let onOrderChanged: ((err: unknown, event: PushOrderChanged) => void) | undefined;

  const tradeCtx = {
    setOnOrderChanged(callback: (err: unknown, event: PushOrderChanged) => void) {
      onOrderChanged = callback;
    },
    async subscribe(topics: TopicType[]) {
      assert.deepEqual(topics, [TopicType.Private]);
    },
    async unsubscribe(_topics: TopicType[]) {},
    async cancelOrder(_orderId: string) {
      throw new Error("cancel should not be called for cached terminal events");
    },
  };

  const watcher = new OrderWatcher(tradeCtx as never);
  await watcher.start();

  onOrderChanged?.(null, {
    orderId: "ord-1",
    status: OrderStatus.Filled,
  } as PushOrderChanged);

  const event = await watcher.waitForTerminal("ord-1", 100);
  assert.equal(event.status, OrderStatus.Filled);

  await watcher.stop();
});
