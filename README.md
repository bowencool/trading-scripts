# trading-scripts

一个非常简单的 TypeScript 脚本，运行在本地和服务器，**不需要安装任何框架**。

## 功能

- 从 Binance 公开 API 拉取 K 线数据（无需 API key）
- 计算简单移动平均线（SMA7 / SMA25）
- 输出多空信号

## 快速开始

```bash
# 安装依赖（仅 TypeScript 工具链，无框架）
pnpm install

# 运行示例脚本
pnpm start

# 开发模式（文件改动自动重新运行）
pnpm dev
```

### 示例输出

```
Fetching 30 1d klines for BTCUSDT…
Date        : 2026-05-03
Close price : 96800.00 USDT
SMA  7      : 95200.00 USDT
SMA 25      : 92100.00 USDT
Signal      : 📈 Bullish (SMA7 > SMA25)
```

## 项目结构

```
trading-scripts/
├── src/
│   └── index.ts   # 主脚本入口
├── package.json
└── tsconfig.json
```

## 依赖说明

| 包 | 用途 |
|---|---|
| `tsx` | 直接运行 TypeScript，无需编译步骤 |
| `typescript` | 类型检查 |
| `@types/node` | Node.js 内置模块类型定义 |