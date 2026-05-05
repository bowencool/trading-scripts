# trading-scripts

基于 [Longbridge OpenAPI](https://open.longbridge.com) 的自动交易脚本，读取股票分析报告并自动执行买卖下单。

## 功能

- 从 SQLite 数据库读取分析报告（含情绪评分、操作建议、买卖价格）
- 自动过滤 A 股，仅处理港股和美股标的
- 通过 Longbridge SDK 自动提交买入限价单
- 等待买单成交确认后再提交止损/止盈，防止幽灵订单
- 自动设置止损单（MIT）和止盈单（LIT）
- 孤儿订单清理（`pnpm trade:cleanup`），自动取消无父订单的止损/止盈
- OCO 互斥订单实时监控，一方成交自动取消另一方
- 过期订单记录自动清理（保留最近 2 周）
- 订单追踪，防止重复下单
- 支持人工确认和全自动两种模式

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 注册 OAuth Client

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

### 3. 配置环境变量

复制 `.env.example` 或直接编辑 `.env`：

```bash
# 必填：Longbridge OAuth client ID
CLIENT_ID=your-client-id-here

# 选填
DB_PATH=./stock_analysis.db       # SQLite 数据库路径
PRICE_THRESHOLD_PCT=1             # 价格阈值百分比（当前价 <= 目标价 * (1 + N%) 时下单）
POSITION_PCT=10                   # 单个持仓占账户净资产的百分比
```

### 4. 运行

```bash
# 仅查看分析报告
pnpm start

# 查看报告 + 自动交易（需人工确认每笔订单）
pnpm trade

# 全自动模式（跳过确认）
pnpm trade:force

# 清理孤儿订单（取消无父订单的止损/止盈）
pnpm trade:cleanup
```

首次运行 `pnpm trade` 时，会打开浏览器完成 Longbridge OAuth 授权。Token 会缓存在 `~/.longbridge/openapi/tokens/<client_id>`。

## 交易流程

```
读取分析报告 → 过滤 A 股 → 过滤买入信号 → 转换 Symbol
    ↓
查询实时行情 → 检查价格阈值 → 计算下单数量（尊重手数）
    ↓
展示交易计划 + 分析记录 → 人工确认（--force 跳过）
    ↓
提交买入限价单 (LO) → 轮询等待成交确认
    ↓
买单成交后 → 提交止损单 (MIT) → 提交止盈单 (LIT)
    ↓
记录到 submitted_orders.json（防重复）
```

## 项目结构

```
src/
  trade.ts              # 主入口（报告展示 + 自动交易）
  cleanup.ts            # 独立清理入口（孤儿订单 + OCO + 过期记录）
  lib/
    auth.ts             # Longbridge OAuth 认证
    cleanup.ts          # 清理逻辑（孤儿订单、OCO 互斥、过期记录）
    symbols.ts          # DB code → Longbridge symbol 转换
    db.ts               # SQLite 查询
    executor.ts         # 交易执行（查价、确认、下单 + 止损止盈）
    order-watcher.ts    # WebSocket 订单推送监听
    tracker.ts          # 已提交订单追踪
    types.ts            # 共享类型定义
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `CLIENT_ID` | 是 | - | Longbridge OAuth client ID |
| `DB_PATH` | 否 | `./stock_analysis.db` | SQLite 数据库路径 |
| `PRICE_THRESHOLD_PCT` | 否 | `2` | 当前价超出目标价此百分比内仍下单 |
| `POSITION_PCT` | 否 | `20` | 单个持仓占账户净资产的百分比 |

