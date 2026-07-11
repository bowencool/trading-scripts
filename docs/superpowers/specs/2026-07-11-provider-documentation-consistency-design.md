# Provider 文档一致性设计

## 目标

统一项目元数据、README、架构规格和协作约束，使公共描述体现行情 Provider 与 Broker Adapter 的独立边界，同时准确说明 Longbridge 是当前实现而非业务架构本身。本次只修正文档，不新增 CI，也不改变任何运行行为。

## 修改范围

- `package.json` 的 description 改为 provider-neutral，不把项目定义为基于某一家券商。
- README 的功能、交易流程和快速开始使用通用 Provider/Adapter 术语；Longbridge 仍作为当前行情与交易实现、OAuth 配置来源及 `reconciled-orders` 限制单独说明。
- 原 Adapter 规格把 Provider 选择规则修正为逐项 `CLI > env > error`，并链接 [Provider 环境变量回退设计](./2026-07-11-provider-env-fallback-design.md)，移除旧 CLI-only 结论。
- Longbridge OAuth 环境变量从含义模糊的旧通用名称硬改为 `LONGBRIDGE_CLIENT_ID`；README、`.env.example` 和相关规格不得保留旧名称或兼容回退表述。
- `AGENTS.md` 增加架构防回归约束：业务层只依赖 provider-neutral 接口和领域类型；券商 SDK、类型映射及供应商特有限制必须留在对应实现层。
- 通用代码注释改用 provider-neutral 表述；Longbridge 的 OAuth、symbol 后缀、顺序调用和非实时 OCO 等说明只保留在 Longbridge 实现边界。
- 审计 `.github` Docker workflow；其内容当前没有过时的 Provider 参数、环境变量或架构描述，因此保持不改。

## 明确不做

- 不修改 CLI、Provider factory、订单逻辑、认证流程、Docker 运行行为或数据库访问。
- 不新增 lint 规则、CI job、workflow、依赖或自动文档检查。
- 不删除必要的 Longbridge 实现说明，也不把 `reconciled-orders` 描述成券商原生 bracket/OCO。

## 验收扫描规则

1. 业务层源码及通用架构描述中不存在 Longbridge SDK、Context、Decimal、券商枚举或券商专属调用链描述；这些内容只允许出现在 Longbridge 实现与其实现说明中。
2. 全仓扫描与 `CLI > env > error` 冲突的旧 CLI-only 表述应为零。
3. README、Adapter 规格和环境变量回退规格对选择优先级一致：CLI 逐项覆盖环境变量，两者都缺失才报错，且校验早于认证和连接。
4. 所有 OCO 描述必须明确：Longbridge 当前为 `reconciled-orders`，SL/TP 是独立订单，一单成交后另一单在下次脚本启动时清理，不具备实时或服务端原生 OCO 保证。
5. `package.json` description、README 功能/流程/快速开始和新增 `AGENTS.md` 约束均体现 provider-neutral 架构；Longbridge 仅作为当前实现出现。
6. 公开配置、示例和规格中的旧通用认证变量名为零，统一使用 `LONGBRIDGE_CLIENT_ID`；私有 `.env` 不在修改范围。
7. `.github` Docker workflow 与本轮需求核对后保持无 diff；全仓 `git diff --check`、现有测试、lint 和类型检查继续通过。
