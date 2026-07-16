# trading-scripts

行情源与交易券商相互独立的自动交易脚本，读取 [daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis) 生成的分析报告并自动执行买卖下单。当前行情 Provider 与 Broker Adapter 均由 [Longbridge OpenAPI](https://open.longbridge.com) 实现。



## 功能

- 从只读 SQLite 数据库读取分析报告，以 `raw_result` 顶层 `action` 作为唯一交易信号来源
- **实时持仓对比**：通过 Broker Adapter 获取持仓和活跃订单，与信号做对比，无需本地状态文件
- 自动过滤 A 股，仅处理港股和美股标的
- **智能取价**：通过 MarketDataProvider 获取盘口和分时段报价，优先使用卖一/买一，其次盘前/盘后价格，最后使用最新价
- 买入信号：以阈值最高价（目标价 × (1 + 阈值%)）提交限价单 (LO)，10 秒超时未成交则跳过
- 买入数量：先按 `BUY_PCT` 限制可用购买力，再按 `RISK_PCT_PER_TRADE` 和止损价限制单笔最大风险
- 组合约束：支持 `MAX_POSITION_PCT` 单标的上限和 `MAX_HOLDINGS` 最大持仓标的数
- 卖出信号：以买一价提交限价单 (LO)，支持全仓卖出和按比例减仓；卖出前取消 SL/TP，失败时自动回滚
- **启动前 SL/TP 预检查**：开盘前先检查持仓的止损止盈单，自动合并重复挂单并按最新信号价格同步
- SL/TP 自动同步：持仓数量或信号价格变化时自动调整挂单
- SL/TP 自动补挂：持仓但无止损止盈时，从 24h 内信号（或最近记录）中恢复
- 严格保护单检查：开启 `STRICT_SLTP_CHECK=true` 后，跨日持仓缺少可见 SL/TP 也会进入补挂检查
- 孤儿订单清理：自动撤销无父订单的 SL/TP，并在下次脚本启动时清理已成交保护单的另一单
- 支持人工确认和全自动 (`--auto-approve`) 两种模式

> Longbridge 当前使用 `reconciled-orders` 保护模式：SL/TP 是两张独立订单，不是券商服务端的实时 OCO。其中一张成交后，另一张要等下一次脚本启动时才会被清理；两次运行之间存在两张订单先后成交的风险。

## 交易流程

```mermaid
flowchart TD
  Config["Config<br/>CLI / env"] --> Factory["ProviderFactory"]
  Factory --> Market["MarketDataProvider<br/>盘口 / 分时段报价 / 最新价"]
  Factory --> Broker["BrokerAdapter<br/>账户 / 持仓 / 订单"]
  DB["analysis_history （只读 DB）"] --> Signals["queryAll()<br/>raw_result.action 八态<br/>buy / add / reduce / sell<br/>hold / watch / avoid / alert"]
  Market --> Execute
  Broker --> Snapshot["provider-neutral snapshot<br/>持仓 / 活跃订单 / 已成交 SL/TP"]

  Signals --> SlTpRecord["querySlTpRecord()<br/>持仓保护单价格"]
  Snapshot --> Cleanup["reconcile protection orders<br/>collect completed record ids"]
  Snapshot --> Portfolio["buildPortfolioState()<br/>STRICT_SLTP_CHECK 可将跨日裸仓纳入恢复检查"]
  SlTpRecord --> Preflight["buildPreflightPlan()<br/>取消冲突挂单 / 合并重复 SL/TP / 同步或补挂 SL/TP"]
  Cleanup --> Preflight
  Portfolio --> Preflight

  Preflight --> ActionPlan["buildActionPlan()<br/>持仓 vs 信号<br/>MAX_HOLDINGS 限制新开仓"]
  ActionPlan --> Execute["executeAction()<br/>顺序执行；致命错误终止，非致命跳过继续"]

  Execute --> Buy["NEW_BUY / ADD_POSITION<br/>智能取价<br/>BUY_PCT + RISK_PCT_PER_TRADE + MAX_POSITION_PCT 计算数量<br/>限价买入 / 加仓<br/>成交后挂单或同步 SL/TP"]
  Execute --> Sell["SELL_FULL / SELL_PARTIAL<br/>取消 SL/TP<br/>限价卖出<br/>未全成时回滚剩余 SL/TP"]
  Execute --> Maintenance["SYNC / RECOVER / MERGE / UPDATE / CANCEL<br/>同步、补挂、合并、改价或撤单"]
```

**信号 action**

| `raw_result.action` | 信号归类 | 交易含义 |
| --- | --- | --- |
| `buy` | 买入侧 | 无持仓时新建买入；已有持仓时不自动加仓 |
| `add` | 买入侧 | 已持仓时加仓；无持仓时按新建买入处理 |
| `reduce` | 卖出侧 | 按 `SELL_PCT` 部分减仓 |
| `sell` | 卖出侧 | 全仓卖出 |
| `hold` | 中性 | 不执行买卖 |
| `watch` | 中性 | 不执行买卖 |
| `avoid` | 中性 | 不执行买卖 |
| `alert` | 中性 | 不执行买卖 |

**执行 Action 类型**

| Action | 条件 | 行为 |
| --- | --- | --- |
| `NEW_BUY` | 不持仓 + `action=buy/add` + `ideal_buy` 有效 + 无 pending 买单 | 限价买入，成交后自动挂 SL/TP |
| `ADD_POSITION` | 已持仓 + `action=add` + `ideal_buy` 有效 + 无 pending 买单 | 限价加仓，成交后将 SL/TP 同步到新总持仓 |
| `UPDATE_BUY` | 有 pending 买单 + 信号价格不一致 | `replaceOrder` 同步 |
| `SELL_FULL` | 持仓 + `action=sell` | 取消 SL/TP → 限价卖出（挂买一） |
| `SELL_PARTIAL` | 持仓 + `action=reduce` | 取消 SL/TP → 限价卖 sellPct%（挂买一） |
| `SYNC_SL_TP` | 持仓 + SL/TP 数量或价格 ≠ 信号 | `replaceOrder` 调整数量和/或价格 |
| `RECOVER_SL_TP` | 持仓 + 无 SL/TP + 信号有止损止盈 | 补挂 MIT + LIT |
| `MERGE_SL_TP` | 持仓 + 同侧有多张止损/止盈挂单 | 先撤重复单，再按最新信号重挂一对 |
| `HOLD` | 持仓 + SL/TP 已匹配 | 不操作 |

`action` 会先去除首尾空白并转为小写。缺失、非字符串、未知值或非法 `raw_result` JSON 均不产生交易信号；不会从其他字段推断，也不会回退到同一股票更早的报告。中性或无效 action 的报告仍可用于持仓 SL/TP 价格恢复。

## 快速开始

### 1. 配置当前 Longbridge 实现

在 Longbridge 注册 OAuth Client：

```bash
curl -X POST https://openapi.longbridge.com/oauth2/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Trading Scripts",
    "redirect_uris": ["http://localhost:60355/callback"],
    "grant_types": ["authorization_code", "refresh_token"]
  }'
```

保存返回的 `client_id`，并在 `.env` 中配置为 `LONGBRIDGE_CLIENT_ID`。

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并根据其内置说明填写你的配置。

### 3. 交易

``` bash
pnpm trade # 人工确认模式，使用 .env 中的 Provider
pnpm trade --auto-approve # 全自动模式
pnpm trade --dry-run # 试运行（连接交易所，展示“启动前预检查 + 交易行动计划”，不实际下单）
```

`MARKET_DATA_PROVIDER` 与 `BROKER_PROVIDER` 分别选择行情 Provider 和交易券商 Adapter，两者相互独立且都必须通过环境变量或 CLI 提供。CLI 优先级更高，可逐项覆盖环境变量：

```bash
pnpm trade --market-data longbridge --broker longbridge
```

当前两项可用值均只有 `longbridge`，行情和交易配置相互独立。

首次使用当前 Longbridge Provider 运行时，会打开浏览器完成 OAuth 授权（**提示**：可以使用模拟账户完成授权和测试，无需真实资金）。Token 缓存在 `~/.longbridge/openapi/tokens/<client_id>`。

## Docker

```bash
# 拉取最新镜像
docker pull ghcr.io/bowencool/trading-scripts:latest

# 自动交易（人工确认模式）
docker run --rm \
  -e LONGBRIDGE_CLIENT_ID=your-client-id \
  -e MARKET_DATA_PROVIDER=longbridge \
  -e BROKER_PROVIDER=longbridge \
  -v /path/to/stock_analysis.db:/app/db/stock_analysis.db:ro \
  -v ~/.longbridge:/root/.longbridge \
  ghcr.io/bowencool/trading-scripts trade

# 自动交易（全自动模式）
docker run --rm \
  -e LONGBRIDGE_CLIENT_ID=your-client-id \
  -e MARKET_DATA_PROVIDER=longbridge \
  -e BROKER_PROVIDER=longbridge \
  -v /path/to/stock_analysis.db:/app/db/stock_analysis.db:ro \
  -v ~/.longbridge:/root/.longbridge \
  ghcr.io/bowencool/trading-scripts trade --auto-approve

# 试运行（连接交易所，展示“启动前预检查 + 交易行动计划”，不实际下单）
docker run --rm \
  -e LONGBRIDGE_CLIENT_ID=your-client-id \
  -e MARKET_DATA_PROVIDER=longbridge \
  -e BROKER_PROVIDER=longbridge \
  -v /path/to/stock_analysis.db:/app/db/stock_analysis.db:ro \
  -v ~/.longbridge:/root/.longbridge \
  ghcr.io/bowencool/trading-scripts trade --dry-run

```

**挂载说明**

| 容器路径            | 说明                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/app/db/stock_analysis.db` | 容器内固定数据库路径；将宿主机上的 `stock_analysis.db` 只读挂载到这里 |
| `/root/.longbridge` | OAuth token 缓存（首次授权后可复用）                                                                             |

> **提示**：Docker 镜像内已固定 `DB_PATH=/app/db/stock_analysis.db`，不需要额外传 `DB_PATH` 环境变量；如需更换数据库文件，请调整宿主机挂载源路径，容器目标路径保持不变。

> 镜像默认将两个 Provider 设为 `longbridge`。可以通过 `-e` 修改环境变量，也可以在 `trade` 后传 `--market-data` / `--broker` 逐项覆盖。

> **注意**：镜像体积较大（~700MB），主要由 [Longbridge SDK](https://github.com/longportapp/openapi-sdk) 的平台原生绑定（arm64/x64）、Node.js 运行时及 tsx（TypeScript 执行环境）共同构成。

## ⚠️ 免责声明

**本项目仅供学习和研究用途，不构成任何投资建议。**

使用本脚本所产生的一切投资行为及其结果，由使用者本人自行承担全部责任。作者不对因使用本项目而导致的任何直接或间接的经济损失、资金损失或其他任何形式的损害承担责任。

本脚本可能存在未知的 Bug、逻辑缺陷或不可预见的情况，均可能导致意外的交易行为。**在使用前，请充分了解风险，并在模拟账户中进行充分测试。** 请勿将本项目用于超出自身风险承受能力的交易场景。

投资有风险，入市需谨慎。
