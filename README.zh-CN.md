# Gang CLI（`gang`）

用 Binance **Agentic Wallet** 操作 [gang.fun](https://gang.fun)。内盘买入/发币需要 SPACE ID `.ai` Agent ID。本 CLI 只组 calldata，签名走 `baw`，不持有私钥。

**发币路径（0.2.1+）：** 仅 LaunchpadV2（`0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E`）。Soft / LaunchpadU / LaunchpadS：**禁止新 create**，仅存量 buy/sell/claim。新币毕业 ≈ **15 BNB**（PoolCheck）。Soft 存量链上仍为 20 BNB 毕业。

## 安装

Node ≥ 18。另需 `baw`：

```bash
npm i -g @binance/agentic-wallet
npm i -g @gangfun/cli@latest
```

npm 公共源，无需鉴权；升级用同一条命令。或（git 最新）：`npm i -g github:gangfun/cli`

Skill：`npx skills add gangfun/gang-launchpad/skill`

## 准备

1. 币安 App → 钱包 → Agentic Wallet；领取 `.ai` Agent ID。
2. 打开 **Developer Mode** 与 **Trade all tokens**。
3. `baw auth signin`
4. `gang preflight` — `createPad` 须为 LaunchpadV2。

## 命令

```bash
gang preflight
gang list
gang hot [--limit 10] [--track all|v2|soft] [--include-graduated]   # 按 24h USD 成交量
gang new [--limit 10] [--max-age 2h]
gang near-grad [--min-pct 50] [--limit 10]
gang watch [<addr>] [--interval 10] [--events a,b] [--max-events N] [--timeout 30m] [--webhook URL]
gang token --token <addr>
gang quote --token <addr> --bnb <n>
gang buy --token <addr> --bnb <n> [--slippage 1]
gang sell --token <addr> (--amount <tokens> | --all) [--slippage 1]
gang upload-logo --file ./avatar.png
gang create --name <n> --symbol <s> [--logo-uri URL | --logo ./avatar.png] [--taxed] [--pair-or-quote 0x…]
gang execute --request-id <id>
gang tx --hash <0x..>
```

### Logo + 发币

站内：https://gang.fun/dev/logo

```bash
gang upload-logo --file ./avatar.png
gang create --name "My Agent Coin" --symbol MAC --logo-uri https://gang.fun/api/logos/<id>.png
gang execute --request-id …

# 或一步上传
gang create --name "My Agent Coin" --symbol MAC --logo ./avatar.png
gang execute --request-id …
```

### 发现（0.3.0+）

`hot` / `new` / `near-grad` / `watch` 读 gang.fun indexer（`GANG_API`），同时覆盖 V2 与 Soft。每行带 `quote`（`--bnb` 的单位）、
`progressPct`、`remaining`/`remainingUsd`、`volume24hUsd`、`holders`、`ageMin` 和 `next` 命令；已毕业默认隐藏（`--include-graduated` 显示）。

`gang watch` 轮询并输出 NDJSON（最短间隔：单币 3s，全市场 10s）：带 `<addr>` 推 `trade` / `progress`（25/50/75/90%）/ `graduated`；不带则推 `new_token` / `near_grad`（越过 `--min-pct`）/ `graduated`。
`--max-events 1` = 阻塞到下一个事件；`--webhook` 把每个事件 POST 出去。详见 [skill/references/discover.md](https://github.com/gangfun/gang-launchpad/blob/main/skill/references/discover.md)。

## Quote 路径

- Soft 存量：链上 `quoteBuy` / `quoteSell`。
- **LaunchpadV2：** 唯一路径 = 合约 `LaunchpadV2.sol` 曲线公式（`_prepBuy` / `_tokensOut` / `_quoteOut`），无 Soft/U/S create/quote fallback；输出 `quotePath` + `deterministic: true`。

## 规则（短）

- 内盘每钱包 1%；多付同笔退回。
- **新**发币 ≈15 BNB 毕业（LaunchpadV2）。Soft 存量归档：20 BNB，仅买卖。
- 毕业前不可转账；毕业后走 PancakeSwap。

## 环境变量

| 变量 | 含义 |
|---|---|
| `GANG_LAUNCHPAD` | 发币目标（默认 V2） |
| `GANG_RPC_URL` | BSC RPC |
| `GANG_LOGO_API` | Logo 上传 API（默认 `https://gang.fun/api/logos`） |
| `GANG_API` | 发现命令用的 indexer API（默认 `https://gang.fun/api`） |

## 版本

`0.3.0` · [gangfun/cli](https://github.com/gangfun/cli) · push 到 `main` 自动发布到 [npm](https://www.npmjs.com/package/@gangfun/cli)
