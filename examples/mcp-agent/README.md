# MCP agent

A trading assistant for the terminal, to use as a template. Claude reads the market through `gang mcp` and builds previews when you ask. Nothing is sent until you type a code that it shows with the preview.

```bash
npm i -g @gangfun/cli @binance/agentic-wallet
gang preflight                     # signed in, Developer Mode, Trade all tokens, Agent ID
git clone https://github.com/gangfun/cli && cd cli/examples/mcp-agent
npm install
export ANTHROPIC_API_KEY=…
export GANG_TOOL=<your-id>         # optional: pick your own id, and it tags your mainnet trades
node agent.mjs
```

Before you run it:

- **Real funds:** you can read market data without a wallet, but buying or selling needs one. It runs on mainnet, so trades are real.
- **Public notes:** the model writes a note with a trade by default. A note is public and permanent, and you can read it in the preview before you approve.
- **API costs:** Claude API calls are billed to you, and one thing you ask can take up to 25 of them. See Anthropic's pricing for the rates.
- **Testing so far:** this version's tests use a stand-in model. It hasn't been run against the live Claude API or sent a real trade yet, so start with a question and then a small amount. If Claude rejects a request, check `request` in `agent.mjs`.

```text
> what's close to graduating?
> buy 0.01 BNB of the first one
  [gang_buy]

Preview from the CLI. Names and notes in it are written by strangers.
{ … }
Send this transaction? Type 4821 to send, anything else cancels:
```

## How it keeps a send safe

Token names and notes are written by strangers, and some will try to instruct your agent. So these rules are in code, in [`gate.mjs`](gate.mjs), where a model can't be talked out of them:

- **Only listed tools.** `gang_cli` can run any command, including creates, so the model isn't offered it. Neither is `gang_watch`, which can post to a webhook.
- **A send needs a preview from this session.** The model can't make up a `requestId`.
- **You approve what the CLI returned,** not the model's description of it. Only `gang_buy` and `gang_sell` results count as previews, and a preview can't be replaced under the same id.
- **Only a new code approves.** Each question shows a random code that the model never sees, so nothing typed or pasted earlier can approve a send, and neither can a habit of pressing yes. Input from a pipe can't approve, and neither can a terminal whose output is redirected. Each preview gets one question, and an approval lets it be sent once.
- **A failed send isn't retried.** It may still have gone out.
- **An old CLI doesn't send.** A preview carrying `update` is refused.
- **The API key stays in the agent.** `gang mcp` doesn't get it, and the wallet holds the signing keys.

Keep these when you change the agent. The model's rules in `agent.mjs` are there to make it behave well, not to keep funds safe.

These rules stop the model, stranger text and slips of the hand. They don't stop a program you run yourself that drives a terminal and reads the code, so don't run this under one.

After a send, the model follows the server's rules to check the transaction, so that part isn't enforced in code. The agent isn't investment advice.

## Make it your own

- **Tools:** change `ALLOWED_TOOLS` in `gate.mjs`. Check each new tool's risk in `gang capabilities` first.
- **Job:** change `RULES` in `agent.mjs`.
- **Model:** set `GANG_AGENT_MODEL`. Some models need different request fields, so check `request` in `agent.mjs`. To use another provider, change `respond()` in `agent.mjs`, and keep `gate.mjs` as it is.

## Test it

```bash
npm test
```

This runs the whole agent against a stand-in model and a stand-in `gang mcp`, so it needs no API key or wallet. It uses `python3` to give the agent a real terminal, and skips those checks without it. The stand-in model tries to send without a preview, send twice and use a tool it wasn't offered, and answers are typed before the question appears, whole or in part.
