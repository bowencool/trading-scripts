## Provider / Broker 架构约束

- 行情源与交易券商是两个独立选择：业务层分别依赖 `MarketDataProvider` 与 `BrokerAdapter`，不得假定两者来自同一供应商。
- 业务层只使用 provider-neutral 的领域类型，不得直接导入券商 SDK、Context、Decimal、供应商枚举或供应商响应类型。
- 券商 SDK 调用、symbol/状态/订单类型映射、认证细节和供应商特有限制必须留在对应 Provider 的实现边界；通用代码注释也不得描述某家供应商的调用步骤。
- Provider 选择逐项遵循 `CLI > env > error`：`--market-data` 覆盖 `MARKET_DATA_PROVIDER`，`--broker` 覆盖 `BROKER_PROVIDER`，且校验必须早于认证与连接。
- Longbridge 认证环境变量为 `LONGBRIDGE_CLIENT_ID`。
- Longbridge 的保护模式是 `reconciled-orders`，不是实时或服务端原生 OCO；一张保护单成交后，另一张在下次脚本启动时清理。

## 数据源

表：analysis_history（分析结果历史记录），该表来自其他项目，为只读表；本项目不修改其结构，也不执行数据迁移。

当前交易信号契约：

1. 唯一信号来源是 `raw_result` JSON 顶层的 `action` 字段；解析时去除首尾空白并转为小写。
2. `buy`/`add` 归买入侧，`reduce`/`sell` 归卖出侧，`hold`/`watch`/`avoid`/`alert` 归中性不交易。
3. `raw_result` 缺失、JSON 非法、顶层 `action` 缺失、非字符串或不属于上述八态时，该记录产生零信号，不从其他字段推断。
4. 每只股票以窗口内最新报告为准；其 action 中性或无效时，不回退到更早记录。报告仍保留在近期记录中，并可提供 SL/TP 恢复价格。
5. 所有买入侧信号都必须有 `ideal_buy`；缺失时跳过买入信号。卖出侧信号不要求 `take_profit`。
6. 外部表缺少 `raw_result` 列时仍可只读打开，但所有记录均产生零信号；本项目不会为其补列或迁移。

id (Integer, PK, autoincrement)
主键，自增的记录 ID，用于精确定位一条历史记录（在批量分析时推荐用此字段保证唯一性）。

query_id (String(64), index)
关联查询/任务的唯一标识（可能在批量请求中重复）。用于把一次请求产生的多条记录关联在一起；API 中常以 query_id 查询最新记录或一组记录。

code (String(10), nullable=False, index)
股票代码（例如 "600519"、"HK01810"、"AAPL"）。用于按股票筛选历史记录。

name (String(50))
股票名称（例如 "贵州茅台"），可选，用于展示/查阅。

report_type (String(16), index)
报告/分析类型（字符串），例如不同分析引擎或模式（agent/simple/whatever），用于区分报告来源或风格。

sentiment_score (Integer)
综合情绪/评分，代码里是 0-100 的整数，仅用于展示，不参与交易信号归类。

analysis_summary (Text)
综合分析的摘要文本（例如 100 字的总结），适合在列表或卡片中展示的简短结论。

raw_result (Text)
原始分析结果的 JSON 字符串（由 _build_raw_result 序列化）。通常包含更完整的结构化内容（dashboard、各模块详情、raw_response、data_sources 等），用于调试或前端构建完整报告。顶层 `action` 是交易脚本唯一信号来源，支持 `buy`、`add`、`reduce`、`sell`、`hold`、`watch`、`avoid`、`alert` 八态。

news_content (Text)
与该次分析相关联的新闻/消息内容（简单字符串或汇总），不是完整的 news_intel 表行，而是本次分析所提取到的新闻摘要或合并文本。

context_snapshot (Text)
保存的上下文快照（JSON 字符串），例如当次用于分析的行情/基本面片段、market_snapshot 等。保存时可以选择关闭（save_snapshot 参数），用于回溯/解释。

ideal_buy (Float)
“狙击点位”——首选买入价（浮点）。从分析结果的 battle_plan/sniper_points 等位置提取并经过解析（见 _parse_sniper_value，能处理 "18.50元"、"18.5-19.0"、带括号文本等）。`action=buy/add` 的买入侧信号都要求该字段非空。

secondary_buy (Float)
次级买点（浮点），与 ideal_buy 一样用于回测/模拟执行。

stop_loss (Float)
止损价（浮点），用于回测/风控逻辑。

take_profit (Float)
止盈价（浮点），用于回测/风控逻辑。

created_at (DateTime, default=datetime.now, index)
记录创建时间（保存时写入当前时间），按此字段可做时间范围查询、分页和排序。

## 注意事项

- 所有 Provider API 调用必须保持顺序执行，不做并发优化；供应商的具体限流细节留在对应实现层
