# trading-scripts

基于 [Longbridge OpenAPI](https://open.longbridge.com) 的自动交易脚本，读取 [daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) 生成的分析报告并自动执行买卖下单。

## 功能

- 从 SQLite 数据库读取分析报告（含情绪评分、操作建议、买卖价格）
- 自动过滤 A 股，仅处理港股和美股标的
- 买入信号：提交限价单 (LO)，10 秒内未成交自动降级为市价单 (MO)
- 卖出信号：支持全仓卖出和按比例减仓
- 等待买单成交后再提交止损 (MIT) / 止盈 (LIT)，防止幽灵订单
- WebSocket 实时监控 OCO 对，一方成交立即撤销另一方
- 孤儿订单清理，自动撤销无父订单的止损/止盈
- 过期订单记录自动清理（保留最近 2 周）
- 订单追踪，防止重复下单
- 支持人工确认和全自动 (`--auto-approve`) 两种模式

## 交易流程

```
读取分析报告 → 过滤 A 股 → 分离买入/卖出信号 → 转换 Symbol
    ↓
清理过期订单记录（已取消/拒绝/过期）
    ↓
清理孤儿订单 + OCO 残留对
    ↓
注册已有 OCO 对到 WebSocket 监听
    ↓
┌─── 买入信号 ────────────────────────────────┐
│ 查询行情 → 检查价格阈值 → 计算数量（尊重手数） │
│ 展示计划 → 人工确认（--auto-approve 跳过）    │
│ 提交 LO → 等待成交（10s 超时降级为 MO）       │
│ 成交后 → 提交 MIT 止损 + LIT 止盈 → OCO 绑定 │
└──────────────────────────────────────────────┘
┌─── 卖出信号 ────────────────────────────────┐
│ 查询持仓 → 计算卖出数量（全仓 / 减仓比例）   │
│ 展示计划 → 人工确认（--auto-approve 跳过）    │
│ 提交卖出委托                                 │
└──────────────────────────────────────────────┘
    ↓
记录到 submitted_orders.json（防重复）
```

## 快速开始

### 1. 注册 OAuth Client

```bash
curl -X POST https://openapi.longbridge.com/oauth2/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Trading Scripts",
    "redirect_uris": ["http://localhost:60355/callback"],
    "grant_types": ["authorization_code", "refresh_token"]
  }'
```

保存返回的 `client_id`。

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入你的配置。

首次运行 `pnpm trade` 时，会打开浏览器完成 Longbridge OAuth 授权。Token 缓存在 `~/.longbridge/openapi/tokens/<client_id>`。

> **提示**：可以使用模拟账户完成授权和测试，无需真实资金。

## Docker

```bash
# 拉取最新镜像
docker pull ghcr.io/bowencool/trading-scripts:latest

# 自动交易（人工确认模式）
docker run --rm \
  -e CLIENT_ID=your-client-id \
  -e DB_PATH=/app/data/stock_analysis.db \
  -v $(pwd)/data:/app/data \
  -v ~/.longbridge:/root/.longbridge \
  ghcr.io/bowencool/trading-scripts trade

# 自动交易（全自动模式）
docker run --rm \
  -e CLIENT_ID=your-client-id \
  -e DB_PATH=/app/data/stock_analysis.db \
  -v $(pwd)/data:/app/data \
  -v ~/.longbridge:/root/.longbridge \
  ghcr.io/bowencool/trading-scripts trade --auto-approve

# 试运行（不连接交易所）
docker run --rm \
  -e DB_PATH=/app/data/stock_analysis.db \
  -v $(pwd)/data:/app/data \
  ghcr.io/bowencool/trading-scripts trade --dry-run

# 查看报告
docker run --rm \
  -e DB_PATH=/app/data/stock_analysis.db \
  -v $(pwd)/data:/app/data \
  -v ~/.longbridge:/root/.longbridge \
  ghcr.io/bowencool/trading-scripts reports
```

**挂载说明**

| 容器路径            | 说明                                                         |
| ------------------- | ------------------------------------------------------------ |
| `/app/data`         | `stock_analysis.db`（只读）+ `submitted_orders.json`（读写） |
| `/root/.longbridge` | OAuth token 缓存（首次授权后可复用）                         |

> **注意**：镜像体积较大（~700MB），主要由 [Longbridge SDK](https://github.com/longportapp/openapi-sdk) 的平台原生绑定（arm64/x64）、Node.js 运行时及 tsx（TypeScript 执行环境）共同构成。
