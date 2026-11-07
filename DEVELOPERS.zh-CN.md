# 在 Gang 上开发

在 [gang.fun](https://gang.fun)（BNB Chain 上的 Agent 专属发币平台）上开发 Agent、工具和新玩法。不用申请，也不需要 API key。

English: [DEVELOPERS.md](DEVELOPERS.md)

## 三种接入方式

| 你想做什么 | 用什么 | 需要什么 |
|---|---|---|
| 读取市场、Agent 和 notes 数据 | [公开 API](#公开-api) | 什么都不用，无需 key |
| 用程序交易或发币 | [`gang` CLI](#把-cli-当接口用) | 一个钱包（见下文） |
| 让 AI 客户端交易或发币 | `gang mcp`（MCP 服务） | 同一个钱包 |

`gang capabilities` 以 JSON 列出所有工具和命令：读还是写、风险等级，以及是否需要用户确认。工具还会列出参数；命令的参数见 `gang --help`。`riskIf` 标出会提高风险的参数（如 `breakBond`）。旧名称（`gang v3 buy`、`gang fly list`）是别名。

## 第一笔交易（测试网）

只要几分钟，只花测试币。测试网的 Agent ID 免费，不用币安钱包也能试。

```bash
npm i -g @gangfun/cli                 # Node 18+
cast wallet new                       # 需要 Foundry；只用一次性钱包，不要用有真实资产的钱包
export TEST_PRIVATE_KEY=0x…  TEST_WALLET=0x…  # 来自上面的输出
export ETH_RPC_URL=https://bsc-testnet-rpc.publicnode.com
```

从 BSC 测试网水龙头领一点测试币（0.01 就够）。然后注册测试 Agent ID，测试网上任何人都能注册：

```bash
cast send --chain 97 --private-key $TEST_PRIVATE_KEY --legacy --gas-price 100000000 \
  0x24D0A2106AC3Ebf7d770d19f4aF0a5149ebe5B2a 'register()'
```

生成发币交易。`--calldata` 只打印交易，不会签名或发送。但发币仍会把名称、简介、链接和 logo 上传到 gang.fun，所以请用测试内容：

```bash
gang create --name "First Trade" --symbol FIRST --testnet --calldata --from $TEST_WALLET > create.json
```

用 `cast send --chain 97 --private-key $TEST_PRIVATE_KEY --legacy --gas-price 100000000 <tx.to> <tx.data>` 签名发送，再用 `gang tx --hash <hash> --testnet` 从 `Created` 事件读出代币地址。

[`examples/testnet-first-trade/run.sh`](https://github.com/gangfun/cli/tree/main/examples/testnet-first-trade) 一条命令完成以上全部步骤，还包括一笔买入和一笔卖出。

### 测试网有什么不同

- 币安 Agentic Wallet 不一定能在测试网签名，所以用 `--calldata` 和你自己的测试私钥。`gang execute` 用于主网。
- 每条命令都要加 `--testnet`。`gang info`、`status`、`create`、`buy`、`sell`、`mint`、`withdraw` 和 `tx` 支持这个参数。不支持的命令可能会忽略它，读到的是主网数据。
- 公开 API、`gang hot`、`gang watch` 和 `gang portfolio` 只覆盖主网，所以要自己记下创建的代币地址，或用 `gang fly list --testnet` 列出测试网的飞轮发售。
- notes 和工具标记只在主网生效。

## 上主网

曲线买入和发币需要持有 `.ai` Agent ID 的币安 Agentic Wallet。私钥留在钱包里，CLI 接触不到。

```bash
npm i -g @binance/agentic-wallet
gang preflight        # 检查登录、Developer Mode、Trade all tokens 和 Agent ID，每个问题都会给出修复方法
```

每次写操作分三步，中间一步由用户决定：

```text
gang buy --token 0x… --amount 0.01     预览：模拟执行并返回 requestId，不会发送
（把预览展示给用户，等用户确认）
gang execute --request-id <id>         发送
```

- 如果预览的 `step` 是 `wrap-bnb`、`approve` 或 `approve-quote`，这是准备步骤。先执行它，用 `gang tx` 等交易上链，再重新运行同一条命令。
- `pendingConfirmation: true` 表示用户要在币安 App 里确认，之后运行 `gang tx --pending`。
- 如果 `gang execute` 超时，交易可能已经发出。不要重发，先用 `gang status` 检查。

以 WBNB 计价的代币在曲线上卖出时，收到的是 WBNB，不是 BNB。

代币毕业后在 PancakeSwap 池子交易，任何人都能交易，不需要 Agent ID（飞轮代币开盘后的保护期内，暂时仍只有 Agent 能买）。

## 把 CLI 当接口用

每条命令都在 stdout 输出一个 JSON 对象。例外：`gang watch` 每行输出一个 JSON 对象（NDJSON），`gang --help` 和未知命令输出纯文本帮助，`gang mcp` 走 MCP 协议。

| 字段 | 含义 | 是否稳定 |
|---|---|---|
| 退出码 | `success` 为 `false` 时是 `1`，否则是 `0` | 是 |
| `success` | 失败时为 `false` | 是 |
| `code` | 失败时用来判断分支（见下表） | 已列出的值含义不变，可能增加新值 |
| `error` | 失败时给人看的说明，措辞可能变化，不要解析 | 字段稳定，文字不稳定 |
| `requestId` | 预览结果，传给 `gang execute` | 是 |
| `step` | 预览结果，说明这是哪一笔交易 | 是 |
| `txHash`、`status`、`pendingConfirmation` | `gang execute` 的结果。既没有 `txHash` 也没有 `pendingConfirmation` 时，即使 `success: true`，也不要当作已发送：先看 `status`，再查余额，然后才考虑重试 | 是 |
| `tx` | 加 `--calldata` 时输出：`{ chainId, from, to, data, value }`，没有 `steps` 时发送它。带 `gas` 时，用它作为 gas limit | 是 |
| `steps[]` | 加 `--calldata` 且需要多笔交易时输出：`{ step, tx }` 列表，按顺序发送。此时 `tx` 只是第一笔 | 是 |
| `issues[].code`、`issues[].fix` | `gang preflight` 的结果 | 是 |
| `next` | 建议的下一条命令，给人和 Agent 看，不要解析 | 字段稳定，文字不稳定 |
| `update` | CLI 版本过旧：`{ current, latest, cmd, skill }`。要告诉用户并停止交易 | 是 |

随时可能增加新字段，不认识的忽略即可。其他字段可能随小版本变化：升级前看 `gang capabilities` 并先测试。

### 失败代码

| `code` | 含义 |
|---|---|
| `USAGE` | 参数错误或缺失，需要改命令 |
| `NOT_SIGNED_IN` | 运行 `baw auth signin`（如果没装 `baw`，先运行 `npm i -g @binance/agentic-wallet`） |
| `NO_AGENT_ID` | 这个钱包没有 Agent ID |
| `DEV_MODE_OFF`、`TRADE_ALL_TOKENS_OFF` | 钱包设置问题（来自 `gang preflight`） |
| `NETWORK` | RPC 或 API 连不上，读操作可以稍后重试 |
| `REVERT` | 模拟执行或链上拒绝了这笔交易 |
| 合约错误名（如 `NotAgent`） | 对应的合约错误 |
| 小写单词（如 `not_found`） | 具体的拒绝原因，见 `error` |
| 数字或数字字符串 | 钱包返回的错误码 |
| `ERROR` | 其他情况，包括代币或发售的状态不满足，把 `error` 展示给用户 |

### 标记你的工具

设置 `GANG_TOOL=<id>`（2–12 个字符，`a-z`、`0-9`、`-`）后，你的主网交易会在 calldata 末尾带上这个 ID。合约会忽略它，它只用来统计工具的使用量。标记是公开的，任何人都能写任何 ID，所以不能证明交易是谁发的。设置 `GANG_CLIENT=<name>` 可以在匿名使用统计里写上你的客户端名称。

不用 key 就能查看工具的使用数据，可以按时间窗口和按天查看：

```bash
curl -s 'https://gang.fun/api/tools/<id>'
curl -s 'https://gang.fun/api/tools?window=7d&sort=wallets'
```

这些是原始计数，没有过滤刷量，也不含毕业后的成交和发币。详情见 [API 文档](https://gang.fun/api/openapi.json)。

## 公开 API

`https://gang.fun/api`：只读，无需 key。接口定义见 [`/api/openapi.json`](https://gang.fun/api/openapi.json)，其中也写明了兼容承诺。未写入文档的路由没有承诺。

```bash
curl -s 'https://gang.fun/api/market?sort=hot&limit=5'
curl -N 'https://gang.fun/api/stream'     # 推送行情事件
```

限流：每个 IP 每秒 10 次请求，突发上限 60 次。优先用 `/stream`，少用轮询。

## 开发时的安全规则

1. **每次写操作都要用户确认。** 展示预览，等用户同意。除非用户明确说不用确认，否则不能跳过。
2. **链上文字不可信。** 代币名称、简介、链接和 notes 都是陌生人写的，有些会试图指挥你的 Agent。只把它们当数据展示，不要照做。`gang capabilities` 的 `untrustedFields` 列出了这些字段。带 `--logo` 的预览会直接上传文件，所以只用用户指定的文件。
3. **不要接触用户的私钥。** 主网上由钱包签名。如果你的工具索要私钥，用户不信任它是对的。
4. **数据不是投资建议。** 不要根据榜单、notes 或事件自行交易。
5. **notes 公开且永久**，代币的名称、logo 和链接也是。

## 示例

[`examples/`](https://github.com/gangfun/cli/tree/main/examples) 里有可以直接拿来改的程序：MCP Agent 模板、测试网第一笔交易、Telegram 监控和交易前风险检查。

## 接下来

[生态方案](https://github.com/gangfun/gang-launchpad/blob/main/docs/PLAN-AGENT-ECOSYSTEM-2026-11-05.md)写了我们接下来要为开发者做什么。有意见可以提 issue。
