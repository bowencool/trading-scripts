# Provider 环境变量回退设计

## 目标

为行情 Provider 和交易 Broker 增加环境变量回退，同时保留命令行的显式覆盖能力。行情使用 `MARKET_DATA_PROVIDER`，交易使用 `BROKER_PROVIDER`。

## 解析与校验

- 每项配置独立按 `CLI > env > error` 解析：
  - `--market-data` 覆盖 `MARKET_DATA_PROVIDER`。
  - `--broker` 覆盖 `BROKER_PROVIDER`。
- CLI 与环境变量的值必须进入同一 allowlist 校验。目前两项唯一允许值均为 `longbridge`，不得因来源不同采用不同校验规则。
- 未提供 CLI 且对应环境变量为空时，返回缺失配置错误；提供未知值时，返回包含来源和值的无效配置错误。
- `--help` 直接输出 usage 并成功退出，不读取或要求 Provider 环境变量。
- Provider 解析和校验必须在读取认证配置、执行 OAuth、创建行情连接或创建交易连接之前完成；任何配置错误均不得触发外部连接。

## 文档与部署

- README 同时展示显式 CLI 选择和环境变量回退两种运行方式，并说明 CLI 的覆盖优先级。
- `.env.example` 增加 `MARKET_DATA_PROVIDER=longbridge` 与 `BROKER_PROVIDER=longbridge` 及对应注释。
- Docker 默认值和运行示例同步使用这两个环境变量；用户仍可通过容器命令行参数覆盖它们。

## 测试矩阵

| 场景 | CLI | 环境变量 | 预期 |
| --- | --- | --- | --- |
| CLI override | 两项均提供有效值 | 两项提供不同或无效值 | 使用 CLI 值并成功解析 |
| Partial override | 仅提供其中一项 | 提供另一项有效值 | 两项按各自优先级组合成功 |
| Env fallback | 不提供 Provider 参数 | 两项均提供有效值 | 使用环境变量并成功解析 |
| Missing | 缺少一项或两项 | 对应环境变量也缺失 | 返回缺失错误，不认证、不连接 |
| Unknown CLI | 任一 CLI 值不在 allowlist | 任意 | 返回无效 CLI 值错误，不认证、不连接 |
| Unknown env | 对应 CLI 未提供 | 任一环境变量值不在 allowlist | 返回无效环境变量值错误，不认证、不连接 |
| Help | `--help` | 缺失或无效 | 输出 usage，退出码为 0，不认证、不连接 |

## 兼容性约束

- `--dry-run`、`--auto-approve` 和现有 Provider factory 接口保持不变。
- 不引入隐式默认 Provider；CLI 与环境变量都缺失时必须报错。
- 行情与交易选择保持独立，不要求两者来自同一供应商。
