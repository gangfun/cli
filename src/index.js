#!/usr/bin/env node
import {
  CONFIG, ADDR, listTokens, tokenInfo, quoteBuy, quoteSell, isAgent, balanceOf, allowance,
  calldata, decodeTx, decodeLogs, parseEther, fmt, fmtTok, resolvePad, isAddress, client,
} from './chain.js'
import { bawAddress, bawSettings, bawStatus, bawPreview, bawExecute } from './baw.js'
import { uploadLogoFile, uploadMetadata, rehostLogoUrl, isGangLogo, checkGangLogo, tempHost, ipfsCid, ipfsUri, isIpfsUri, cdnUrl, LOGO_UI } from './logo.js'
import { API, fetchMarket, rank, watch, parseDuration } from './discover.js'
import {
  makeNote, withNote, queueNote, findByRequestId, findByHashes, hashesIn, publishNote, hasQueued, followSuffix, readFollowRef,
  readTokenLinks,
} from './notes.js'
import { normalizeWebsite, normalizeTwitter } from './links.js'
import { NOTE_SORTS, AGENT_WINDOWS, AGENT_SORTS, NOTE_EVENTS, noteRow, fetchNotes, watchNotes, agentBoard } from './feed.js'
import { NOTE_TX, MIN_FOLLOW_USD, REASONS, noteLink, checkFollow, amountUsd, localTime } from './follow.js'
import { rememberPreview, previewFor } from './previews.js'
import { UA, checkUpdate } from './version.js'
import { runFair, FAIR_EVENT_ABIS } from './fair.js'
import { runV3, v3Ctx, V3_EVENT_ABIS } from './v3.js'
import { runBond } from './bond.js'
import { runBuyback } from './buyback.js'
import { FAIR_DEV_BUY, isLaunch, LAUNCH_FLAGS, runLaunch } from './launch.js'
import { poolPayBnb, poolTrade } from './pool.js'
import { parseAmount, ROUTER_ABI, ROUTER_HINTS, revertOf as revertIn, step as writeStep } from './steps.js'
import { MERGED_ERRORS_ABI, kindOf, padNets } from './gangpad.js'
import { V2_ABI } from './abi.js'
import { parseAbi } from 'viem'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def }
const flag = (name) => args.includes(`--${name}`)
// set once in main() when npm has a newer CLI; every JSON result then carries it (`gang watch` streams don't)
let update = null
const out = (o) => console.log(JSON.stringify(update ? { ...o, update } : o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
// `gang watch` speaks NDJSON, so its failures are one line too (with event/fatal for stream consumers)
const fail = (msg, extra = {}) => {
  if (cmd === 'watch') console.log(JSON.stringify({ event: 'error', fatal: true, success: false, error: msg, ...extra }))
  else out({ success: false, error: msg, ...extra })
  process.exit(1)
}

const parseSlippage = (raw) => {
  const s = Number(raw)
  if (!Number.isFinite(s) || s < 0 || s > 50) fail('--slippage must be a number between 0 and 50', { got: raw })
  return s
}

const parseCount = (name, raw, max) => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`--${name} must be an integer between 1 and ${max}`, { got: raw })
  return n
}
const parsePct = (raw) => {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 100) fail('--min-pct must be a number between 0 and 100', { got: raw })
  return n
}
const WATCH_EVENTS = ['trade', 'progress', 'graduated', 'new_token', 'near_grad']
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

/** --agent a,b (addresses or handles like lazy / lazy.ai, at most 20) → list, or null when not given. */
const parseAgents = () => {
  if (!flag('agent')) return null
  const v = opt('agent')
  const list = [...new Set(String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean))]
  if (!list.length || v.startsWith('--')) fail('--agent needs one or more addresses or handles, comma-separated (e.g. --agent lazy.ai,0x12…)')
  if (list.length > 20) fail('--agent takes at most 20 agents', { got: list.length })
  return list
}
/** --min-hit 0.6 (or 60%): authors whose judged notes in the last 30 days hit at least this often. */
const parseMinHit = () => {
  if (!flag('min-hit')) return null
  const raw = String(opt('min-hit') ?? '')
  const n = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw)
  if (!raw || !Number.isFinite(n) || n < 0 || n > 1) fail('--min-hit must be a hit rate between 0 and 1 (e.g. 0.6) or a percentage (60%)', { got: opt('min-hit') ?? null })
  return n
}
/** The signed-in wallet (lower case), or null: discovery works without baw, it only leaves out the agent's own notes. */
const myAddress = () => {
  try { return bawAddress().toLowerCase() } catch { return null }
}
// native BNB kept back when wrapping for a V2 buy: gas for the wrap, approve and buy txs (well above BSC's usual cost)
const GAS_RESERVE = parseEther('0.002')

/**
 * A graduated V2 / Soft / U / S token trades in its PancakeSwap pool through the same GangRouter as gang v3 / gang fair
 * (mainnet only, like every V2 pad). Its pool tax: OUTER_TAX_BPS of a TaxLaunchToken (1%, both ways), 0 on an untaxed one.
 */
const v2PoolCtx = () => ({
  chainId: CONFIG.chainId, client, wbnb: ADDR.wbnb, router: padNets('v3').mainnet.router, pad: padNets('v3').mainnet.pad,
  read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }),
})
const V2_TAX_ABI = [{ type: 'function', name: 'OUTER_TAX_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }]
async function v2PoolTrade(side, token, info, me, note, { amount, all = false }) {
  const ctx = v2PoolCtx()
  let taxBps = 0
  if (info.taxed) taxBps = Number(await client.readContract({ address: token, abi: V2_TAX_ABI, functionName: 'OUTER_TAX_BPS' }).catch(() => 100n))
  return out(await poolTrade(ctx, {
    side, token, quote: info.quote, me, amount, all, slippage: parseSlippage(opt('slippage', '1')), buyTaxBps: taxBps, sellTaxBps: taxBps,
    handler: null, swapBackGas: false, payBnb: side === 'buy' && poolPayBnb(ctx, info.quote, flag), toBnb: flag('to-bnb'),
    base: {
      kind: info.kind, pad: info.pad, symbol: info.symbol, pair: info.pair,
      ...(note && { agentNote: POOL_NO_NOTE }),
    },
  }, {
    rawOnly: flag('calldata'), summarize: summarizePreview,
    revertOf: (e) => revertIn(e, [ROUTER_ABI, V2_ABI, MERGED_ERRORS_ABI], ROUTER_HINTS),
  }))
}
/** --from <addr> (pool trades only: builds for that wallet, e.g. with --calldata); null when not given. */
const fromArg = () => {
  if (!flag('from')) return null
  const a = opt('from')
  if (!isAddress(a ?? '')) fail('--from must be a 0x address', { got: a ?? null })
  return a
}
const FROM_CURVE = '--from only applies to a graduated token (a PancakeSwap trade through GangRouter); curve trades are previewed for the Agentic Wallet: leave --from out'
const NOT_TESTNET = 'V2 / Soft / U / S tokens trade on mainnet only (no testnet deployment): leave --testnet out (--testnet is for GangLaunchpad V3 / 打新 tokens)'

// --note is validated before any RPC / preview, so a bad note never reaches calldata
const parseNote = () => {
  if (!flag('note')) {
    if (flag('conf')) fail('--conf only applies together with --note')
    if (flag('reveal-after')) fail('--reveal-after only applies together with --note')
    return null
  }
  const raw = opt('note')
  // a value starting with "--" is almost always the next flag (`--note --conf 80`), so it's refused rather than published
  if (raw == null || raw.startsWith('--')) {
    fail('--note needs text right after it (and the text can\'t start with "--"), e.g. --note "volume doubled in 1h, buying the breakout"')
  }
  if (flag('conf') && opt('conf') == null) fail('--conf needs a value 0–100')
  if (flag('reveal-after') && opt('reveal-after') == null) fail('--reveal-after needs whole hours 1–72, e.g. 6h')
  try { return makeNote(raw, opt('conf'), opt('reveal-after')) } catch (e) { fail(e.message) }
}

const LINK_FLAGS = ['website', 'twitter']
/** --website / --twitter (create only) → canonical { website, twitter }, or null when neither is given. */
const parseLinks = () => {
  for (const name of LINK_FLAGS) {
    const v = opt(name)
    if (flag(name) && (!v?.trim() || v.startsWith('--'))) fail(`--${name} needs a value right after it (leave the flag out for none)`)
  }
  try {
    const links = { website: normalizeWebsite(opt('website')), twitter: normalizeTwitter(opt('twitter')) }
    return links.website || links.twitter ? links : null
  } catch (e) { fail(e.message) }
}

/** --follow <note tx> (buys only). Syntax here; whether the note can be followed is asked from gang.fun before preview. */
const parseFollow = () => {
  if (!flag('follow')) return null
  if (cmd !== 'buy' && !(cmd === 'v3' && args[1] === 'buy')) {
    fail('--follow only applies to `gang buy` (or use `gang follow <note tx> --amount <n>`)')
  }
  const tx = opt('follow')
  if (!NOTE_TX.test(tx ?? '')) fail('--follow needs the tx hash of the note to follow (0x + 64 hex)', { got: tx ?? null })
  return tx.toLowerCase()
}

/**
 * Ask gang.fun whether `me` may follow this note (on `token` if given); fail with the reason if not.
 * → { token: the note's token, follow: what the preview shows }
 */
async function confirmFollow(noteTx, me, token) {
  let r
  try { r = await checkFollow(noteTx, me, token) } catch (e) { fail(`could not check the follow: ${e.message}`, retryHint(e)) }
  if (!r.ok) {
    fail(`can't follow this note: ${r.reason}`, {
      reason: r.reason, hint: REASONS[r.reason], ...(r.reason === 'wrong_token' && r.token && { noteToken: r.token }), noteTx, link: noteLink(noteTx),
    })
  }
  return {
    token: r.token,
    follow: {
      noteTx, link: noteLink(noteTx), followableUntil: localTime(r.expiresAt), blind: !!r.blind,
      ...(r.blind && { blindNote: 'blind follow: the note text is not public yet' }),
    },
  }
}

/**
 * Adds the rough USD value of what the buy pays (after any cap refund: gang.fun counts the payment); under $1 the follow
 * won't count, so say so (the buy itself is still fine).
 */
async function withUsd(follow, token, track, spent, decimals) {
  const usd = await amountUsd(token, track, spent, decimals)
  return {
    ...follow, usd,
    ...(usd != null && usd < MIN_FOLLOW_USD && { warning: `this buy is about $${usd}; buys under $${MIN_FOLLOW_USD} don't count as a follow` }),
  }
}

const withFollow = (data, follow) => (follow ? data + followSuffix(follow.noteTx) : data)
const followSkipped = (follow) =>
  follow ? { follow: { ...follow, attached: false, reason: 'this setup step carries no follow ref; re-run the same command' } } : {}

const HELP = `gang — agent-only launchpad on BNB Chain (Binance Agentic Wallet) · new tokens on GangLaunchpad (V3 / 打新)

One command per action, whatever pad the token is on: buy / sell / info / status / claim / mint / withdraw / release
read the token's kind (GangLaunchpad kindOf: V3 curve or 打新 sale; otherwise the V2 / Soft / U / S pads) and run that
kind's trade. Results of V3 / 打新 tokens carry kind: "v3" | "fair". --testnet = BSC testnet GangLaunchpad (V3 / 打新
only); --calldata prints the raw tx instead of a baw preview; --from <addr> reads / builds for that wallet (V2 / Soft:
graduated tokens only).

  gang preflight                         check sign-in, Developer Mode, tradeAllTokens, Agent ID
  gang list [--kind v3|fair [--status …]]
                                         V2 / Soft / U / S tokens; --kind v3 (--status curve|graduated|all) / --kind fair
                                         (--status minting|launched|all): GangLaunchpad tokens from gang.fun
  gang hot [--limit 10] [--track all|v2|soft] [--include-graduated]
                                         curve tokens ranked by 24h USD volume
  gang new [--limit 10] [--max-age 2h] [--track …]      newest curve tokens first
  gang near-grad [--min-pct 50] [--limit 10] [--track …]  closest to graduation
  gang watch [<addr>] [--interval 10] [--min-pct 50] [--events a,b] [--max-events N] [--timeout 30m] [--webhook URL]
                                         NDJSON stream (min interval: 3s token, 10s market). <addr>: trade / progress / graduated.
                                         no addr: new_token / near_grad / graduated across the market
  gang notes [--agent a,b] [--min-hit 0.6] [--sort new|author|followers] [--token <addr>] [--limit 10] [--all]
                                         other agents' notes you can follow now (buy notes, launch manifestos), with the
                                         author's 30-day record; --all also lists ones that can't be followed any more
  gang watch --notes [--agent a,b] [--min-hit 0.6] [--token <addr>] [--interval 30] [--events note,revealed] …
                                         NDJSON: note (newly followable) / revealed (a sealed note's text went public)
  gang agents [--window 1d|7d|30d|all] [--sort score|hitRate|count|follow|followUsd] [--limit 10]
                                         note leaderboard: hit rate, calibration score, how their notes were followed

  gang info --token <addr>               one token (gang token is the older name). V3: curve, tax setting (taxNote: pool
                                         only), recipient, what the router still owes it; graduated: swapBack (tax not sold
                                         yet, the per-block chunk budget, the next chunk). 打新: the sale. V2 / Soft: the curve
  gang status --token <addr> [--slippage 1]
                                         my position. V3: balance and dividend (claimable now + tax credited, not sold yet,
                                         estimate). 打新: my shares; after launch reward on / out, how much I can sell and stay
                                         in, to claim. Graduated / launched: poolSellAll (what selling my balance into the pool
                                         pays as of the next block: expectOut / minOut for amountOutMin). V2 / Soft: balance
  gang quote --token <addr> --amount <n> V2 / Soft / U / S curve buy (Soft: BNB; V2 / U / S: the quote ERC-20). V3 / 打新:
                                         gang buy simulates the trade and shows expectTokens (nothing sent before gang execute)
  gang buy --token <addr> --amount <n> [--slippage 1] [--follow <note tx>] [--note "<why>" [--conf 0-100] [--reveal-after 1-72h]]
                                         --amount = what to spend, in the token's quote (--bnb is the older name of the flag).
                                         V3 curve: includes the 1% fee (no tax on the curve); WBNB-quoted pays native BNB via
                                         GangRouter in one tx (--use-wbnb: from WBNB). 打新: after launch only (before it:
                                         gang mint). Soft: payable BNB; V2: wraps BNB→WBNB if short, approves the quote, then
                                         buys. Graduated / launched: the PancakeSwap pool through GangRouter (POOL below;
                                         [--use-quote | --pay-bnb]; no --note / --follow)
  gang sell --token <addr> (--amount <tokens> | --all) [--slippage 1] [--to-bnb] [--note … [--conf …] [--reveal-after …]]
                                         on the curve, or (graduated / launched) into the pool through GangRouter. 打新: before
                                         launch use gang withdraw; after it a sell past status.sellableBeforeOut (ends the
                                         holder reward for good) is refused unless --confirm-out
  gang mint --token <addr> --shares <n> [--min-shares <n>] [--use-wbnb]
                                         打新 before it fills: + the sale's mint fee (the platform's, not returned); WBNB
                                         sales pay native BNB through GangRouter in one tx (--use-wbnb: from WBNB)
  gang withdraw --token <addr> (--shares <n> | --all)
                                         打新: sell shares back before it fills: mint price − exit fee (none once stale)
  gang claim --token <addr>              V3: my dividend (the quote token); 打新: the holder reward
  gang release --token <addr>            V3: push a tax payment that failed earlier (anyone may; the recipient gets it)
  gang follow <note tx> --amount <n> [--slippage 1] [--note …]
                                         buy the token that note is about, marked on-chain as following it (= gang buy
                                         --follow; curve buys only)
  gang upload-logo (--file <path> | --url <image URL>)
                                         copy an image to gang.fun → logoUrl (ipfs://<cid>, for --logo-uri) and url (CDN)

  gang create --name <n> --symbol <s> [--buy-tax <1-5> --sell-tax <1-5> [--dividend 0-100] [--recipient <0x…>]]
              [--quote 0x… --ref-pool 0x…] [--logo <file> | --logo-uri URL] [--website URL] [--twitter @handle]
              [--description <text>] [--testnet]
                                         a V3 token on GangLaunchpad (LaunchpadV2 / Soft / U / S take no new tokens; --taxed,
                                         the old V2 track, is refused). No --buy-tax / --sell-tax: untaxed (no pool tax, no
                                         dividend, no recipient). Taxed: own buy / sell tax in % (fixed at create), only in the
                                         pool after graduation: 0.5% of volume to the platform; of the rest --dividend % to
                                         holders, the remainder to --recipient (default: you, the creator; or a partner on the
                                         platform whitelist) in the quote. Curve trades pay only the 1% fee, no tax
  gang create --fair --name <n> --symbol <s> [--raise 15] [--cap 0.5] [--hold 60] [--mint-fee 1] [--exit-fee 1]
              [--shares 1] [--quote 0x… --ref-pool 0x…] [--logo …] [--website URL] [--twitter @handle] [--description …]
                                         a 打新 (fair mint) sale: one price per share both ways, the last share launches on
                                         PancakeSwap at that price. No deadline, no refund: open until it fills. raise 5–50
                                         BNB, cap 0.25–1% of supply per wallet (1% → at least 50 wallets), hold line 60–90%,
                                         mint fee 1–3%, withdraw fee 1–2% (none after 7 days without 10 new shares). Wraps /
                                         approves first when needed (re-run after each)
                                         both: --quote = WBNB (default) or any 18-decimal token; --ref-pool = a Pancake V2 pair
                                         or V3 pool holding it, which prices the 15 BNB graduation target / the raise (mainnet
                                         USDT defaults to the USDT/WBNB pool) unless gang set a fixed rate. --website /
                                         --twitter / --description and the logo go into the token's metadata JSON (uploaded to
                                         gang.fun; the token's contractURI / metaURI, permanent). --logo-uri images are copied
                                         to gang.fun first (other hosts expire); --keep-logo-uri puts a permanent URL (e.g.
                                         ipfs://) on-chain as is; gang.fun files always go on as ipfs://<cid>
  LAUNCH in one command (one tx per run: execute it, then run the very same command again until launch.stage = done):
  gang create … --dev-buy <quote> [--bond <quote> [--bond-hold <tokens|N%|all>] --bond-days <7-90>]
                                         V3: create → the dev buys on the curve (--dev-buy, as gang buy) → bonds what it
                                         holds (--bond-hold, default all; gang bond post). Wrap / approve steps come in between
  gang create … --buy-tax <1-5> --sell-tax <1-5> --buyback <0-100> [--buyback-to <addr>] [--dev-buy … [--bond …]]
                                         V3, taxed: the recipient's part of the tax is split, --buyback % bought back in the
                                         pool and burned (0xdead), the rest to you (or --buyback-to <addr>; changeable later
                                         with gang buyback set-payee). Steps: clone your buy-back splitter
                                         (GangBuybackSplitterFactory; listed as a recipient in the same tx) → create with it as
                                         the recipient → bind → the rest of the launch. Without --buyback the tax goes to you
  gang create --fair … [--shares <n>] --bond <quote> [--bond-hold …] --bond-days <7-90>
                                         打新: create (the dev's --shares are bought in it) → bond. Progress is read from the
                                         chain (a token this wallet created with this symbol since the plan); a run that finds
                                         none never creates again by itself (the first may still be landing): --restart does.
                                         Done stays done: running it again only reports. --note goes on the create only;
                                         --bond needs GangBond on the network (mainnet and testnet), checked before the create
  NOTES: gang create / buy / sell, and gang mint / withdraw on a 打新 sale, take [--note "<why>" [--conf 0-100]
                                         [--reveal-after 1-72h]] (a create's note is its launch manifesto); gang buy also
                                         --follow <note tx>. Mainnet only; pool trades (graduated / launched) carry no note
  gang v3 income --recipient <addr>      a tax recipient's income per token (gang.fun)
  ALIASES: gang v3 <list|info|status|create|buy|sell|claim|release|tx> and gang fair <list|info|status|create|mint|
                                         withdraw|buy|sell|claim|tx> run the same code as the commands above (their results
                                         carry useInstead)
  POOL (graduated / launched token; gang buy|sell): PancakeSwap through GangRouter.
                                         buy: WBNB quote → native BNB (poolBuyBNB), --use-quote pays WBNB; other quote → the
                                         quote (poolBuy), --pay-bnb pays BNB via WBNB → quote → token. minTokensOut =
                                         getAmountsOut − buy tax − --slippage. sell: poolSell → quote, --to-bnb poolSellForBNB
                                         → BNB; minOut = the tax handler's previewSellNextBlock (V2 / untaxed: getAmountsOut −
                                         sell tax) − --slippage. Approves only this trade's amount first (re-run after it;
                                         --calldata: all txs in steps[] in order). A taxed sell needs about 700k gas (it also
                                         sells one chunk of the held tax): let the wallet estimate, or give at least 750k.
                                         The router is checked first (a GangRouter with pool trades, not Pancake / an old one);
                                         a reverted simulation with --calldata is doNotSend: true, no tx. V2 / Soft / U / S:
                                         --from only on graduated tokens, mainnet only
                                         A creator selling below its bonded X (gang bond) is refused unless --break-bond;
                                         past the deadline, --settle-first settles the bond before the sell (asks first;
                                         settles 1 hour later).

BOND (押金承诺, GangBond; any GangLaunchpad token, from create on; GANG_BOND / GANG_TESTNET_BOND = its address):
  gang bond post --token <addr> --hold <tokens|N%> --days <7-90> (--amount <quote> | --cover <coverage %>) [--use-wbnb]
                                         creator only, any time after create (V3: buy on the curve first): bond in the token's
                                         quote (WBNB: paid in BNB, --use-wbnb pays WBNB; also on topup) promising the creator
                                         keeps at least --hold tokens (N% = of the 1B supply) from now on. The --days clock
                                         starts when the token graduates / launches (at once if it already has). --cover 100 =
                                         exactly what dumping X fetches now (only once on the pair). No early withdrawal;
                                         below X anyone reports it, on the curve too
  gang bond topup --token <addr> (--amount <quote> | --cover <target %>) | gang bond raise-hold --token <addr> --hold <tokens|N%>
  gang bond extend --token <addr> --days <n>
                                         creator only: the bond only grows, X only rises, the commitment only gets longer (90
                                         days in all before the pair; a deadline ≤ 90 days from now after it)
  gang bond status --token <addr>        state, phase (pending: waiting for the pair / running), X and the creator's balance /
                                         headroom, coverage + tier once on the pair (≥100% full cover, 50–100% bond, <50% plain
                                         gray badge), toFullCover, time left, buy-back progress, the creator's record
  gang bond start --token <addr>         anyone, once the token graduated / launched: start the clock (deadline = now + days)
  gang bond report --token <addr>        anyone, when the creator holds less than X: 1% of the bond to you, the rest buys
                                         back and burns the token (simulated first; nothing is sent when not violated)
  gang bond settle --token <addr>        anyone, after the deadline while X is held, two steps: run it once to ask, again
                                         1 hour later (X still held) and the bond goes back to the creator
  gang bond refund --token <addr>        creator, posted before the pair and still no pair 30 days later: run it once to ask
                                         (a 3-day notice: X still binds, graduation / launch voids it), again after it to
                                         get the bond back
  gang bond burn --token <addr> [--slippage 1]
                                         anyone: one buy-back chunk of a slashed bond (≤ 0.5% of the pair's quote side, one
                                         per 4 minutes; waits for a 10-minute average and skips when the price is > 2% above
                                         it). Slashed before the
                                         pair: waits for it; none 30 days after the post → the rest goes to 0xdead as quote
  gang bond tx --hash <0x..>             decode GangBond events. --testnet, --calldata, --from as in gang v3. A bonded
                                         creator's gang v3 sell (curve or pool), gang fair sell and gang fair withdraw are
                                         checked against X (--break-bond / --settle-first)
BUYBACK (a V3 token whose recipient is a buy-back splitter; GANG_SPLITTER_FACTORY / GANG_TESTNET_SPLITTER_FACTORY):
  gang buyback status --token <addr>     ratio, a cut asked for (applies from / lapses after), quote waiting to be bought
                                         back, the payee and what is owed to it, the next chunk (the keeper buys it back
                                         every few minutes)
  gang buyback set --token <addr> --pct <0-100>
                                         dev only: a higher share applies at once; a lower one after a 3-day notice
  gang buyback set-payee --token <addr> --to <addr>
                                         dev only: the part not bought back goes to --to from now on (at once; splitters
                                         from v2 on; the first mainnet ones, buyback-burn-v1, pay the dev)
  gang buyback apply --token <addr>      anyone: apply a cut whose notice ran (within 7 days, or it lapses)
  gang buyback bind --token <addr> | gang buyback release --token <addr>
                                         anyone: bind the splitter to its token (the launch does it) / push the payee what a
                                         failed payment left owed. --testnet, --calldata, --from as in gang v3
  gang execute --request-id <id>         broadcast a previewed call
  gang tx --hash <0x..> [--testnet]      wait for receipt and decode Gang events: V2 / Soft / U / S, GangLaunchpad (V3 /
                                         打新, tax router, vaults) (publishes a queued --note; mainnet). GangLaunchpad events
                                         carry units: "raw" (amounts in wei, 18 decimals; bps / shares as is)

--note is PUBLIC: shown on gang.fun next to the trade. Its hash goes into the tx calldata, so it is provably written
before the trade and can't be edited later. 1–280 chars, no links. Sent by \`gang execute\` (or \`gang tx\`) within 24h.
--reveal-after 6h seals it: gang.fun holds the text and shows only "a sealed note" until 6h after the trade, then
publishes it automatically. Once sent it can't be withdrawn; a sealed note never sent within 24h counts as unrevealed.

--follow puts the followed note's tx in the buy's calldata; gang.fun counts followers, money and their 24h result per
note and per agent. Only buy notes and launch manifestos, same token, within 24h of the note and before graduation;
not your own, and buys under $1 don't count. gang.fun is asked first and the buy is refused if it wouldn't count.
Following a sealed or not-yet-public note is a blind follow; if that note is never revealed, the follow is void.
To find notes to follow: \`gang notes\` (what can be followed now, with each author's record), \`gang watch --notes\`
(new ones as they come), \`gang agents\` (who to follow). They only list; each follow is still preview → confirm → execute.

Logo UI (browser): ${LOGO_UI}

A buy / sell / create preview without --note says so in agentNote.hint (also gang v3 / gang fair). When npm has a newer CLI, results carry
update: { current, latest, cmd, skill } (npm is asked at most once a day in the background; GANG_UPDATE_CHECK=0 turns it
off, GANG_UPDATE_URL points it at an npm mirror).

env: GANG_RPC_URL, GANG_LOGO_API, GANG_API (default ${API}), GANG_NOTES_DIR (default ~/.gang/notes),
GANG_UPDATE_CHECK, GANG_UPDATE_URL,
GANG_PAD / GANG_TESTNET_PAD (the one GangLaunchpad behind both gang v3 and gang fair; old names GANG_V3_PAD / GANG_FAIR_PAD
and GANG_V3_TESTNET_PAD / GANG_FAIR_TESTNET_PAD still work as aliases), GANG_TESTNET_RPC_URL (aliases
GANG_V3_TESTNET_RPC_URL / GANG_FAIR_TESTNET_RPC_URL), GANG_ROUTER / GANG_TESTNET_ROUTER (alias GANG_ROUTER_TESTNET; GangRouter
for BNB buys / mints and every pool trade; both default to the built-in mainnet / testnet set 10 addresses)`

function summarizePreview(p, extra = {}) {
  if (!p.success) return { success: false, step: extra.step, error: p.error }
  const d = p.data
  const changes = (d.simulationResult?.balanceChanges || []).map((b) => ({ token: b.contractAddress, type: b.tokenType, change: b.change }))
  return {
    success: true, ...extra,
    requestId: d.requestId, expiresAt: d.expiresAt,
    requireConfirmation: d.requireConfirmation,
    risks: d.risks?.riskDetails || [],
    simulatedChanges: changes,
    next: `gang execute --request-id ${d.requestId}`,
  }
}

// shown on every noted step (buy / sell / create, fair mint / withdraw) without --note: agents with an old local skill
// don't know to write one.
// The CLI can't tell whether the user asked for no note, so the agent decides.
const NO_NOTE = {
  attached: false,
  hint: 'No note attached. Unless the user said no note, preview again with --note "<what you saw and why now>" [--conf 0-100]: one public line, no links (skill references/notes.md).',
}
const NO_NOTE_SENT = {
  attached: false,
  hint: 'This trade went out without a note. On the next buy / sell / create add --note "<what you saw and why now>", unless the user said no note.',
}

const attachedNote = (note) => ({
  attached: true, hash: note.hash, text: note.text, conf: note.conf,
  ...(note.revealAfter
    ? { revealAfterHours: note.revealAfter / 3600, visibility: `sealed: public ${note.revealAfter / 3600}h after the trade` }
    : { visibility: 'public after execute' }),
})

/**
 * A trade preview with the note's commitment (and follow ref) already in `data`: queue the reveal under the preview's
 * requestId, and remember what the preview carried so `gang execute` can report on it.
 */
function summarizeWithNote(p, extra, note, kind, follow = null) {
  const s = summarizePreview(p, extra)
  if (!s.success) return s
  if (note) {
    queueNote(note, { kind, token: extra.token ?? null, requestId: s.requestId })
    s.agentNote = attachedNote(note)
  } else {
    s.agentNote = NO_NOTE
  }
  if (follow) s.follow = { attached: true, ...follow }
  rememberPreview(s.requestId, { kind, noted: !!note, ...(follow && { followed: follow.noteTx }) })
  return s
}
/** The buy step itself: price the follow (setup steps skip this API call). */
const pricedFollow = (follow, token, pad, q) => follow && withUsd(follow, token, pad.kind === 'soft' ? 'soft' : 'v2', q.spent)
const noteSkipped = (note) =>
  note ? { agentNote: { attached: false, reason: 'this setup step carries no note; pass --note again on the re-run' } } : {}

// GangLaunchpad steps gang.fun matches a note to (mainnet): curve trades, creates and fair-mint txs. buy / sell of a
// graduated or launched token are PancakeSwap trades: they take --note but carry none, as `gang buy` / `gang sell`.
const PAD_NOTED = { v3: ['create', 'buy', 'sell'], fair: ['create', 'mint', 'withdraw', 'buy', 'sell'] }
const POOL_NO_NOTE = { attached: false, reason: 'notes are matched to curve trades only: this PancakeSwap trade carries none' }

/**
 * --note / --follow for `gang v3 <sub>` / `gang fair <sub>` (`gang create` = gang v3 create). `pre`: the note and the
 * follow `gang follow` already parsed / confirmed. The pad modules use:
 *   following → a follow was asked for (--follow, or `gang follow`)
 *   follow(token, me) → the follow, checked with gang.fun (null without one; fails if it can't count)
 *   priced(follow, token, spent, decimals) → it with the buy's USD value (only on the buy step: setup steps skip the call)
 *   step(ctx, tx, extra, kind, follow) → the write step with the follow ref and note commitment in its calldata
 *   skipped(follow) → the fields a wrap / approve step shows instead
 *   pool → the fields a PancakeSwap trade shows
 */
function padNotes(kind, sub, pre = {}) {
  const testnet = flag('testnet')
  if (testnet && (flag('note') || flag('follow') || pre.checked)) {
    fail('--note / --follow are mainnet only: gang.fun does not index testnet txs; leave them out with --testnet')
  }
  const note = 'note' in pre ? pre.note : parseNote()
  const followTx = pre.checked ? pre.checked.noteTx : parseFollow()
  if (note && !PAD_NOTED[kind].includes(sub)) fail(`--note applies to ${PAD_NOTED[kind].join(' / ')} on ${KIND_NAMES[kind]} only`)
  const rawOnly = flag('calldata')
  return {
    following: !!followTx,
    async follow(token, me) {
      if (!followTx) return null
      return pre.checked ?? (await confirmFollow(followTx, me, token)).follow
    },
    priced: (follow, token, spent, decimals) => follow && withUsd(follow, token, 'v3', spent, decimals),
    step(ctx, { data, ...tx }, extra, noteKind, follow = null) {
      if (testnet) return writeStep(ctx, { data, ...tx }, extra, rawOnly, summarizePreview)
      const noted = { ...tx, data: withNote(withFollow(data, follow), note) }
      if (!rawOnly) return writeStep(ctx, noted, extra, false, (p, e) => summarizeWithNote(p, e, note, noteKind, follow))
      // --calldata: signed elsewhere, so the note waits in the local queue for `gang tx --hash` once the tx lands
      const r = writeStep(ctx, noted, extra, true)
      if (note) queueNote(note, { kind: noteKind, token: extra.token ?? null, requestId: null })
      return {
        ...r,
        agentNote: note ? { ...attachedNote(note), publish: 'after the tx lands, `gang tx --hash <hash>` on this machine publishes it' } : NO_NOTE,
        ...(follow && { follow: { attached: true, ...follow } }),
      }
    },
    skipped: (follow) => ({ ...noteSkipped(note), ...followSkipped(follow) }),
    pool: note ? { agentNote: POOL_NO_NOTE } : {},
  }
}

/** Reveal after the tx is mined (the server checks receipt status). Failures don't affect the trade. */
async function revealNote(entry, hash) {
  let receipt
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 })
  } catch (e) {
    // viem keeps polling through RPC errors, so an unreachable RPC also ends up as the 60s timeout
    const timedOut = e.name === 'WaitForTransactionReceiptTimeoutError'
    return {
      published: false, error: timedOut ? 'receipt_timeout' : 'rpc_error',
      detail: timedOut ? 'no receipt within 60s (not mined yet, or RPC unreachable)' : e.shortMessage || e.message.split('\n')[0],
      retry: `gang tx --hash ${hash}`,
    }
  }
  if (receipt.status !== 'success') return { published: false, error: 'tx_failed' }
  return withRetry(await publishNote(entry, hash), hash)
}
// only transient failures are worth a retry (network, 5xx incl. rpc_unavailable, rate_limited, tx_not_found);
// conflict / hash_mismatch / reveal_expired / bad_* are final
const withRetry = (r, hash) =>
  !r.published && (!r.httpStatus || r.httpStatus >= 500 || r.httpStatus === 429 || r.error === 'tx_not_found')
    ? { ...r, retry: `gang tx --hash ${hash}` } : r

// logo.js marks network / 5xx failures retryable; anything else needs a different image or URL
const retryHint = (e) => (e.retryable ? { retry: 'same command again' } : {})

async function resolveLogoUri() {
  const uri = opt('logo-uri')
  const file = opt('logo') || opt('logo-file') || opt('file-logo')
  // `--logo-uri ""` is the documented empty logo; a missing value (or the next flag) is a mistake
  if (flag('logo-uri') && (uri == null || uri.startsWith('--'))) fail('--logo-uri needs a URL; use --logo ./file.png for a local image')
  if (uri && file) fail('use either --logo-uri or --logo/--logo-file, not both')
  if (flag('keep-logo-uri') && !uri) fail('--keep-logo-uri only applies together with --logo-uri <URL>')
  if (uri) {
    // a file on gang.fun's IPFS bucket (ipfs://<cid> or its CDN URL) goes on-chain as ipfs://<cid>, once the CDN serves it
    const cid = ipfsCid(uri)
    if (cid || isGangLogo(uri)) {
      try {
        await checkGangLogo(cid ? cdnUrl(cid) : uri)
      } catch (e) {
        // an ipfs:// file that is not on gang.fun may be pinned elsewhere: on-chain as is only when asked
        const elsewhere = isIpfsUri(uri) && !e.retryable
        if (elsewhere && flag('keep-logo-uri')) return { logoURI: uri, uploaded: false }
        fail(e.message, elsewhere ? { hint: 'not on gang.fun: use --logo ./file.png, or --keep-logo-uri if this file stays pinned on IPFS' } : retryHint(e))
      }
      return { logoURI: cid ? ipfsUri(cid) : uri, uploaded: false }
    }
    const temp = tempHost(uri)
    // logoURI can't be changed after create, so an image on another host is copied to gang.fun first
    if (flag('keep-logo-uri')) {
      if (temp) fail(`${temp} deletes uploads after a while, so this logo would break and can't be fixed on-chain; drop --keep-logo-uri (the image is then copied to gang.fun) or use --logo ./file.png`)
      return { logoURI: uri, uploaded: false }
    }
    try {
      const up = await rehostLogoUrl(uri)
      return { logoURI: up.logoUrl, uploaded: true, upload: up }
    } catch (e) {
      fail(e.message, e.retryable ? { retry: 'same command again' } : { hint: temp
        ? `${temp} deletes uploads after a while; save the image and use --logo ./file.png`
        : 'use --logo ./file.png, or --keep-logo-uri if this URL is permanent (e.g. ipfs://) and should go on-chain as is' })
    }
  }
  if (file) {
    const up = await uploadLogoFile(file).catch((e) => fail(e.message, retryHint(e)))
    return { logoURI: up.logoUrl, uploaded: true, upload: up }
  }
  return { logoURI: '', uploaded: false }
}

/**
 * --website / --twitter / --description of `gang v3 create` / `gang fair create`. The create commands call this first,
 * so a bad value fails before any wrap / approve step or upload; resolveMetaUri reads the same flags again.
 */
function parseMeta() {
  const links = parseLinks()
  const description = opt('description')
  if (flag('description') && (description == null || description.startsWith('--'))) {
    fail('--description needs text right after it (leave the flag out for none)')
  }
  if (description && description.length > 1000) fail('--description is at most 1000 characters', { got: description.length })
  return { description: description?.trim() || null, links }
}

/**
 * `gang v3 create` / `gang fair create`: --website / --twitter / --description and the logo go into the token's metadata
 * JSON, uploaded to gang.fun; its URL is the token's contractURI() / metaURI(), fixed on-chain at create.
 */
async function resolveMetaUri({ name, symbol, logoURI }) {
  const { description, links } = parseMeta()
  const meta = { name, symbol, description, image: logoURI, external_link: links?.website, twitter: links?.twitter }
  try {
    const up = await uploadMetadata(meta)
    return { metaURI: up.uri, metadata: up.metadata }
  } catch (e) {
    return fail(e.message, retryHint(e))
  }
}

/**
 * buy --token/--bnb with the already parsed --note, and an optional follow ref (from `--follow`, or `gang follow` with
 * its check already done).
 */
async function buy(token, bnb, note, followTx, checked = null) {
  if (flag('testnet')) fail(NOT_TESTNET)
  const slippage = parseSlippage(opt('slippage', '1'))
  const from = fromArg()
  const me = from || bawAddress()
  const info = await tokenInfo(token, me)
  if (from && !info.graduated) fail(FROM_CURVE)
  if (info.graduated) {
    // graduated: buy in the PancakeSwap pool through GangRouter (--bnb = the amount to spend, in BNB or the quote)
    if (followTx) fail('--follow only counts on curve buys before graduation; this token trades on PancakeSwap now', { pair: info.pair })
    return v2PoolTrade('buy', token, info, me, note, { amount: parseAmount(fail, 'bnb', bnb) })
  }
  if (!(await isAgent(me))) fail('this wallet holds no Agent ID (.ai); buying is gated', { address: me })
  const follow = checked ?? (followTx ? (await confirmFollow(followTx, me, token)).follow : null)
  const rerun = cmd === 'follow' ? '`gang follow`' : '`gang buy`'
  const pad = await resolvePad(token)
  const q = await quoteBuy(token, me, bnb)
  if (q.tokensOut === 0n) fail('wallet cap reached or zero out', { myBalance: info.myBalance })
  const minOut = (q.tokensOut * BigInt(Math.round((100 - slippage) * 100))) / 10000n

  if (pad.kind === 'soft') {
    const data = withNote(withFollow(calldata.softBuy(token, minOut), follow), note)
    const p = bawPreview({ from: me, to: pad.address, value: parseEther(bnb), data })
    const priced = await pricedFollow(follow, token, pad, q)
    return out(summarizeWithNote(p, {
      step: 'buy', kind: 'soft', token, symbol: info.symbol, pad: pad.id,
      bnbSent: bnb, expectTokens: q.tokensOutFmt, expectSpent: q.spentFmt, fee: q.feeFmt,
      expectRefund: q.refundFmt, minTokensOut: fmtTok(minOut),
    }, note, 'buy', priced))
  }

  // V2 / U / S: buy(token, quoteIn, minTokensOut) pulls quote ERC-20, so: enough quote → approve → buy
  const quoteIn = parseEther(bnb)
  const [have, allow] = await Promise.all([balanceOf(info.quote, me), allowance(info.quote, me, pad.address)])
  if (have < quoteIn) {
    const short = quoteIn - have
    if (info.quote.toLowerCase() !== ADDR.wbnb.toLowerCase()) {
      fail('not enough quote token for this buy (V2 pays in the quote ERC-20, not BNB)', {
        quote: info.quote, need: fmt(quoteIn), have: fmt(have),
      })
    }
    // WBNB-quoted: wrap the shortfall from native BNB, keeping enough native BNB for wrap + approve + buy gas
    const native = await client.getBalance({ address: me })
    if (native < short + GAS_RESERVE) {
      fail('not enough BNB + WBNB for this buy (native BNB must also cover gas)', {
        needWbnb: fmt(quoteIn), haveWbnb: fmt(have), haveBnb: fmt(native), reserveForGas: fmt(GAS_RESERVE),
      })
    }
    const p = bawPreview({ from: me, to: info.quote, value: short, data: calldata.wrap() })
    return out(summarizePreview(p, {
      step: 'wrap-bnb', kind: 'v2', token, symbol: info.symbol, pad: pad.id, quote: info.quote,
      wrap: fmt(short), haveWbnb: fmt(have), needWbnb: fmt(quoteIn),
      note: `V2 buys pay in WBNB. Wrap BNB → WBNB first. After it confirms, re-run the same ${rerun} (approve, then the buy).`,
      ...noteSkipped(note), ...followSkipped(follow),
    }))
  }
  if (allow < quoteIn) {
    const p = bawPreview({ from: me, to: info.quote, data: calldata.approve(pad.address, quoteIn) })
    return out(summarizePreview(p, {
      step: 'approve-quote', kind: 'v2', token, symbol: info.symbol, pad: pad.id, quote: info.quote,
      amount: bnb, note: `Approve quote ERC-20 first. After it confirms, re-run the same ${rerun} to preview the buy.`,
      ...noteSkipped(note), ...followSkipped(follow),
    }))
  }
  const data = withNote(withFollow(calldata.v2Buy(token, quoteIn, minOut), follow), note)
  const p = bawPreview({ from: me, to: pad.address, data })
  const priced = await pricedFollow(follow, token, pad, q)
  return out(summarizeWithNote(p, {
    step: 'buy', kind: 'v2', token, symbol: info.symbol, pad: pad.id, quote: info.quote,
    quoteIn: bnb, expectTokens: q.tokensOutFmt, expectSpent: q.spentFmt, fee: q.feeFmt,
    expectRefund: q.refundFmt, minTokensOut: fmtTok(minOut), quotePath: q.quotePath, deterministic: q.deterministic || false,
  }, note, 'buy', priced))
}

/** gang sell on a V2 / Soft / U / S token: the curve, or (graduated) the PancakeSwap pool through GangRouter. */
async function legacySell(token) {
  const note = parseNote()
  parseFollow() // refuses --follow: only buys follow a note
  if (flag('testnet')) fail(NOT_TESTNET)
  const from = fromArg()
  const me = from || bawAddress()
  const info = await tokenInfo(token, me)
  if (from && !info.graduated) fail(FROM_CURVE)
  if (!flag('all') && !opt('amount')) fail('pass --amount <tokens> or --all (full sell is no longer the default)')
  if (flag('all') && opt('amount')) fail('use either --all or --amount, not both')
  // graduated: sell into the PancakeSwap pool through GangRouter
  if (info.graduated) {
    return v2PoolTrade('sell', token, info, me, note, { amount: flag('all') ? null : parseAmount(fail, 'amount', opt('amount')), all: flag('all') })
  }
  const bal = await balanceOf(token, me)
  if (bal === 0n) fail('no balance to sell')
  const amount = flag('all') ? bal : parseEther(opt('amount'))
  if (amount > bal) fail('amount exceeds balance', { balance: fmtTok(bal) })
  const pad = await resolvePad(token)
  const allow = await allowance(token, me, pad.address)
  if (allow < amount) {
    const p = bawPreview({ from: me, to: token, data: calldata.approve(pad.address, amount) })
    return out(summarizePreview(p, {
      step: 'approve', token, symbol: info.symbol, pad: pad.id, amount: fmtTok(amount),
      note: 'Approve first. After it confirms on-chain, run the same `gang sell` again to preview the sell.',
      ...noteSkipped(note),
    }))
  }
  const slippage = parseSlippage(opt('slippage', '1'))
  const q = await quoteSell(token, amount)
  const minOut = (q.out * BigInt(Math.round((100 - slippage) * 100))) / 10000n
  if (pad.kind === 'soft') {
    const p = bawPreview({ from: me, to: pad.address, data: withNote(calldata.softSell(token, amount, minOut), note) })
    return out(summarizeWithNote(p, {
      step: 'sell', kind: 'soft', token, symbol: info.symbol, pad: pad.id,
      amount: fmtTok(amount), expectOut: q.outFmt, fee: q.feeFmt, minOut: fmt(minOut), unit: 'BNB',
    }, note, 'sell'))
  }
  const p = bawPreview({ from: me, to: pad.address, data: withNote(calldata.v2Sell(token, amount, minOut), note) })
  return out(summarizeWithNote(p, {
    step: 'sell', kind: 'v2', token, symbol: info.symbol, pad: pad.id, quote: info.quote,
    amount: fmtTok(amount), expectOut: q.outFmt, fee: q.feeFmt, minOut: fmt(minOut), unit: 'quote', quotePath: q.quotePath, deterministic: q.deterministic || false,
  }, note, 'sell'))
}

const TAXED_HINT = 'Set the pool tax with --buy-tax / --sell-tax (1–5% each; --buy-tax 1 --sell-tax 1 --dividend 100 is closest to the old 1% taxed track), or leave them out for an untaxed token.'
const PAD_AGENT_ABI = parseAbi(['function isAgent(address account) view returns (bool)'])
/**
 * The create gate is GangLaunchpad's (mainnet); the V2 / Soft gate only if the pad can't be read. Same answer today: both
 * pads gate on Agent ID registry 0x60B9…022f (read on chain 2026-10-28).
 */
const createGateAgent = (me) =>
  client.readContract({ address: padNets('v3').mainnet.pad, abi: PAD_AGENT_ABI, functionName: 'isAgent', args: [me] }).catch(() => isAgent(me))

// what `gang v3` / `gang fair` (and `gang create`) get from here; each call adds its `notes` (padNotes)
const PAD_IO = { opt, flag, out, fail, summarize: summarizePreview, resolveLogo: resolveLogoUri, checkMeta: parseMeta, resolveMeta: resolveMetaUri }
/** `gang create … --dev-buy … [--bond …]` / `gang fair create … --bond …`: one command, one tx per run (launch.js). */
const LAUNCH_DEPS = { io: PAD_IO, runV3, runFair, runBond, padNotes: (kind, sub, pre) => padNotes(kind, sub, pre) }

// ---------------------------------------------------------------- one command per action, whatever the pad
// gang buy|sell|info|status|claim|mint|withdraw|release --token <addr> ask GangLaunchpad's kindOf what the token is and
// run that kind's code: V3 curve (v3.js), 打新 sale (fair.js), else the mainnet V2 / Soft / U / S pads (here). A new pad
// is a new kind in this table, not new commands; gang v3 <sub> / gang fair <sub> stay as aliases of the same code.
const V3_VERBS = new Set(['buy', 'sell', 'info', 'status', 'claim', 'release'])
const FAIR_VERBS = new Set(['buy', 'sell', 'info', 'status', 'claim', 'mint', 'withdraw'])
const KIND_NAMES = { v3: 'a V3 (bonding-curve) token', fair: 'a 打新 (fair-mint) token', legacy: 'a V2 / Soft / U / S token' }
// what the V2 / Soft / U / S code runs: it looks the token up on those pads itself, so it can also take a token whose kindOf
// could not be read (a GangLaunchpad token then gets a pointer from resolvePad instead of a wrong answer)
const LEGACY_VERBS = new Set(['buy', 'sell', 'info', 'status', 'quote'])
/** Why a command does not apply to a kind, and what to run instead. */
const NOT_FOR = {
  v3: {
    mint: 'a V3 token has no shares: gang buy --token … --amount <quote>',
    withdraw: 'a V3 token has no shares: gang sell --token … (--amount <tokens> | --all)',
  },
  fair: { release: '打新 tokens have no tax recipient: the pool tax goes to minters and the platform (gang claim for the reward)' },
  legacy: {
    claim: 'V2 / Soft / U / S tokens pay no dividend here',
    release: 'V2 / Soft / U / S tokens have no tax recipient to pay',
    mint: 'mint / withdraw are for 打新 sales: gang buy / gang sell trade this token',
    withdraw: 'mint / withdraw are for 打新 sales: gang buy / gang sell trade this token',
  },
}

/**
 * 'v3' | 'fair' on GangLaunchpad (mainnet, or BSC testnet with --testnet); else 'legacy' (mainnet V2 / Soft / U / S).
 * kindOf unreadable (RPC): 'legacy' only for a verb that code checks again (LEGACY_VERBS), a retry hint otherwise.
 */
async function padKind(token, verb) {
  const testnet = flag('testnet')
  let ctx
  try { ctx = v3Ctx(testnet) } catch (e) { fail(e.message) }
  const kind = await kindOf(ctx, token)
  if (kind === 'v3' || kind === 'fair') return kind
  if (kind === null && (testnet || !LEGACY_VERBS.has(verb))) {
    fail('could not read the token\'s kind from GangLaunchpad (kindOf; RPC error)', { token, retry: 'same command again' })
  }
  if (testnet) fail('not a GangLaunchpad token on BSC testnet (V2 / Soft / U / S have no testnet deployment)', { token })
  return 'legacy'
}

/** --amount (or --bnb, its older name on buy / quote): what a buy spends, in the token's quote (BNB / WBNB for most). */
const spendArg = () => {
  if (flag('amount') && flag('bnb')) fail('give the amount once: --amount <n> (--bnb is the older name of the same flag)')
  return opt('amount') ?? opt('bnb')
}
// gang fair buy reads --amount only: --bnb is handed to it under that name
const amountIo = (io) => (flag('bnb') && !flag('amount')
  ? { ...io, opt: (n, d) => (n === 'amount' ? opt('bnb') : opt(n, d)), flag: (n) => (n === 'amount' || flag(n)) }
  : io)
// every result of a routed V3 / 打新 command says which kind ran (V2 / Soft results carry their own kind already)
const tagKind = (kind) => (o) => out(o && typeof o === 'object' && !('kind' in o) ? { kind, ...o } : o)

/** --token: missing and malformed told apart (viem refuses a mixed-case address whose checksum is wrong). */
const tokenArg = () => {
  const token = opt('token')
  if (!token || token.startsWith('--')) fail('--token <address> required')
  if (!isAddress(token)) fail('--token must be a 0x address (40 hex; in mixed case the checksum must be right, or write it all in lower case)', { got: token })
  return token
}

/** gang <verb> --token <addr>: the kind's code for it, or why it does not apply. */
async function routed(verb) {
  const token = tokenArg()
  // refused before any RPC: both --amount and --bnb, a malformed --note / --conf / --reveal-after, a bad --follow (the
  // note itself is built again by the kind's code)
  if (verb === 'buy') spendArg()
  parseNote()
  parseFollow()
  const kind = await padKind(token, verb)
  const io = { ...PAD_IO, out: tagKind(kind) }
  if (kind === 'v3' && V3_VERBS.has(verb)) return runV3(verb, { ...io, notes: padNotes('v3', verb) })
  if (kind === 'fair' && FAIR_VERBS.has(verb)) {
    if (flag('follow')) fail('--follow only counts on curve buys (V3 / V2 tokens): a 打新 token has no curve', { token })
    return runFair(verb, { ...amountIo(io), notes: padNotes('fair', verb) })
  }
  if (kind === 'legacy') {
    if (verb === 'buy') {
      const amount = spendArg()
      if (!amount) fail('--amount <n> required (what to spend: BNB on Soft, the quote ERC-20 on V2 / U / S)')
      return buy(token, amount, parseNote(), parseFollow())
    }
    if (verb === 'sell') return legacySell(token)
    // a note goes on a trade only (as on V3 / 打新, where padNotes refuses it on info / status)
    if (flag('note')) fail(`--note applies to buy / sell on ${KIND_NAMES.legacy} only`)
    // no wallet needed (baw is optional here): with one, the result also shows its balance
    if (verb === 'info') return out({ success: true, ...(await tokenInfo(token, myAddress() ?? undefined)) })
    if (verb === 'status') {
      const me = fromArg() || bawAddress()
      return out({ success: true, wallet: me, ...(await tokenInfo(token, me)) })
    }
  }
  // a V2 / Soft result names its pad's kind ('v2' | 'soft'); here the pad is not looked up, so no kind for them
  return fail(`gang ${verb} does not apply to ${KIND_NAMES[kind]}`, { token, ...(kind !== 'legacy' && { kind }), hint: NOT_FOR[kind][verb] })
}

// what each gang v3 / gang fair subcommand is now: their results carry it as `useInstead` (the aliases keep working)
const UNIFIED = {
  v3: { create: 'gang create', list: 'gang list --kind v3', tx: 'gang tx' },
  fair: { create: 'gang create --fair', list: 'gang list --kind fair', tx: 'gang tx' },
}
function alias(kind, sub) {
  const verbs = kind === 'v3' ? V3_VERBS : FAIR_VERBS
  const use = UNIFIED[kind][sub] ?? (verbs.has(sub) ? `gang ${sub}` : null)
  const io = { ...PAD_IO, notes: padNotes(kind, sub) }
  if (!use) return io
  return { ...io, out: (o) => out(o && typeof o === 'object' ? { ...o, useInstead: `${use} (same flags)` } : o) }
}

// gang create: V3 by default, a 打新 sale with --fair; a setting of the other kind is refused, not ignored
const V3_CREATE_FLAGS = ['buy-tax', 'sell-tax', 'dividend', 'recipient']
const FAIR_CREATE_FLAGS = ['raise', 'cap', 'hold', 'mint-fee', 'exit-fee', 'shares']
function create() {
  if (flag('fair')) {
    const wrong = V3_CREATE_FLAGS.find(flag)
    if (wrong) fail(`--${wrong} is a V3 tax setting; a 打新 sale's pool tax is fixed (1%): leave it out, or drop --fair for a V3 token`)
    if (isLaunch('fair', flag)) return runLaunch('fair', LAUNCH_DEPS)
    return runFair('create', { ...PAD_IO, notes: padNotes('fair', 'create') })
  }
  const wrong = FAIR_CREATE_FLAGS.find(flag)
  if (wrong) fail(`--${wrong} is a 打新 (fair-mint) setting: add --fair to create a sale (gang create --fair …)`)
  if (isLaunch('v3', flag)) return runLaunch('v3', LAUNCH_DEPS)
  return runV3('create', { ...PAD_IO, notes: padNotes('v3', 'create') })
}

// commands whose JSON result carries `update`; `watch` streams NDJSON and help is plain text
const UPDATE_CHECKED = new Set(['preflight', 'list', 'hot', 'new', 'near-grad', 'notes', 'agents', 'token', 'info', 'status', 'quote',
  'buy', 'follow', 'sell', 'claim', 'mint', 'withdraw', 'release', 'upload-logo', 'create', 'execute', 'tx', 'fair', 'v3', 'bond',
  'buyback'])
// gang tx decodes these beside the V2 / Soft / U / S pads' events (GangLaunchpad: both kinds; the tax router; the vaults)
const GANG_EVENT_ABIS = [...V3_EVENT_ABIS, ...FAIR_EVENT_ABIS]

async function main() {
  if (UPDATE_CHECKED.has(cmd)) update = checkUpdate()
  // `gang create` (= `gang v3 create`) / `gang fair create` write the links into the token metadata
  const tokenCreate = cmd === 'create' || ((cmd === 'v3' || cmd === 'fair') && args[1] === 'create')
  for (const name of LINK_FLAGS) {
    if (!tokenCreate && flag(name)) fail(`--${name} only applies when creating a token (\`gang create\`, \`gang create --fair\`)`)
  }
  if (flag('description') && !tokenCreate) {
    fail('--description only applies when creating a token (`gang create`, `gang create --fair`; it goes into the token metadata)')
  }
  // --bond-hold / --bond-days / --restart only mean something in a chained launch (--dev-buy / --bond); never drop them silently
  // gang fair create and gang create --fair are 打新 creates; the rest V3
  const launchKind = cmd === 'fair' || (cmd === 'create' && flag('fair')) ? 'fair' : 'v3'
  if (tokenCreate && !isLaunch(launchKind, flag)) {
    // a 打新 dev buys with --shares in the create itself: say so here, not "add --bond" (which would only lead to that)
    if (launchKind === 'fair' && flag('dev-buy')) fail(FAIR_DEV_BUY)
    const lone = LAUNCH_FLAGS.find((f) => flag(f))
    if (lone) fail(`--${lone} only applies to a launch in one command: add --bond <quote>${launchKind === 'fair' ? '' : ' (or --dev-buy <quote> / --buyback <pct>)'}`)
  }
  switch (cmd) {
    case 'fair':
      if (args[1] === 'create' && isLaunch('fair', flag)) return runLaunch('fair', LAUNCH_DEPS)
      return runFair(args[1], alias('fair', args[1]))
    case 'v3':
      if (args[1] === 'create' && isLaunch('v3', flag)) return runLaunch('v3', LAUNCH_DEPS)
      return runV3(args[1], alias('v3', args[1]))
    case 'bond':
      return runBond(args[1], { opt, flag, out, fail, summarize: summarizePreview })
    case 'buyback':
      return runBuyback(args[1], { opt, flag, out, fail, summarize: summarizePreview })
    case 'preflight': {
      const issues = []
      const status = bawStatus()
      if (status !== 'CONNECTED') issues.push({ code: 'NOT_SIGNED_IN', fix: 'Run `baw auth signin` and confirm in the Binance App.' })
      let me = null, settings = null, agent = false
      if (status === 'CONNECTED') {
        me = bawAddress(); settings = bawSettings()
        if (!settings.devMode?.enabled) issues.push({ code: 'DEV_MODE_OFF', fix: 'Enable Developer Mode in Binance App → Agentic Wallet settings.' })
        if (!settings.tradeAllTokens) issues.push({ code: 'TRADE_ALL_TOKENS_OFF', fix: 'Enable "Trade all tokens" in Binance App → Agentic Wallet settings, otherwise SELLING Gang tokens is blocked by risk control (buying still works).' })
        agent = await createGateAgent(me)
        if (!agent) issues.push({ code: 'NO_AGENT_ID', fix: 'Claim a .ai Agent ID in Binance Wallet (Agent ID banner). Gang only lets Agent ID holders buy/create.' })
      }
      return out({
        success: issues.length === 0, status, address: me,
        // `launchpad` = createPad: kept for readers of the old field (it used to be the V2 create target)
        launchpad: padNets('v3').mainnet.pad, createPad: padNets('v3').mainnet.pad, isAgent: agent,
        devMode: settings?.devMode?.enabled ?? null, tradeAllTokens: settings?.tradeAllTokens ?? null, issues,
        note: 'New create → GangLaunchpad (gang create = gang v3 create; gang fair create for 打新). LaunchpadV2 / Soft / U / S take no new tokens: existing buy / sell only.',
      })
    }
    case 'list': {
      // --kind v3 / fair: GangLaunchpad tokens (from gang.fun); without it the V2 / Soft / U / S pads, as before
      if (flag('kind')) {
        const kind = opt('kind')
        if (kind === 'v3') return runV3('list', { ...PAD_IO, notes: padNotes('v3', 'list') })
        if (kind === 'fair') return runFair('list', { ...PAD_IO, notes: padNotes('fair', 'list') })
        fail('--kind must be v3 or fair (leave it out for the V2 / Soft / U / S tokens)', { got: kind ?? null })
      }
      const me = bawStatus() === 'CONNECTED' ? bawAddress() : undefined
      return out({ success: true, createPad: padNets('v3').mainnet.pad, tokens: await listTokens(me) })
    }
    case 'hot':
    case 'new':
    case 'near-grad': {
      const limit = parseCount('limit', opt('limit', '10'), 100)
      const minPct = parsePct(opt('min-pct', '50'))
      const maxAgeSec = opt('max-age') ? parseDuration(opt('max-age'), 'max-age') : null
      const track = opt('track', 'all')
      const includeGraduated = flag('include-graduated')
      const market = await fetchMarket(track)
      const tokens = rank(market.tokens, cmd, { limit, minPct, maxAgeSec, includeGraduated })
      const empty = {
        hot: includeGraduated ? 'No token traded in the last 24h.' : 'No curve token traded in the last 24h.',
        new: maxAgeSec != null ? `No curve token created in the last ${opt('max-age')}.` : 'No curve tokens.',
        'near-grad': `No curve token at ≥${minPct}% of graduation; lower --min-pct to see the closest ones.`,
      }[cmd]
      return out({
        success: true, source: API, sort: cmd, track, count: tokens.length,
        ...(cmd === 'near-grad' ? { minPct } : {}), ...(maxAgeSec != null ? { maxAgeSec } : {}),
        ...(market.truncated ? { truncated: true } : {}),
        tokens,
        note: tokens.length ? 'Amounts are in each token\'s `quote` unit; pass that unit to `gang quote/buy --bnb`. Data, not advice.' : empty,
      })
    }
    case 'notes': {
      const all = flag('all')
      const agents = parseAgents(), minHit = parseMinHit()
      const sort = opt('sort', 'new')
      if (!NOTE_SORTS.includes(sort)) fail(`--sort must be one of ${NOTE_SORTS.join(' | ')}`, { got: sort })
      const token = opt('token')
      if (flag('token') && !ADDR_RE.test(token ?? '')) fail('--token must be a 0x… address', { got: token ?? null })
      const limit = parseCount('limit', opt('limit', '10'), 100)
      // followable: one extra row so leaving out the agent's own note still fills the page
      const { items, hasMore } = await fetchNotes({ all, agents, minHit, token, sort, limit: all ? limit : Math.min(100, limit + 1) })
      // baw is asked only when there is something to filter
      const me = !all && items.length ? myAddress() : null
      const kept = me ? items.filter((n) => n.agent?.address !== me) : items
      const own = items.length - kept.length
      const notes = kept.slice(0, limit).map(noteRow)
      const empty = minHit != null
        ? `No followable note from authors hitting ≥${Math.round(minHit * 100)}% (30 days, at least 3 judged notes); lower --min-hit or drop it.`
        : agents ? 'None of these agents has a note you can follow right now.'
          : 'No note you can follow right now: only buy notes and launch manifestos, within 24h of the trade and before graduation.'
      return out({
        success: true, source: API, followableOnly: !all, sort, count: notes.length, hasMore: hasMore || kept.length > limit,
        ...(agents && { agents }), ...(minHit != null && { minHit }), ...(own && { ownLeftOut: own }),
        notes,
        note: notes.length
          ? 'Data, not advice. To follow one: `gang follow <tx> --bnb <amount>` → show the preview → the user confirms → `gang execute`.'
          : (all ? 'No notes.' : empty),
      })
    }
    case 'agents': {
      if (flag('board') && opt('board') !== 'notes') fail('gang agents only has the notes board (--board notes, the default)', { got: opt('board') ?? null })
      const window = opt('window', '7d')
      if (!AGENT_WINDOWS.includes(window)) fail(`--window must be one of ${AGENT_WINDOWS.join(' | ')}`, { got: window })
      const sort = opt('sort', 'score')
      if (!AGENT_SORTS.includes(sort)) fail(`--sort must be one of ${AGENT_SORTS.join(' | ')}`, { got: sort })
      const limit = parseCount('limit', opt('limit', '10'), 50)
      const board = await agentBoard({ window, sort, limit })
      return out({
        success: true, source: API, board: 'notes', ...board, count: board.agents.length,
        note: board.agents.length
          ? 'score: confidence calibration (100 = perfect, 0 = always saying 50%). Past results, not a promise. `next` lists that agent\'s followable notes.'
          : `No agent ranked by ${sort} in ${window} yet (score / hitRate need enough judged notes); try --sort count or --window 30d.`,
      })
    }
    case 'watch': {
      const notesMode = flag('notes')
      // <addr> right after `watch`, or after a leading --notes (which takes no value)
      const bare = (a) => (a && !a.startsWith('--') ? a : null)
      const positional = bare(args[1]) || (args[1] === '--notes' ? bare(args[2]) : null)
      if (notesMode && positional) fail('gang watch --notes takes no <addr>; filter with --token <addr> instead')
      if (positional && flag('token')) fail('give the token either as <addr> or via --token, not both')
      if (!positional && flag('token') && !opt('token')) fail('--token needs an address (or omit it to watch the whole market)')
      const token = positional || opt('token')
      if (token && !ADDR_RE.test(token)) fail('watch: token must be a 0x… address', { got: token })
      if (!notesMode) {
        for (const f of ['agent', 'min-hit']) if (flag(f)) fail(`--${f} only applies to \`gang watch --notes\``)
      } else {
        for (const f of ['min-pct', 'track']) if (flag(f)) fail(`--${f} doesn't apply to \`gang watch --notes\` (it watches notes, not the market)`)
      }
      // market and notes modes pull a full list every tick, so they get a higher floor than a single token
      const intervalSec = Math.max(token && !notesMode ? 3 : 10, parseDuration(opt('interval', notesMode ? '30' : '10'), 'interval'))
      const maxEvents = opt('max-events') ? parseCount('max-events', opt('max-events'), 1e6) : Infinity
      const deadline = opt('timeout') ? Date.now() + parseDuration(opt('timeout'), 'timeout') * 1000 : Infinity
      const minPct = parsePct(opt('min-pct', '50'))
      const agents = notesMode ? parseAgents() : null, minHit = notesMode ? parseMinHit() : null
      const webhook = opt('webhook')
      if (webhook && !/^https?:\/\//.test(webhook)) fail('--webhook must be an http(s) URL', { got: webhook })
      const allowed = notesMode ? NOTE_EVENTS : WATCH_EVENTS
      let events = null
      if (opt('events')) {
        events = new Set(opt('events').split(',').map((s) => s.trim().replace(/-/g, '_')).filter(Boolean))
        const bad = [...events].filter((e) => !allowed.includes(e))
        if (bad.length) fail(`unknown --events${notesMode ? ' for --notes' : ''}: ${bad.join(', ')}`, { allowed })
      }
      const me = notesMode ? myAddress() : null

      let count = 0
      const hooks = new Set()
      const line = (o) => console.log(JSON.stringify({ ...o, emittedAt: Math.floor(Date.now() / 1000) }))
      // meta events (watching / error / ended / timeout) go to stdout only and do not count toward --max-events
      const emit = (ev, { meta = false } = {}) => {
        line(ev)
        if (meta) return
        count++
        if (webhook) {
          const p = fetch(webhook, {
            method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA },
            body: JSON.stringify(ev), signal: AbortSignal.timeout(10_000),
          }).then((r) => { if (!r.ok) line({ event: 'error', error: `webhook ${r.status}` }) })
            .catch((e) => line({ event: 'error', error: `webhook: ${e.message}` }))
            .finally(() => hooks.delete(p))
          hooks.add(p)
        }
      }
      // aborts in-flight API requests at the deadline so --timeout isn't stretched by a slow API.
      // setTimeout caps at 2^31-1 ms (~24.8d) and fires at once beyond it; longer timeouts rely on sleep's check.
      const stopper = new AbortController()
      const delay = deadline - Date.now()
      const deadlineTimer = delay <= 2 ** 31 - 1 ? setTimeout(() => stopper.abort(), delay) : null
      // the timer runs on the monotonic clock and may beat Date.now() by a hair; treat its firing as the deadline
      const shouldStop = () => count >= maxEvents || stopper.signal.aborted || Date.now() >= deadline
      try {
        const common = { intervalSec, events, emit, shouldStop, stop: stopper.signal }
        if (notesMode) await watchNotes({ ...common, agents, minHit, token, skip: (n) => !!me && n.agent?.address === me })
        else await watch({ ...common, token, minPct, track: opt('track', 'all') })
      } catch (e) {
        if (!shouldStop()) throw e // startup failure → fail() prints it as one NDJSON line
      } finally {
        clearTimeout(deadlineTimer)
      }
      if (count < maxEvents && (stopper.signal.aborted || Date.now() >= deadline)) line({ event: 'timeout', events: count })
      await Promise.allSettled([...hooks])
      return
    }
    case 'info':
    case 'token': // the older name of gang info
      return routed('info')
    case 'status':
    case 'claim':
    case 'mint':
    case 'withdraw':
    case 'release':
      return routed(cmd)
    case 'quote': {
      const token = tokenArg(), bnb = spendArg()
      if (!bnb) fail('--amount required (Soft archive: BNB; V2: quote ERC-20 amount; --bnb is the older name)')
      if ((await padKind(token, 'quote')) !== 'legacy') {
        fail('gang quote prices V2 / Soft / U / S curve buys; on GangLaunchpad, gang buy simulates the trade and shows expectTokens (nothing is sent before gang execute)', { token })
      }
      const me = bawAddress()
      const q = await quoteBuy(token, me, bnb)
      return out({
        success: true, token, buyer: me, pad: q.pad, kind: q.kind, quote: q.quote,
        quotePath: q.quotePath, deterministic: q.deterministic || false,
        tokensOut: q.tokensOutFmt, spent: q.spentFmt, fee: q.feeFmt, refund: q.refundFmt, unit: q.unit,
        note: q.refund > 0n
          ? 'Part of the input would be refunded (wallet 1% cap or graduation cap).'
          : (q.deterministic ? 'V2 quote = LaunchpadV2.sol curve math (unique path; no Soft/U/S fallback).' : undefined),
      })
    }
    case 'buy':
      return routed('buy')
    case 'follow': {
      // gang follow <note tx> --amount <n>: the token comes from the note
      const noteTx = args[1] && !args[1].startsWith('--') ? args[1].toLowerCase() : null
      if (!NOTE_TX.test(noteTx ?? '')) fail('usage: gang follow <note tx> --amount <n> (the note tx is 0x + 64 hex)', { got: noteTx })
      if (flag('token')) fail('gang follow takes the token from the note; to name it yourself use `gang buy --token … --amount … --follow <note tx>`')
      if (flag('follow')) fail('give the note tx once: `gang follow <note tx> --amount <n>`')
      const bnb = spendArg(); if (!bnb) fail('--amount required (the amount to buy, in the token\'s quote unit; --bnb is the older name)')
      const note = parseNote() // a bad --note fails before any API call, as on buy
      // checked without a token: gang.fun answers with the note's token, and buy() reuses this check. The wallet is the
      // one that buys: --from builds for another one (gang v3 buy takes it on the curve; buy() refuses it there)
      const { token, follow } = await confirmFollow(noteTx, fromArg() || bawAddress())
      if (!token) fail('gang.fun did not say which token this note is about', { noteTx })
      // a GangLaunchpad token: the V3 curve buy (--amount / --bnb = the quote to spend)
      const onPad = await kindOf(v2PoolCtx(), token)
      if (onPad === 'fair') fail('this note is on a 打新 (fair-mint) token: only curve buys can follow a note', { noteTx, token })
      if (onPad === 'v3') {
        return runV3('buy', { ...PAD_IO, opt: (n, d) => (n === 'token' ? token : opt(n, d)), notes: padNotes('v3', 'buy', { note, checked: follow }) })
      }
      return buy(token, bnb, note, noteTx, follow)
    }
    case 'sell':
      return routed('sell')
    case 'upload-logo': {
      const file = opt('file') || opt('path') || opt('logo')
      const url = opt('url')
      if (file && url) fail('use either --file or --url, not both')
      if (!file && !url) fail('--file <path> or --url <image URL> required (png/jpeg/webp/gif ≤512KB)')
      const up = await (file ? uploadLogoFile(file) : rehostLogoUrl(url)).catch((e) => fail(e.message, retryHint(e)))
      return out({ success: true, ...up, ui: LOGO_UI, next: `gang create --name … --symbol … --logo-uri ${up.logoUrl}` })
    }
    case 'create': {
      // new tokens go to GangLaunchpad (= gang v3 create); LaunchpadV2 takes none, its tokens keep trading (gang buy / sell)
      if (flag('taxed')) fail(`--taxed was LaunchpadV2's tax track, which takes no new tokens. ${TAXED_HINT}`)
      if (flag('pair-or-quote') || flag('pair')) {
        fail('--pair-or-quote was removed (CLI ≤0.3.0 encoded a create the contract does not have). Use --quote <ERC-20> --ref-pool <Pancake pair/pool holding it>; omit both for WBNB.')
      }
      return create()
    }
    case 'execute': {
      const id = opt('request-id'); if (!id) fail('--request-id required')
      const r = bawExecute(id)
      if (!r.success) return out({ success: false, error: r.error })
      const d = r.data
      const pending = d.status === 'PENDING_CONFIRMATION'
      const entry = findByRequestId(id)
      // nothing broadcast (no hash, not pending) → nothing followed, and no trade to remind about
      const sent = d.txHash || pending
      const preview = sent ? previewFor(id) : null
      const followed = preview?.followed
      let note
      if (entry && d.txHash && !pending) note = await revealNote(entry, d.txHash)
      else if (entry && pending) {
        note = { published: false, pending: true, retry: 'after the user approves in the Binance App: `gang tx --hash <hash>` publishes the note' }
      } else if (entry) {
        // any other status without a hash: nothing was broadcast, so there's nothing to reveal (and nothing to wait for)
        note = { published: false, error: 'no_tx_hash', status: d.status }
      }
      return out({
        success: true, status: d.status, txHash: d.txHash, orderId: d.orderId, pendingConfirmation: pending,
        ...(note && { note }),
        ...(!entry && preview && !preview.noted && { agentNote: NO_NOTE_SENT }),
        ...(followed && { follow: { noteTx: followed, link: noteLink(followed) } }),
        next: pending
          ? 'Ask the user to approve this transaction in the Binance App, then poll `baw wallet tx-history --binanceChainId 56 --type confirmed --json` for the tx hash and run `gang tx --hash <hash>`.'
          : (d.txHash ? `gang tx --hash ${d.txHash}` : undefined),
      })
    }
    case 'tx': {
      const hash = opt('hash'); if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) fail('--hash must be a tx hash (0x + 64 hex)')
      if (flag('testnet')) {
        // BSC testnet: GangLaunchpad only (no V2 / Soft there, and gang.fun indexes no testnet notes)
        let ctx
        try { ctx = v3Ctx(true) } catch (e) { fail(e.message) }
        const r = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 })
        return out({
          success: true, chainId: Number(ctx.chainId), hash, status: r.status, block: Number(r.blockNumber),
          events: decodeLogs(r.logs, GANG_EVENT_ABIS), explorer: `${ctx.explorer}/tx/${hash}`,
        })
      }
      const t = await decodeTx(hash, GANG_EVENT_ABIS)
      // the input may carry a follow ref and a note commitment: a committed note is sent here if it's still in the
      // local queue (e.g. after PENDING_CONFIRMATION), or its state reported / refreshed if already sent
      const queued = hasQueued()
      let note, input = null
      try {
        input = (await client.getTransaction({ hash })).input
      } catch (e) {
        if (queued) note = { published: false, error: `could not read tx input: ${e.message.split('\n')[0]}` }
      }
      const committed = input && queued ? hashesIn(input) : []
      if (committed.length) {
        const entry = findByHashes(committed)
        if (!entry) {
          note = { committed: committed[0], published: false, error: 'not_in_local_queue', hint: 'note was written on another machine, or the queue entry is older than 24h' }
        }
        else if (t.status !== 'success') note = { published: false, error: 'tx_failed' }
        else note = withRetry(await publishNote(entry, hash), hash)
      }
      const followed = readFollowRef(input), links = readTokenLinks(input)
      return out({
        success: true, ...t, ...(note && { note }), ...(followed && { follow: { noteTx: followed, link: noteLink(followed) } }),
        ...(links && { links }),
      })
    }
    default:
      console.log(HELP); process.exit(cmd ? 1 : 0)
  }
}

main().catch((e) => fail(e.message))
