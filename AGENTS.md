## 数据源

表：analysis_history（分析结果历史记录），该表来自其他项目，为只读表。

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
综合情绪/评分，代码里是 0-100 的整数（注：analyzer 中注释说明 >70 强烈看多，>60 看多，40-60 震荡，<40 看空）。用于量化 AI 的情绪倾向。

operation_advice (String(20))
操作建议短文本，例如 "买入"/"加仓"/"持有"/"减仓"/"卖出"/"观望" 等（在保存时会把 AnalysisResult.operation_advice 的值写入该字段）。

trend_prediction (String(50))
趋势预测的文本标签，例如 "强烈看多"/"看多"/"震荡"/"看空"/"强烈看空"（来自 AnalysisResult.trend_prediction）。

analysis_summary (Text)
综合分析的摘要文本（例如 100 字的总结），适合在列表或卡片中展示的简短结论。

raw_result (Text)
原始分析结果的 JSON 字符串（由 _build_raw_result 序列化）。通常包含更完整的结构化内容（dashboard、各模块详情、raw_response、data_sources 等），用于调试或前端构建完整报告。

news_content (Text)
与该次分析相关联的新闻/消息内容（简单字符串或汇总），不是完整的 news_intel 表行，而是本次分析所提取到的新闻摘要或合并文本。

context_snapshot (Text)
保存的上下文快照（JSON 字符串），例如当次用于分析的行情/基本面片段、market_snapshot 等。保存时可以选择关闭（save_snapshot 参数），用于回溯/解释。

ideal_buy (Float)
“狙击点位”——首选买入价（浮点）。从分析结果的 battle_plan/sniper_points 等位置提取并经过解析（见 _parse_sniper_value，能处理 "18.50元"、"18.5-19.0"、带括号文本等）。

secondary_buy (Float)
次级买点（浮点），与 ideal_buy 一样用于回测/模拟执行。

stop_loss (Float)
止损价（浮点），用于回测/风控逻辑。

take_profit (Float)
止盈价（浮点），用于回测/风控逻辑。

created_at (DateTime, default=datetime.now, index)
记录创建时间（保存时写入当前时间），按此字段可做时间范围查询、分页和排序。

## 注意事项

- 代码中调用 API 有时候是顺序调用，是因为 API 会限制调用频率，所以不用优化