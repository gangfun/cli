# Risk check

Lists what to look at before a trade: pool tax and who receives it, holder concentration, the creator's holding and launch history. It reads only: no wallet, nothing sent.

```bash
npm i -g @gangfun/cli
node risk-check.mjs 0x…   # a token address
```

```json
{
  "success": true,
  "kind": "v3",
  "findings": [
    { "level": "warn", "check": "holders", "detail": "the top 10 wallets have 83.0% of the tokens in wallets" },
    { "level": "info", "check": "tax", "detail": "pool tax: buy 4%, sell 4%" }
  ]
}
```

`level` is `warn`, `unknown` (the data wasn't available) or `info`. The thresholds are at the top of the script, so set your own.

The findings are facts for a person to weigh, not advice. An empty list doesn't mean a token is safe, and one creator can hold through many wallets. The pad, the pair and burned tokens are left out of the holder figures, but another contract can still count as a wallet.
