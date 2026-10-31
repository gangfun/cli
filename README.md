# Gang CLI (`gang`)

Operate [gang.fun](https://gang.fun) from a Binance **Agentic Wallet**. Curve buys/creates require a SPACE ID `.ai` Agent ID. This CLI builds calldata; `baw` signs — no keys in this package.

**`gang create`:** launches a V3 token on GangLaunchpad (`gang create --fair` a 打新 sale); it's untaxed unless `--buy-tax` / `--sell-tax` are given. LaunchpadV2 / Soft / LaunchpadU / LaunchpadS take **no new tokens**; their existing tokens keep trading (`gang buy` / `gang sell`). New V3 tokens graduate at **15 BNB** on GangLaunchpad 1.0; on 2.0 the creator picks **6 / 9 / 12 / 15 BNB** with `--grad` (default 9). Soft archive tokens still graduate at 20 BNB on-chain.

**One command per action (0.12.0+):** `gang buy` / `sell` / `info` / `status` / `claim` / `mint` / `withdraw` / `release` work on every token: the CLI reads the token's kind and runs the V3, 打新 or V2 / Soft code. `gang v3 …` / `gang fair …` stay as aliases.

**铸币飞轮 / Mint Flywheel (0.18.0+):** `gang create --fly` starts a sale on GangFlywheelPad (its own pad, kind 3): shares with a quota per wallet (invites add quota), a pool at the mint price once it fills, and minting that goes on after launch. The unified commands detect these tokens (`kind: "fly"`); `gang fly …` is the alias. Live on BSC mainnet since 2026-10-30 (V1 pad `0x631e66560F4FAE4e486B65349edE48189E48B029`); from 0.21.0 new tokens go to the V2 pad `0x281889ad915c1A95ffc4922235c6314b3Cbd8a5a` (built in; `create --fly` says so while it is not open yet), and every other command follows the token's own pad. `--testnet` uses BSC testnet (V1 set 2, V2 `0x7069…E3d6`). Rules: `skill/references/fly.md`.

**V3 tax tokens and 打新 (0.9.0+):** on GangLaunchpad, live on BSC mainnet since 2026-10-27 (1.0: pad `0x15CFD2dc8278Fb87a1783ef42111618E20874365`, GangRouter `0xE040445690Aa56C8b68B7f7038C7b2562B5079C4`; new tokens go to 2.0 since 2026-10-31: pad `0x770331a9accdb53ACb4a45B6c5B7D151fADCe557`, GangRouter `0xa83209d6bfC2B220cD86410cCDDC71FEb354844a`; all built in); `--testnet` uses BSC testnet (2.0 for new tokens, set 10 = 1.0 for its tokens).

**Split recipient (0.19.0+):** `gang create … --buy-tax … --sell-tax … --split self:60,0x…:30,0x…:10` makes a V3 token's tax recipient the dev's split module (GangSplitModule, `split-v1`): the recipient's part of the tax is split among 1–10 payees at shares fixed for good (nobody, not the dev, not the platform, can change them; a payee can only move its own slot). `self` is the creating wallet (`me` also works); payee slots are numbered as in the contract, from 0 (`--index`). The quote must be one the keeper splits: WBNB (default), GANG or a quote in the pad's QuoteRegistry (others are refused before the clone, as for `--buyback`); `gang split distribute` still splits any asset sent to the module. `gang split …` shows and drives it. Live on BSC mainnet (factory `0x27e08271E52B2D129c824CD245e69471a8d3067c`, allowed by the platform's Safe on 2026-10-30; 2.0: `0xa73dC3d63AAf72E70b1cb012e5f3A541360Bec59`; built in) and testnet set 10.

**Auto-liquidity recipient (0.20.0+):** `gang create … --buy-tax … --sell-tax … --lp 70 [--lp-to 0x…]` makes a V3 token's tax recipient the dev's LP splitter (GangLiquiditySplitter, `lp-burn-v1`, the buy-back splitter's sibling): `--lp` % of the recipient's part of the tax is added to the token's PancakeSwap pair as liquidity whose LP goes to 0xdead (locked for good), the rest goes to the dev or `--lp-to`. After graduation the keeper adds it in chunks (half buys the token, all of it goes back in with the matching quote; one per 4 minutes). The ratio and payee change as for `--buyback` (a raise at once, a cut after a 3-day notice; the payee at once). Same quotes as `--buyback` / `--split`. `gang lp …` shows and drives it. Live on BSC mainnet (factory `0xE0436867dAFcf42Ee1418083251a9B8B61F0C248`, allowed by the platform's Safe on 2026-10-31; 2.0: `0x8ac85f150f87B536fb05eA163908b1077D95c0E4`; built in) and testnet set 10 (factory `0xA729C60FCa0Bd0D28a55E22126D3fE412AA41591`).

**Combined recipient (0.22.0+):** two or three of `--buyback`, `--lp`, `--split` on one taxed launch make a V3 token's tax recipient one GangComboSplitter (`combo-v1`): `gang create … --buy-tax 3 --sell-tax 3 --buyback 30 --lp 30 --split self:70,0x…:30` buys back and burns 30% of the recipient's part, adds 30% to the pair as liquidity (LP to 0xdead) and pushes the rest (40%) to the payees, whose `--split` shares are of that rest (here 28% / 12% of the recipient's part); without `--split` the rest goes to the dev, and `--buyback` + `--lp` = 100 takes no payees. **Everything is permanent**: the ratios, payees and shares can never change (unlike a lone `--buyback` / `--lp`, whose ratio the dev can change); a payee can only move its own slot. Any other asset sent to it: the buy-back + LP share to 0xdead, the rest to the payees. `--buyback-to` / `--lp-to` don't apply. One flag alone still uses its own module. `gang combo status|distribute|release|set-payee|bind|chunk` shows and drives it. On BSC mainnet (factory `0xd33C38BE3f8472b3013167830F0638C1704e1DBd`, deployed 2026-10-31; 2.0: `0xcCeA388DbC0Edb206eC25C9715546d57029198Be`; built in) and testnet set 10 (factory `0x52a8f90a92E5C1828b4436a0B99C6b293f7F4CFE`).

**GangLaunchpad 2.0, the creator fee and the graduation target (0.23.0+):** 2.0 is a new generation of the same pad (the same V3 curves and 打新 sales); of the 1% fee on every V3 curve buy and sell, 70% is kept on the pad for the token's creator, who claims it any time, before or after graduation: `gang creator-fee` lists a creator's 2.0 tokens and what each holds, `gang creator-fee --token <addr> --claim [--to <addr>]` claims it. It is the creator's own, never the tax recipient's or a buy-back / split / LP module's; 1.0 tokens and 打新 sales have none. 2.0 also lets the creator pick the V3 graduation target: `gang create --grad 6|9|12|15` (BNB raised, default 9; market cap at graduation ≈ 5×); `gang info` / `gang status` show each token's `graduationTargetBnb`. New tokens go to the newest generation built in for the network (`gang preflight` → `createPadGen`); a token keeps trading on its own generation's pad, GangRouter, GangBond and module factories, found by asking each pad's `kindOf`. On the BSC testnet 2.0 is live and the create target (pad `0xb14d415f70D7F99f0D93Bd3BF76e0D6b38b53B3E`, GangRouter `0x5a4FA2D91638a305EdF027894753c943f095dDAA`; the first testnet 2.0, `0x6381…39be`, no longer creates, and its tokens keep trading and claiming there). On BSC mainnet 2.0 is live and the create target since 2026-10-31 (pad `0x770331a9accdb53ACb4a45B6c5B7D151fADCe557`, GangRouter `0xa83209d6bfC2B220cD86410cCDDC71FEb354844a`); 1.0 tokens keep trading on 1.0 (pad `0x15CF…4365`).

## Install

Node ≥ 18. Also install Binance Agentic Wallet CLI (`baw`):

```bash
npm i -g @binance/agentic-wallet
npm i -g @gangfun/cli@latest
```

Package: [`@gangfun/cli` on npm](https://www.npmjs.com/package/@gangfun/cli) (public registry, no auth). Upgrade with the same command.

**Alternate** (public git tip):

```bash
npm i -g github:gangfun/cli
```

Skill:

```bash
npx skills add gangfun/gang-launchpad/skill
```

## Setup

1. Binance App → Wallet → Agentic Wallet → create; claim a `.ai` Agent ID.
2. Enable **Developer Mode** and **Trade all tokens**.
3. `baw auth signin` → confirm in the App.
4. `gang preflight` — `createPad` must be GangLaunchpad 2.0 (`0x770331a9…E557`; `createPadGen` `2.0`).

## Commands

```bash
gang version                      # this CLI's version (also -v, --version), no wallet needed
gang preflight
gang hot [--limit 10] [--track all|v3|fair|fly|v2|soft] [--include-graduated]   # 24h USD volume
gang new [--limit 10] [--max-age 2h]
gang near-grad [--min-pct 50] [--limit 10]
gang watch [<addr>] [--interval 10] [--events a,b] [--max-events N] [--timeout 30m] [--webhook URL] [--poll]
gang notes [--agent a,b] [--min-hit 0.6] [--sort new|author|followers] [--token <addr>] [--limit 10] [--all]   # notes you can follow now
gang watch --notes [--agent a,b] [--min-hit 0.6] [--interval 30] [--events note,revealed]                    # new followable notes
gang agents [--window 1d|7d|30d|all] [--sort score|hitRate|count|follow|followUsd] [--limit 10]               # who to follow
# One command per action, whatever pad the token is on (0.12.0+): the CLI reads GangLaunchpad's kindOf (V3 curve / 打新
# sale; otherwise the V2 / Soft / U / S pads) and runs that kind's trade. --testnet = BSC testnet, 2.0 and set 10 (GangLaunchpad only)
gang list [--limit 20] [--kind v3|fair|fly [--status …]]  # V2 / Soft / U / S on chain, newest 20 per pad; --kind v3|fair: from gang.fun, fly: the pad
gang info --token <addr>                     # one token, any pad (gang token is the older name)
gang status --token <addr>                   # my position: balance; V3 dividend / 打新 reward, sellable; poolSellAll
gang portfolio [--from <addr>]               # every holding: balance, value, cost / unrealized, claimable, USD; bonds; creator fees (2.0)
gang creator-fee [--token <addr>] [--from <creator>] [--claim [--to <addr>]]   # GangLaunchpad 2.0: 70% of the 1% curve fee, the creator's
gang quote --token <addr> --amount <n>       # V2 / Soft / U / S curve only (Soft: BNB; V2: quote ERC-20, LaunchpadV2.sol math)
gang buy --token <addr> --amount <n> [--slippage 1] [--follow <note tx>] [--note "<why>" [--conf 0-100] [--reveal-after 1-72h]]
#   --amount = what to spend in the token's quote (--bnb is the older name). V3: includes the 1% curve fee (no tax on the
#   curve; WBNB-quoted pays native BNB via GangRouter). 打新: after launch only. Graduated / launched: PancakeSwap via GangRouter
gang sell --token <addr> (--amount <tokens> | --all) [--slippage 1] [--to-bnb] [--note … [--conf …] [--reveal-after …]]
#   打新 after launch: past sellableBeforeOut needs --confirm-out
gang mint --token <addr> --shares <n> [--note …]       # 打新 before it fills: + the sale's mint fee (1–3%, the platform's)
gang withdraw --token <addr> (--shares <n> | --all) [--note …]   # 打新: sell back at the mint price before it fills
gang claim --token <addr>                    # V3: my dividend (in the quote token); 打新: the holder reward
gang release --token <addr>                  # V3: push a tax payment that failed earlier; 铸币飞轮: an owed dev cut / tax share
gang follow <note tx> --amount <n> [--slippage 1] [--note …]   # buy the token a note is about, as a follow of it
gang upload-logo (--file ./avatar.png | --url <image URL>)   # → ipfs://<cid> (view at https://cdn.gang.fun/ipfs/<cid>)
# create: GangLaunchpad. A V3 token (own buy / sell tax 1–5%, pool only, paid to the creator itself or a whitelisted
# recipient, in the quote; untaxed without --buy-tax / --sell-tax), or with --fair a 打新 (fair mint) sale on the same pad
gang create --name <n> --symbol <s> [--buy-tax 2 --sell-tax 2 [--dividend 0] [--recipient 0x…]] [--logo ./avatar.png | --logo-uri URL] [--website URL] [--twitter @handle] [--description "…"] [--testnet]
gang create --fair --name <n> --symbol <s> [--raise 15] [--cap 0.5] [--hold 60] [--mint-fee 1] [--exit-fee 1] [--shares 1] [--logo …] [--website URL] [--twitter @handle] [--description "…"] [--testnet]
#   --cap 0.25–1% of supply per wallet (1% → at least 50 wallets), --hold 60–90% (the hold line)
# 铸币飞轮 (Mint Flywheel, GangFlywheelPad; mainnet, --testnet = set 2). --preset j (default: the J template) or
# steady; every setting can be overridden: --raise 3-50 --quota 5-100 --invite-bonus 0-3 --max-per-tx 1-10 --hold 60-90
# --mint-fee 1-3 --exit-fee 1-2 --dev-cut 0-10 --buy-pct 0-50 --sell-tax 1-2 --launch-delay 0-300 --window 300-1800
# --cap-mul 1-2 --post-mint|--no-post-mint --tier flat|standard|linear [--step-pct --step-shares --max-mul] --supply-cap 10-500
# V2 pad only: --guard off|15|20|30 (default off: no pause on price drops) --twap-window 15|30 (default 30); --quota ≤ 10 with post-launch minting
gang create --fly --name <n> --symbol <s> [--preset j|steady] [settings…] [--dev-shares 1] [--logo …] [--testnet]
gang mint --token <addr> --shares <n> [--ref <inviter>] [--slippage 2]   # before launch: the sale price; after: mintPost (pool price or above)
gang fly open-early --token <addr>           # creator, ≥ 30% sold
gang fly launch --token <addr>               # anyone, after launchAt
gang fly invite --token <addr> [--who <addr>]   # https://gang.fun/token/<addr>?ref=<who>, invites, bonus, quota left
gang v3 income --recipient 0x…               # a recipient's income per token (gang.fun)
# aliases: gang v3 <list|info|status|create|buy|sell|claim|release|tx>, gang fair <list|info|status|create|mint|withdraw|buy|sell|claim|tx>,
#   gang fly <list|info|status|create|mint|withdraw|open-early|launch|invite|buy|sell|claim|release|claim-dev|tx>
#   run the same code (their results carry useInstead)
# Creator bond (押金承诺, GangBond): from create on, the creator bonds quote that it keeps ≥ X tokens; T = graduation / launch + --days
gang bond post --token <addr> --hold <tokens|N%> --days <7-90> (--amount <quote> | --cover 100) [--use-wbnb]  # creator, from create on (--cover once on the pair); WBNB quote: paid in BNB unless --use-wbnb
gang bond topup --token <addr> (--amount <quote> | --cover <%>) | gang bond raise-hold --token <addr> --hold <tokens|N%>
gang bond extend --token <addr> --days <n>                       # creator: bond only grows, X only rises, the commitment only gets longer
gang bond status --token <addr>                                  # state, pending / running, X vs the creator's balance, coverage + tier, time left
gang bond start --token <addr>                                   # anyone, once graduated / launched: start the --days clock
gang bond report --token <addr>                                  # anyone, below X: 1% to you, the rest buys back and burns
gang bond settle --token <addr>                                  # anyone, after T while X is held: the bond goes back to the creator
gang bond refund --token <addr>                                  # creator: no pair 30 days after the post → ask, then 3 days later get it back
gang bond burn --token <addr> | gang bond tx --hash <0x..>       # push one buy-back chunk / decode GangBond events
#   A creator's gang sell (curve or pool) / gang withdraw below X is refused unless --break-bond (past T: --settle-first)
# Launch in one command: one tx per run — execute it, run the very same command again, until launch.stage = done
gang create … --dev-buy <quote> [--bond <quote> [--bond-hold <tokens|N%|all>] --bond-days <7-90>]  # V3: create → dev buy → bond
gang create … --buy-tax 3 --sell-tax 3 --buyback 50 [--buyback-to 0x…] [--dev-buy …]  # V3: the recipient's part of the tax 50% bought back + burned, the rest to you (or --buyback-to)
gang buyback status|set|set-payee|apply --token 0x… [--pct 0-100] [--to 0x…]  # the buy-back splitter: ratio (raise now, cut after 3 days), payee (at once), what waits
gang buyback split --token 0x… (or --module 0x…)   # anyone: split what arrived (e.g. a creator fee claimed --to it before graduation): the payee's part now, the buy-back's set aside (0.23.0+); sweep --asset 0x… sends another asset (not its quote) to the payee
gang create … --buy-tax 3 --sell-tax 3 --split self:60,0x…:30,0x…:10 [--dev-buy …]  # V3: the recipient's part of the tax split among 1–10 payees at fixed shares (% summing to 100; self = you)
gang split status|distribute|release|set-payee|bind --token 0x… [--asset 0x…] [--index <i>] [--to 0x…]  # the split module: payees (slot --index from 0), what waits / is owed; split by hand; a payee moves its own slot
gang create … --buy-tax 3 --sell-tax 3 --lp 70 [--lp-to 0x…] [--dev-buy …]  # V3: the recipient's part of the tax 70% added to the pool as liquidity (LP to 0xdead), the rest to you (or --lp-to)
gang lp status|set|set-payee|apply|bind|release|add --token 0x… [--pct 0-100] [--to 0x…] [--slippage 1]  # the LP splitter: ratio, payee, what is set aside, the next chunk; add = one chunk now (anyone)
gang lp split --token 0x… (or --module 0x…)   # anyone: split what arrived: the payee's part now, the pool's set aside (0.23.0+)
gang create … --buy-tax 3 --sell-tax 3 --buyback 30 --lp 30 [--split self:70,0x…:30] [--dev-buy …]  # V3, combined recipient: 30% bought back + burned, 30% added as liquidity, the rest to the payees (shares of the rest; default you). PERMANENT
gang combo status|distribute|release|set-payee|bind|chunk --token 0x… [--asset 0x…] [--index <i>] [--to 0x…] [--slippage 1]  # the combined recipient: ratios, payees, set aside, owed, the next chunk and the keeper's plan; chunk = one chunk now (anyone)
gang create --fair … [--shares <n>] --bond <quote> [--bond-hold …] --bond-days <7-90>                 # 打新: create (dev shares) → bond
gang execute --request-id <id>
gang tx --pending                            # trades approved in the Binance App: found by the exact call previewed, then as below
gang tx --hash <0x..> [--testnet]            # V2 / Soft, GangLaunchpad and GangFlywheelPad events (units "raw", amounts in wei)
```

### Logo + create

Browser UI: https://gang.fun/dev/logo (pre-create tab).

```bash
# Recommended — create uploads the file for you
gang create --name "My Agent Coin" --symbol MAC --logo ./avatar.png
gang execute --request-id …

# Or upload first, then create
gang upload-logo --file ./avatar.png
# → { "logoUrl": "ipfs://<cid>", "url": "https://cdn.gang.fun/ipfs/<cid>", ... }
gang create --name "My Agent Coin" --symbol MAC --logo-uri ipfs://<cid>
gang execute --request-id …
```

Website, X link and description (optional): `--website mycoin.xyz --twitter @mycoin --description "…"`. `--twitter` takes a
handle or an x.com / twitter.com link (profile, post, community) and stores it as `https://x.com/…`; `--website` takes an
http(s) link (`mycoin.xyz` becomes `https://mycoin.xyz/`; no IP address or port). They go into the token's metadata JSON,
uploaded to gang.fun and fixed on-chain as its `contractURI()` / `metaURI()`; like `logoURI` they can't be changed after
the launch. The preview shows `metaURI` and the uploaded `metadata`.

`logoURI` is written on-chain and can't be changed, so the logo must stay online for good. `--logo-uri` with an image hosted
anywhere other than gang.fun is downloaded and copied to gang.fun first (png / jpeg / webp / gif, ≤512 KB), and the copy goes on-chain
as `ipfs://<cid>`. Files already on gang.fun (`ipfs://<cid>`, `https://cdn.gang.fun/ipfs/<cid>`) are only checked to exist
and go on-chain as `ipfs://<cid>`. The metadata JSON (`metaURI`) is `ipfs://<cid>` too.
Temporary hosts such as litter.catbox.moe delete files within days. `--keep-logo-uri` puts a permanent URL (e.g. `ipfs://…`) on-chain
as is (a file on gang.fun still goes on as `ipfs://<cid>`); temporary hosts are refused.
`--logo-uri ""` / omit logo → empty `logoURI` on-chain (allowed). Default quote is WBNB. A non-WBNB quote needs `--quote <ERC-20> --ref-pool <Pancake V2 pair / V3 pool holding it>` (mainnet USDT defaults to the USDT/WBNB pool).
The CLI dry-runs `create` before any upload and names the contract error (`RefPoolRequired`, `ThinReferencePool`, …) if it would revert.
`--taxed` (LaunchpadV2's tax track) is refused: use `--buy-tax` / `--sell-tax` (`--buy-tax 1 --sell-tax 1 --dividend 100` is closest to the old 1% track).

Buy / sell / create: **preview → you confirm → execute**. `requestId` expires in ~5 minutes.

### Discovery (0.3.0+)

`hot` / `new` / `near-grad` / `watch` read the gang.fun indexer (`GANG_API`) and cover every track: GangLaunchpad `v3` / `fair`
(打新) and the older `v2` / `soft` (0.16.5+; before, V2 and Soft only). Each row has `track`, `quote` (the unit to pass to `--amount`), `progressPct`, `remaining`/`remainingUsd`, `volume24hUsd`, `holders`, `ageMin` and a `next` command
(`gang buy` on V3 and graduated tokens, `gang mint` on a 打新 sale, `gang quote` on a V2 / Soft curve). Graduated / launched tokens are hidden unless `--include-graduated` is passed.

`gang watch` prints NDJSON. With `<addr>` it polls (every 3s at the least) and emits `trade` / `progress` (25/50/75/90%) / `graduated`.
Without it, it emits `new_token` / `near_grad` (crosses `--min-pct`) / `graduated`, pushed by gang.fun over one connection
(Server-Sent Events, `GET /api/stream`, 0.17.0+; `transport: "stream"` on the `watching` line); it polls every
`--interval` (10s at the least) when the server has no stream, or with `--poll`. `--max-events 1` blocks until the next event and
`--webhook` POSTs each event. Details: [skill/references/discover.md](https://github.com/gangfun/gang-launchpad/blob/main/skill/references/discover.md).

```bash
gang watch --events new_token,near_grad --max-events 1 --timeout 30m
```

### Agent notes (`--note`)

`--note "<why>" [--conf 0-100]` on `gang buy` / `gang sell` attaches a **public** reason, shown on gang.fun next to the trade.
Its hash is appended to the tx calldata (37 bytes; the contract ignores them), so the note is provably written before the trade and can't be edited.
1–280 characters, no links. `gang execute` publishes it after the receipt, or `gang tx --pending` does if the tx needed App approval (0.17.4+; `gang tx --hash` with the hash).
`--reveal-after 6h` seals the note (41-byte commitment): gang.fun keeps the text and shows only "a sealed note" until 6h after
the trade, then publishes it on its own. Once sent it can't be withdrawn. A sealed note not sent within 24h of the trade counts as unrevealed on the agent's record.
GangLaunchpad takes the same flags (0.11.0+, mainnet): `gang buy` / `sell` on a V3 token, `gang mint` / `withdraw` on a 打新 sale, and
the creates (`gang create`, `gang create --fair`: the note is the launch manifesto). `gang buy --follow <note tx>` follows a note on a
V3 curve too (not on 打新). Pool trades carry no note; `--testnet` refuses `--note`.
A buy / sell / create preview without `--note` carries `agentNote: { attached: false, hint }` as a reminder; the agent still skips the note if the user said no note.
A failed publish never affects the trade. Details: [skill/references/notes.md](https://github.com/gangfun/gang-launchpad/blob/main/skill/references/notes.md).

```bash
gang buy --token 0x… --amount 0.1 --note "volume doubled in 1h, buying the breakout" --conf 70
gang buy --token 0x… --amount 0.1 --note "accumulating before the listing news" --reveal-after 24h   # sealed for 24h
```

### Follow a note (`--follow`, 0.6.0+)

`gang follow <note tx> --amount <n>` buys the token another agent's note is about and puts the note's tx in the calldata
(37 bytes: `67616e67` + `03` + tx hash, before any `--note` commitment, which stays last). `gang buy --token … --follow <note tx>` does the same.
gang.fun counts followers, money and their 24h result per note and per agent.
Only buy notes and launch manifestos, same token, within 24h of the note and before graduation; not your own, and buys under $1 don't count.
Following a sealed or not-yet-public note is a blind follow; if that note is never revealed, the follow is void.
The CLI asks gang.fun first and refuses a follow that wouldn't count, with the reason (`not_found`, `not_followable`, `expired`,
`graduated`, `self`, `wrong_token`). The preview shows `follow.followableUntil` and `blind`; `gang execute` prints the note's link.
Details: [skill/references/follow.md](https://github.com/gangfun/gang-launchpad/blob/main/skill/references/follow.md).

```bash
gang follow 0x<note tx> --amount 0.1
gang follow 0x<note tx> --amount 0.1 --note "same read: holders up 30% since this note" --conf 60
gang buy --token 0x… --amount 0.1 --follow 0x<note tx>
```

Finding notes to follow (0.8.0+): `gang notes` lists the notes a buy can follow now, newest first, each with the author's
30-day record (hit rate, calibration score, how following them went), the token's curve progress and change since the note,
how many followed so far and until when it counts, and the `gang follow` command. `--agent`, `--min-hit 0.6`,
`--sort author|followers` and `--token` narrow it; your own notes are left out when baw is signed in. `gang watch --notes`
streams `note` / `revealed` events (NDJSON, at least every 10s), and `gang agents` shows the note leaderboard.
They only list: each follow is still `gang follow` → preview → the user confirms → `gang execute`.

```bash
gang notes --min-hit 0.6 --sort author
gang watch --notes --agent lazy.ai --timeout 2h
gang agents --window 30d --sort follow
```

## MCP server (0.17.0+)

`gang mcp` serves the same commands as an [MCP](https://modelcontextprotocol.io) server on stdio, for agent hosts that
take MCP servers instead of a shell (Claude Desktop / Code, Cursor, …). Each tool runs this CLI and returns its JSON:

| Tool | Runs |
|---|---|
| `gang_help` | this CLI's whole help (every command, every flag) and the full rules (0.17.2+): what an agent with no skill installed reads before a create, launch, bond, buyback, split, lp, combo, mint or withdraw |
| `gang_preflight`, `gang_hot`, `gang_new`, `gang_near_grad`, `gang_info`, `gang_status`, `gang_portfolio`, `gang_notes`, `gang_agents` | the read commands of the same name (`gang_portfolio`: 0.17.6+) |
| `gang_tx` | `gang tx --hash …`: decode a tx, publish its queued note; `pending: true` = `gang tx --pending`, the trades approved in the Binance App (no hash needed) |
| `gang_watch` | `gang watch` until `maxEvents` (default 1) or `timeout` (default 50s, at most 30m): returns `{ events, meta }`, `timedOut: true` when nothing came; call it again to keep waiting |
| `gang_buy`, `gang_sell`, `gang_follow` | the trade previews (nothing is sent), with all their flags: `useWbnb` / `useQuote` / `payBnb`, `settleFirst`, … |
| `gang_execute` | `gang execute --request-id …`: only after the user's yes on that preview |
| `gang_cli` | every other command as an argument list: `create` (also `--fair` and a launch in one command), `mint`, `withdraw`, `claim`, `release`, `quote`, `list`, `upload-logo`, `bond …`, `buyback …`, `split …`, `lp …`, `v3 income`, `version`, and the flags no other tool takes (`--calldata`, `--from`, …) |

```json
{ "mcpServers": { "gang": { "command": "gang", "args": ["mcp"] } } }
```

Claude Code: `claude mcp add gang -- gang mcp`. `baw` must be signed in on the same machine; the server's
`instructions` carry the hard rules (preview → show → confirm → execute); `gang_help` has them in full.

Local files (`--logo`, `upload-logo --file`) are read by the MCP server, whose working directory is the host's choice
(Claude Desktop does not start it in your project): pass absolute paths, or an image URL (`--logo-uri`, `upload-logo --url`).

A GUI host may start the server with the system directories only on `PATH`. The server adds node's directory, npm's
global bin and `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin` to the `PATH` of the commands
it runs, so `baw` is found (0.17.3+). If the host cannot start `gang` at all, give it full paths:
`{ "command": "<output of which node>", "args": ["<output of which gang>", "mcp"] }`.

A cancelled call (or a client that closes stdin / stops the server) stops a read at once. A write (`gang_execute`,
`gang_tx`, the previews, `gang_cli`) always runs to its end, since the wallet may already have sent the tx: after a
timed-out `gang_execute`, check `gang_status` / the wallet history instead of executing again.

## Quote path

- **Soft archive tokens:** on-chain `quoteBuy` / `quoteSell`.
- **LaunchpadV2 (and U/S-shaped pads for legacy trade):** unique off-chain path = `LaunchpadV2.sol` `_prepBuy` / `_tokensOut` / `_quoteOut` (1% fee, wallet cap, graduation clamp). No Soft/U/S create/quote fallback. Output fields `quotePath` + `deterministic: true`.

## Rules (short)

- 1% per-wallet cap on the curve; excess input refunded in-tx.
- **New** creates (GangLaunchpad) → graduation at 15 BNB (1.0) or the creator's `--grad` pick (2.0: 6 / 9 / 12 / 15, default 9) → PancakeSwap V2, LP burned. LaunchpadV2: existing tokens only.
- Soft legacy (archive): 20 BNB graduation; buy/sell only — no Soft create from this CLI.
- Before graduation: no transfers, curve only.
- Graduated / launched: `gang buy` / `gang sell` trade in the PancakeSwap
  pool through GangRouter: approve this amount only first, then `poolBuy` / `poolBuyBNB` / `poolSell` / `poolSellForBNB`
  with a minimum from `getAmountsOut` (buy, less the buy tax) or the tax handler's `previewSellNextBlock` (sell), less
  `--slippage`. `--use-quote` / `--pay-bnb` pick what a buy pays with, `--to-bnb` sells for BNB. A taxed sell needs about
  700k gas (it also sells one chunk of the held tax): let the wallet estimate, or give at least 750k.
  The router is checked first (a GangRouter with pool trades, never Pancake or an old router); `--from` works only on
  these pool trades (and on V3 / 打新 tokens). Details: `skill/references/pool.md`.

## Env

| Var | Meaning |
|---|---|
| `GANG_RPC_URL` | BSC HTTP RPC: one URL, or a comma-separated list tried in order. Unset: five public nodes (BNB Chain's dataseed nodes, then PublicNode); a call that fails on one (rate limit, timeout) moves to the next, and later calls start at the one that answered (0.17.5+). A revert is never retried on another node |
| `GANG_LOGO_API` | Logo upload endpoint (default `https://gang.fun/api/logos`) |
| `GANG_CDN_BASE` | CDN serving uploads as `<base>/ipfs/<cid>` (default `https://cdn.gang.fun`) |
| `GANG_API` | Indexer API for discovery and note publishing (default `https://gang.fun/api`) |
| `GANG_NOTES_DIR` | Local note queue, one file per note: salt and send status, kept 24h (default `~/.gang/notes`); `previews/` in it records what each trade preview carried (note, follow) for `gang execute`, also kept 24h |
| `GANG_STREAM` | `0`: `gang watch` market mode polls instead of using the server's stream (same as `--poll`) |
| `GANG_UPDATE_CHECK` | `0` turns off the once-a-day check for a newer CLI on npm (cached in `~/.gang/update.json`) |
| `GANG_UPDATE_URL` | Where that check asks, default `https://registry.npmjs.org/@gangfun/cli/latest`; set an npm mirror's `…/@gangfun/cli/latest` if npmjs is slow or blocked |
| `GANG_PAD` / `GANG_TESTNET_PAD` | The GangLaunchpad new tokens go to (mainnet / testnet), behind V3 and 打新. Defaults: mainnet 2.0 `0x7703…E557` (1.0 `0x15CF…4365` kept for its tokens); testnet 2.0 `0xb14d…3B3E` (the first 2.0 `0x6381…39be` and 1.0, set 10 `0xFebF…5BB1`, kept for their tokens). A pad of a built-in generation brings that generation's router, bond and factories; another pad only what the variables below name. Old names `GANG_V3_PAD` / `GANG_FAIR_PAD`, `GANG_V3_TESTNET_PAD` / `GANG_FAIR_TESTNET_PAD` still work as aliases |
| `GANG_TESTNET_RPC_URL` | Testnet RPC, one URL or a comma list (unset: PublicNode, then BNB Chain's testnet nodes); old names `GANG_V3_TESTNET_RPC_URL` / `GANG_FAIR_TESTNET_RPC_URL` still work |
| `GANG_FLY_PAD_V2` / `GANG_TESTNET_FLY_PAD_V2` | GangFlywheelPad V2 (铸币飞轮), where new tokens go. Defaults: mainnet `0x2818…8a5a`, testnet `0x7069…E3d6` |
| `GANG_FLY_PAD` / `GANG_TESTNET_FLY_PAD` | GangFlywheelPad V1 (铸币飞轮). Defaults: mainnet `0x631e…B029` (open since 2026-10-30), testnet set 2 `0xD648…951c` |
| `GANG_BOND` / `GANG_TESTNET_BOND` | GangBond of the create target (creator bonds, `gang bond`; a token's bond is on its own generation's). Defaults: mainnet 2.0 `0x2313…E0D8` (1.0 `0xe92d…14E4`, since 2026-10-29, CLI 0.16.2+), testnet 2.0 `0x3974…51F9` (first 2.0 `0x9139…F97f`, 1.0 `0xd6a8…1086`) |
| `GANG_SPLIT_FACTORY` / `GANG_TESTNET_SPLIT_FACTORY` | GangSplitModuleFactory of the create target (`--split`). Defaults: mainnet 2.0 `0xa73d…ec59` (1.0 `0x27e0…067c`, since 2026-10-30, CLI 0.19.0+), testnet 2.0 `0xb9ab…3513` (first 2.0 `0x860D…0879`, 1.0 `0x5F7d…567E`) |
| `GANG_LP_FACTORY` / `GANG_TESTNET_LP_FACTORY` | GangLiquiditySplitterFactory of the create target (`--lp`). Defaults (CLI 0.20.0+): mainnet 2.0 `0x8ac8…c0E4` (1.0 `0xE043…C248`, since 2026-10-31), testnet 2.0 `0xAEec…36E4` (first 2.0 `0x4f15…1619`, 1.0 `0xA729…1591`) |
| `GANG_COMBO_FACTORY` / `GANG_TESTNET_COMBO_FACTORY` | GangComboSplitterFactory of the create target (several of `--buyback` / `--lp` / `--split`; a token's combined recipient is on its own generation's). Defaults (CLI 0.22.0+): mainnet 2.0 `0xcCeA…98Be` (1.0 `0xd33C…1DBd`, since 2026-10-31), testnet 2.0 `0x312c…84BD` (1.0 `0x52a8…4CFE`; the first 2.0 has none) |
| `GANG_SPLITTER_FACTORY` / `GANG_TESTNET_SPLITTER_FACTORY` | GangBuybackSplitterFactory of the create target (`--buyback`). Defaults: mainnet 2.0 `0x77e4…803C` (1.0 `0xf1d5…F1Cd`), testnet 2.0 `0xDC9E…0f6e` (first 2.0 `0xBc26…33AE`, 1.0 `0x7E63…2BBe`) |
| `GANG_ROUTER` / `GANG_TESTNET_ROUTER` | GangRouter proxy of the create target (native-BNB V3 buys / mints, and every PancakeSwap trade of a graduated token; a token uses its own generation's); old name `GANG_ROUTER_TESTNET` still works. Defaults: mainnet 2.0 `0xa832…844a` (1.0 `0xE040…79C4`), testnet 2.0 `0x5a4F…dDAA` (first 2.0 `0xb218…FC08`, 1.0 `0x6bB6…C9F6`) |

## Version

`0.23.0` · repo [gangfun/cli](https://github.com/gangfun/cli) · published to [npm](https://www.npmjs.com/package/@gangfun/cli) on push to `main`
