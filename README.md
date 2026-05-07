# trading-scripts

基于 [Longbridge OpenAPI](https://open.longbridge.com) 的自动交易脚本，读取 [daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) 生成的分析报告并自动执行买卖下单。



## 功能

- 从 SQLite 数据库读取分析报告（含情绪评分、操作建议、买卖价格）
- 自动过滤 A 股，仅处理港股和美股标的
- **智能取价**：优先使用盘口深度（卖一/买一），其次盘前/盘后/夜盘价格，最后 `lastDone`
- 买入信号：以阈值最高价（目标价 × (1 + 阈值%)）提交限价单 (LO)，10 秒超时未成交则跳过
- 卖出信号：以阈值最低价（目标价 × (1 - 阈值%)）提交限价单 (LO)，支持全仓卖出和按比例减仓
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
┌─── 买入信号 ────────────────────────────────────────────┐
│ 智能取价（卖一 > 盘前/盘后/夜盘 > lastDone）             │
│ 检查价格阈值 → 计算数量（尊重手数）                      │
│ 展示计划 → 人工确认（--auto-approve 跳过）               │
│ 以阈值最高价提交 LO → 10s 超时未成交则跳过               │
│ 成交后 → 提交 MIT 止损 + LIT 止盈 → OCO 绑定            │
└─────────────────────────────────────────────────────────┘
┌─── 卖出信号 ────────────────────────────────────────────┐
│ 查询持仓 → 计算卖出数量（全仓 / 减仓比例）              │
│ 智能取价（买一 > 盘前/盘后/夜盘 > lastDone）             │
│ 展示计划 → 人工确认（--auto-approve 跳过）               │
│ 以阈值最低价提交 LO → 30s 超时未成交则跳过               │
└─────────────────────────────────────────────────────────┘
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

复制 `.env.example` 为 `.env` 并根据其内置说明填写你的配置。

### 3. 交易

``` bash
pnpm trade # 人工确认模式
pnpm trade --auto-approve # 全自动模式
pnpm trade --dry-run # 试运行（不连接交易所）
```

首次运行 `pnpm trade` 时，会打开浏览器完成 Longbridge OAuth 授权（**提示**：可以使用模拟账户完成授权和测试，无需真实资金）。Token 缓存在 `~/.longbridge/openapi/tokens/<client_id>`。

## Docker

```bash
# 拉取最新镜像
docker pull ghcr.io/bowencool/trading-scripts:latest

# 自动交易（人工确认模式）
docker run --rm \
  -e CLIENT_ID=your-client-id \
  -e DB_PATH=/app/db/stock_analysis.db \
  -v /path/to/stock_analysis.db:/app/db/stock_analysis.db:ro \
  -v $(pwd)/data:/app/data \
  -v ~/.longbridge:/root/.longbridge \
  ghcr.io/bowencool/trading-scripts trade

# 自动交易（全自动模式）
docker run --rm \
  -e CLIENT_ID=your-client-id \
  -e DB_PATH=/app/db/stock_analysis.db \
  -v /path/to/stock_analysis.db:/app/db/stock_analysis.db:ro \
  -v $(pwd)/data:/app/data \
  -v ~/.longbridge:/root/.longbridge \
  ghcr.io/bowencool/trading-scripts trade --auto-approve

# 试运行（不连接交易所）
docker run --rm \
  -e DB_PATH=/app/db/stock_analysis.db \
  -v /path/to/stock_analysis.db:/app/db/stock_analysis.db:ro \
  -v $(pwd)/data:/app/data \
  ghcr.io/bowencool/trading-scripts trade --dry-run

```

**挂载说明**

| 容器路径            | 说明                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/app/db/`          | 包含 [daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis)项目的 `stock_analysis.db`（只读） |
| `/app/data`         | 包含此项目的数据文件                                                                                             |
| `/root/.longbridge` | OAuth token 缓存（首次授权后可复用）                                                                             |

> **提示**：`DB_PATH` 与数据目录无关，指向你实际的 `stock_analysis.db` 即可。示例中用 `/app/db/` 只是约定，实际可挂载到任意路径。

> **注意**：镜像体积较大（~700MB），主要由 [Longbridge SDK](https://github.com/longportapp/openapi-sdk) 的平台原生绑定（arm64/x64）、Node.js 运行时及 tsx（TypeScript 执行环境）共同构成。

## ⚠️ 免责声明

**本项目仅供学习和研究用途，不构成任何投资建议。**

使用本脚本所产生的一切投资行为及其结果，由使用者本人自行承担全部责任。作者不对因使用本项目而导致的任何直接或间接的经济损失、资金损失或其他任何形式的损害承担责任。

本脚本可能存在未知的 Bug、逻辑缺陷或不可预见的情况，均可能导致意外的交易行为。**在使用前，请充分了解风险，并在模拟账户中进行充分测试。** 请勿将本项目用于超出自身风险承受能力的交易场景。

投资有风险，入市需谨慎。
