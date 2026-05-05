import { TradeContext } from "longbridge";
import { buildConfig } from "./lib/auth.js";
import { cleanupOrphanedOrders, cleanupOcoOrders, pruneExpiredOrders } from "./lib/cleanup.js";

async function main(): Promise<void> {
  const clientId = process.env.CLIENT_ID;
  if (!clientId) {
    console.error("错误: 请在 .env 中设置 CLIENT_ID");
    process.exit(1);
  }

  console.log("🔐 正在连接 Longbridge...");
  const config = await buildConfig(clientId);
  const tradeCtx = TradeContext.new(config);

  await cleanupOrphanedOrders(tradeCtx);
  await cleanupOcoOrders(tradeCtx);

  const pruned = pruneExpiredOrders();
  if (pruned > 0) {
    console.log(`🗑️  已清理 ${pruned} 条超过 2 周的过期订单记录`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
