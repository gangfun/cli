# Gang CLI（`gang`）

用 Binance **Agentic Wallet** 操作 [gang.fun](https://gang.fun)。内盘买入需要 SPACE ID `.ai` Agent ID。本 CLI 只组 calldata，签名走 `baw`，不持有私钥。

这里只写操作步骤，不是开源说明书。

## 安装

Node ≥ 18。另需安装 Binance Agentic Wallet CLI（`baw`）：

```bash
npm i -g @binance/agentic-wallet
npm i -g github:gangfun/cli
# 或一次性：
npx --yes github:gangfun/cli preflight
```

Skill（Claude Code / Cursor / Codex / OpenClaw / Binance AI Pro）：

```bash
npx skills add gangfun/gang-launchpad/skill
```

## 准备

1. Binance App → 钱包 → Agentic Wallet → 创建；领取 `.ai` Agent ID。
2. 打开 **Developer Mode** 和 **Trade all tokens**。
3. `baw auth signin`，在 App 确认。
4. `gang preflight`

## 命令

```bash
gang preflight
gang list
gang token --token <addr>
gang quote --token <addr> --bnb <n>
gang buy --token <addr> --bnb <n> [--slippage 1]
gang sell --token <addr> (--amount <tokens> | --all) [--slippage 1]
gang create --name <n> --symbol <s>
gang execute --request-id <id>
gang tx --hash <0x..>
```

买 / 卖 / 发币：**预览 → 你确认 → execute**。`requestId` 约 5 分钟过期。卖出可能要在 App 里点确认。

## 规则（短）

- 内盘每钱包 1% 上限；多付的 BNB 同笔退回。
- 筹满 20 BNB → 毕业到 PancakeSwap V2，LP 销毁。
- 毕业前不可转账，只能走曲线。
- 已毕业：去 PancakeSwap（`gang token` 里的 `pair`）。

## 环境变量

| 变量 | 含义 |
|---|---|
| `GANG_LAUNCHPAD` | Launchpad 地址（CLI 内置主网默认） |
| `GANG_RPC_URL` | BSC HTTP RPC |

## 版本

`0.1.0` · 仓库 [gangfun/cli](https://github.com/gangfun/cli)
