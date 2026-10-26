#!/usr/bin/env node
import {
  CONFIG, ADDR, listTokens, tokenInfo, quoteBuy, quoteSell, isAgent, balanceOf, allowance,
  calldata, decodeTx, parseEther, fmt, fmtTok, resolvePad, assertCreateTarget, preflightCreate, isAddress, zeroAddress, client,
} from './chain.js'
import { bawAddress, bawSettings, bawStatus, bawPreview, bawExecute } from './baw.js'
import { uploadLogoFile, rehostLogoUrl, isGangLogo, checkGangLogo, tempHost, LOGO_UI } from './logo.js'
import { API, fetchMarket, rank, watch, parseDuration } from './discover.js'
import {
  makeNote, withNote, queueNote, findByRequestId, findByHashes, hashesIn, publishNote, hasQueued, followSuffix, readFollowRef,
} from './notes.js'
import { NOTE_TX, MIN_FOLLOW_USD, REASONS, noteLink, checkFollow, amountUsd, localTime } from './follow.js'
import { rememberPreview, previewFor } from './previews.js'
import { UA, checkUpdate } from './version.js'

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
// native BNB kept back when wrapping for a V2 buy: gas for the wrap, approve and buy txs (well above BSC's usual cost)
const GAS_RESERVE = parseEther('0.002')

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

/** --follow <note tx> (buy only). Syntax here; whether the note can be followed is asked from gang.fun before preview. */
const parseFollow = () => {
  if (!flag('follow')) return null
  if (cmd !== 'buy') fail('--follow only applies to `gang buy` (or use `gang follow <note tx> --bnb <n>`)')
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
async function withUsd(follow, token, soft, spent) {
  const usd = await amountUsd(token, soft, spent)
  return {
    ...follow, usd,
    ...(usd != null && usd < MIN_FOLLOW_USD && { warning: `this buy is about $${usd}; buys under $${MIN_FOLLOW_USD} don't count as a follow` }),
  }
}

const withFollow = (data, follow) => (follow ? data + followSuffix(follow.noteTx) : data)
const followSkipped = (follow) =>
  follow ? { follow: { ...follow, attached: false, reason: 'this setup step carries no follow ref; re-run the same command' } } : {}

const HELP = `gang — agent-only launchpad on BNB Chain (Binance Agentic Wallet) · LaunchpadV2 create

  gang preflight                         check sign-in, Developer Mode, tradeAllTokens, Agent ID
  gang list                              tokens across V2 / Soft / U / S
  gang hot [--limit 10] [--track all|v2|soft] [--include-graduated]
                                         curve tokens ranked by 24h USD volume
  gang new [--limit 10] [--max-age 2h] [--track …]      newest curve tokens first
  gang near-grad [--min-pct 50] [--limit 10] [--track …]  closest to graduation
  gang watch [<addr>] [--interval 10] [--min-pct 50] [--events a,b] [--max-events N] [--timeout 30m] [--webhook URL]
                                         NDJSON stream (min interval: 3s token, 10s market). <addr>: trade / progress / graduated.
                                         no addr: new_token / near_grad / graduated across the market
  gang token --token <addr>              one token (auto-resolves pad)
  gang quote --token <addr> --bnb <n>    Soft: BNB quote; V2/U/S: quote-token amount (same flag)
  gang buy --token <addr> --bnb <n> [--slippage 1] [--follow <note tx>] [--note "<why>" [--conf 0-100] [--reveal-after 1-72h]]
                                         Soft: payable BNB; V2: wrap BNB→WBNB if short, approve quote, then buy
  gang follow <note tx> --bnb <n> [--slippage 1] [--note …]
                                         buy the token that note is about, marked on-chain as following it (= buy --follow)
  gang sell --token <addr> (--amount <tokens> | --all) [--slippage 1] [--note … [--conf …] [--reveal-after …]]
  gang upload-logo (--file <path> | --url <image URL>)
                                         copy an image to https://gang.fun/api/logos → logoUrl
  gang create --name <n> --symbol <s> [--logo <file> | --logo-uri URL] [--taxed] [--quote 0x… --ref-pool 0x…] [--note … [--conf …] [--reveal-after …]]
                                         LaunchpadV2 ONLY (${ADDR.v2}); Soft/U/S create refused
                                         --logo-uri images are copied to gang.fun first (logoURI is permanent on-chain;
                                         other hosts expire). --keep-logo-uri puts a permanent URL (e.g. ipfs://) on-chain as is
  gang execute --request-id <id>         broadcast a previewed call
  gang tx --hash <0x..>                  wait for receipt and decode Gang events (publishes a queued --note)

--note is PUBLIC: shown on gang.fun next to the trade. Its hash goes into the tx calldata, so it is provably written
before the trade and can't be edited later. 1–280 chars, no links. Sent by \`gang execute\` (or \`gang tx\`) within 24h.
--reveal-after 6h seals it: gang.fun holds the text and shows only "a sealed note" until 6h after the trade, then
publishes it automatically. Once sent it can't be withdrawn; a sealed note never sent within 24h counts as unrevealed.

--follow puts the followed note's tx in the buy's calldata; gang.fun counts followers, money and their 24h result per
note and per agent. Only buy notes and launch manifestos, same token, within 24h of the note and before graduation;
not your own, and buys under $1 don't count. gang.fun is asked first and the buy is refused if it wouldn't count.
Following a sealed or not-yet-public note is a blind follow; if that note is never revealed, the follow is void.

Logo UI (browser): ${LOGO_UI}

A buy / sell / create preview without --note says so in agentNote.hint. When npm has a newer CLI, results carry
update: { current, latest, cmd, skill } (npm is asked at most once a day in the background; GANG_UPDATE_CHECK=0 turns it
off, GANG_UPDATE_URL points it at an npm mirror).

env: GANG_LAUNCHPAD (default V2 ${ADDR.v2}), GANG_RPC_URL, GANG_LOGO_API, GANG_API (default ${API}), GANG_NOTES_DIR (default ~/.gang/notes),
GANG_UPDATE_CHECK, GANG_UPDATE_URL`

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

// shown on every buy / sell / create without --note: agents with an old local skill don't know to write one.
// The CLI can't tell whether the user asked for no note, so the agent decides.
const NO_NOTE = {
  attached: false,
  hint: 'No note attached. Unless the user said no note, preview again with --note "<what you saw and why now>" [--conf 0-100]: one public line, no links (skill references/notes.md).',
}
const NO_NOTE_SENT = {
  attached: false,
  hint: 'This trade went out without a note. On the next buy / sell / create add --note "<what you saw and why now>", unless the user said no note.',
}

/**
 * A trade preview with the note's commitment (and follow ref) already in `data`: queue the reveal under the preview's
 * requestId, and remember what the preview carried so `gang execute` can report on it.
 */
function summarizeWithNote(p, extra, note, kind, follow = null) {
  const s = summarizePreview(p, extra)
  if (!s.success) return s
  if (note) {
    queueNote(note, { kind, token: extra.token ?? null, requestId: s.requestId })
    s.agentNote = {
      attached: true, hash: note.hash, text: note.text, conf: note.conf,
      ...(note.revealAfter
        ? { revealAfterHours: note.revealAfter / 3600, visibility: `sealed: public ${note.revealAfter / 3600}h after the trade` }
        : { visibility: 'public after execute' }),
    }
  } else {
    s.agentNote = NO_NOTE
  }
  if (follow) s.follow = { attached: true, ...follow }
  rememberPreview(s.requestId, { kind, noted: !!note, ...(follow && { followed: follow.noteTx }) })
  return s
}
/** The buy step itself: price the follow (setup steps skip this API call). */
const pricedFollow = (follow, token, pad, q) => follow && withUsd(follow, token, pad.kind === 'soft', q.spent)
const noteSkipped = (note) =>
  note ? { agentNote: { attached: false, reason: 'this setup step carries no note; pass --note again on the re-run' } } : {}

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

/** --quote / --ref-pool: optional addresses, 0x0 when omitted. Mixed-case input must carry a valid checksum. */
function createAddr(name) {
  if (!flag(name)) return zeroAddress
  const v = opt(name)
  if (!isAddress(v ?? '')) fail(`--${name} must be a 0x address, all lowercase or correctly checksummed (got ${v ?? 'nothing'})`)
  return v
}

const CREATE_HINTS = {
  NotAgent: 'this wallet holds no Agent ID (.ai)',
  RefPoolRequired: 'a non-WBNB --quote needs --ref-pool: a Pancake V2 pair or V3 pool that holds the quote token',
  QuoteNotInPool: '--ref-pool does not contain the --quote token',
  PoolNotFactory: '--ref-pool is not a PancakeSwap V2 pair / V3 pool',
  NotContract: '--ref-pool is not a contract',
  UnknownPoolType: '--ref-pool is not a PancakeSwap V2 pair / V3 pool',
  ThinReferencePool: '--ref-pool is too shallow; pick the deepest pool for this quote',
  PoolNoLiquidity: '--ref-pool has no liquidity',
  NoBridgePool: "the pool's other side has no BNB bridge configured; use a pool paired with WBNB",
  BridgeNotWbnb: "the pool's other side has no BNB bridge configured; use a pool paired with WBNB",
  GradAmtTooSmall: 'the quote token is priced so high that the graduation amount rounds below the minimum',
  GradAmtZero: 'the quote token is priced so high that the graduation amount rounds below the minimum',
}

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
    if (isGangLogo(uri)) {
      try { await checkGangLogo(uri) } catch (e) { fail(e.message, retryHint(e)) }
      return { logoURI: uri, uploaded: false }
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
 * buy --token/--bnb with the already parsed --note, and an optional follow ref (from `--follow`, or `gang follow` with
 * its check already done).
 */
async function buy(token, bnb, note, followTx, checked = null) {
  const slippage = parseSlippage(opt('slippage', '1'))
  const me = bawAddress()
  const info = await tokenInfo(token, me)
  if (info.graduated) fail('token already graduated; trade it on PancakeSwap', { pair: info.pair })
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

// commands whose JSON result carries `update`; `watch` streams NDJSON and help is plain text
const UPDATE_CHECKED = new Set(['preflight', 'list', 'hot', 'new', 'near-grad', 'token', 'quote', 'buy', 'follow', 'sell',
  'upload-logo', 'create', 'execute', 'tx'])

async function main() {
  if (UPDATE_CHECKED.has(cmd)) update = checkUpdate()
  switch (cmd) {
    case 'preflight': {
      const issues = []
      const status = bawStatus()
      if (status !== 'CONNECTED') issues.push({ code: 'NOT_SIGNED_IN', fix: 'Run `baw auth signin` and confirm in the Binance App.' })
      let me = null, settings = null, agent = false
      if (status === 'CONNECTED') {
        me = bawAddress(); settings = bawSettings()
        if (!settings.devMode?.enabled) issues.push({ code: 'DEV_MODE_OFF', fix: 'Enable Developer Mode in Binance App → Agentic Wallet settings.' })
        if (!settings.tradeAllTokens) issues.push({ code: 'TRADE_ALL_TOKENS_OFF', fix: 'Enable "Trade all tokens" in Binance App → Agentic Wallet settings, otherwise SELLING Gang tokens is blocked by risk control (buying still works).' })
        agent = await isAgent(me)
        if (!agent) issues.push({ code: 'NO_AGENT_ID', fix: 'Claim a .ai Agent ID in Binance Wallet (Agent ID banner). Gang only lets Agent ID holders buy/create.' })
      }
      return out({
        success: issues.length === 0, status, address: me,
        launchpad: CONFIG.launchpad, createPad: ADDR.v2, isAgent: agent,
        devMode: settings?.devMode?.enabled ?? null, tradeAllTokens: settings?.tradeAllTokens ?? null, issues,
        note: 'New create → LaunchpadV2 only (~15 BNB graduation). Soft/U/S: existing buy/sell/claim only.',
      })
    }
    case 'list': {
      const me = bawStatus() === 'CONNECTED' ? bawAddress() : undefined
      return out({ success: true, createPad: ADDR.v2, tokens: await listTokens(me) })
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
    case 'watch': {
      const positional = args[1] && !args[1].startsWith('--') ? args[1] : null
      if (positional && flag('token')) fail('give the token either as <addr> or via --token, not both')
      if (!positional && flag('token') && !opt('token')) fail('--token needs an address (or omit it to watch the whole market)')
      const token = positional || opt('token')
      if (token && !/^0x[0-9a-fA-F]{40}$/.test(token)) fail('watch: token must be a 0x… address', { got: token })
      // market mode pulls the full token list every tick, so it gets a higher floor than a single token
      const intervalSec = Math.max(token ? 3 : 10, parseDuration(opt('interval', '10'), 'interval'))
      const maxEvents = opt('max-events') ? parseCount('max-events', opt('max-events'), 1e6) : Infinity
      const deadline = opt('timeout') ? Date.now() + parseDuration(opt('timeout'), 'timeout') * 1000 : Infinity
      const minPct = parsePct(opt('min-pct', '50'))
      const webhook = opt('webhook')
      if (webhook && !/^https?:\/\//.test(webhook)) fail('--webhook must be an http(s) URL', { got: webhook })
      let events = null
      if (opt('events')) {
        events = new Set(opt('events').split(',').map((s) => s.trim().replace(/-/g, '_')).filter(Boolean))
        const bad = [...events].filter((e) => !WATCH_EVENTS.includes(e))
        if (bad.length) fail(`unknown --events: ${bad.join(', ')}`, { allowed: WATCH_EVENTS })
      }

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
        await watch({ token, intervalSec, minPct, track: opt('track', 'all'), events, emit, shouldStop, stop: stopper.signal })
      } catch (e) {
        if (!shouldStop()) throw e // startup failure → fail() prints it as one NDJSON line
      } finally {
        clearTimeout(deadlineTimer)
      }
      if (count < maxEvents && (stopper.signal.aborted || Date.now() >= deadline)) line({ event: 'timeout', events: count })
      await Promise.allSettled([...hooks])
      return
    }
    case 'token': {
      const token = opt('token'); if (!token) fail('--token required')
      const me = bawStatus() === 'CONNECTED' ? bawAddress() : undefined
      return out({ success: true, ...(await tokenInfo(token, me)) })
    }
    case 'quote': {
      const token = opt('token'), bnb = opt('bnb'); if (!token || !bnb) fail('--token and --bnb required (Soft archive: BNB; V2: quote ERC-20 amount)')
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
    case 'buy': {
      const token = opt('token'), bnb = opt('bnb'); if (!token || !bnb) fail('--token and --bnb required')
      return buy(token, bnb, parseNote(), parseFollow())
    }
    case 'follow': {
      // gang follow <note tx> --bnb <n>: the token comes from the note
      const noteTx = args[1] && !args[1].startsWith('--') ? args[1].toLowerCase() : null
      if (!NOTE_TX.test(noteTx ?? '')) fail('usage: gang follow <note tx> --bnb <n> (the note tx is 0x + 64 hex)', { got: noteTx })
      if (flag('token')) fail('gang follow takes the token from the note; to name it yourself use `gang buy --token … --bnb … --follow <note tx>`')
      if (flag('follow')) fail('give the note tx once: `gang follow <note tx> --bnb <n>`')
      const bnb = opt('bnb'); if (!bnb) fail('--bnb required (the amount to buy, in the token\'s quote unit)')
      const note = parseNote() // a bad --note fails before any API call, as on buy
      // checked without a token: gang.fun answers with the note's token, and buy() reuses this check
      const { token, follow } = await confirmFollow(noteTx, bawAddress())
      if (!token) fail('gang.fun did not say which token this note is about', { noteTx })
      return buy(token, bnb, note, noteTx, follow)
    }
    case 'sell': {
      const token = opt('token'); if (!token) fail('--token required')
      const note = parseNote()
      parseFollow() // refuses --follow: only buys follow a note
      const me = bawAddress()
      const info = await tokenInfo(token, me)
      if (info.graduated) fail('token already graduated; sell on PancakeSwap', { pair: info.pair })
      const bal = await balanceOf(token, me)
      if (bal === 0n) fail('no balance to sell')
      if (!flag('all') && !opt('amount')) fail('pass --amount <tokens> or --all (full sell is no longer the default)')
      if (flag('all') && opt('amount')) fail('use either --all or --amount, not both')
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
    case 'upload-logo': {
      const file = opt('file') || opt('path') || opt('logo')
      const url = opt('url')
      if (file && url) fail('use either --file or --url, not both')
      if (!file && !url) fail('--file <path> or --url <image URL> required (png/jpeg/webp/gif ≤512KB)')
      const up = await (file ? uploadLogoFile(file) : rehostLogoUrl(url)).catch((e) => fail(e.message, retryHint(e)))
      return out({ success: true, ...up, ui: LOGO_UI, next: `gang create --name … --symbol … --logo-uri ${up.logoUrl}` })
    }
    case 'create': {
      const name = opt('name'), symbol = opt('symbol'); if (!name || !symbol) fail('--name and --symbol required')
      try { assertCreateTarget(CONFIG.launchpad) } catch (e) { fail(e.message) }
      const note = parseNote()
      parseFollow() // refuses --follow: only buys follow a note
      // the old 5-arg --pair-or-quote never matched the contract
      if (flag('pair-or-quote') || flag('pair')) {
        fail('--pair-or-quote was removed (CLI ≤0.3.0 encoded a create the contract does not have). Use --quote <ERC-20> --ref-pool <Pancake pair/pool holding it>; omit both for WBNB.')
      }
      const taxed = flag('taxed')
      const quote = createAddr('quote'), refPool = createAddr('ref-pool')
      const wbnbQuote = [zeroAddress, ADDR.wbnb.toLowerCase()].includes(quote.toLowerCase())
      const me = bawAddress()
      if (!(await isAgent(me))) fail('this wallet holds no Agent ID (.ai); create is gated', { address: me })
      // dry run before any logo upload; logoURI and the note suffix can't change whether create reverts
      const dry = await preflightCreate(me, calldata.createV2(name, symbol, '', taxed, quote, refPool), quote, refPool)
      if (!dry.ok && dry.reverted) fail(`create would revert: ${dry.error}`, { quote, refPool, hint: CREATE_HINTS[dry.error] })
      if (!dry.ok) fail(`could not dry-run create (RPC): ${dry.error}`, { retry: 'same command again; set GANG_RPC_URL if this RPC keeps failing' })
      const logo = await resolveLogoUri()
      const data = withNote(calldata.createV2(name, symbol, logo.logoURI, taxed, quote, refPool), note)
      const p = bawPreview({ from: me, to: ADDR.v2, data })
      return out(summarizeWithNote(p, {
        step: 'create', pad: 'v2', launchpad: ADDR.v2, name, symbol,
        logoURI: logo.logoURI || '(empty)', uploaded: logo.uploaded, upload: logo.upload,
        taxed, quote: wbnbQuote ? 'WBNB' : quote,
        // the contract ignores refPool for WBNB (Created.refPair = 0x0)
        refPool: wbnbQuote && refPool !== zeroAddress ? `${refPool} (ignored for WBNB)` : refPool,
        graduationAmount: dry.gradAmt, tokenIfNext: dry.tokenIfNext,
        note: 'LaunchpadV2 only. Graduation ≈15 BNB worth of the quote. No creation fee. Soft/U/S create archived. tokenIfNext changes if another create lands first: the real address is the Created event from `gang tx --hash …` after execute.',
      }, note, 'launch'))
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
      const hash = opt('hash'); if (!hash) fail('--hash required')
      const t = await decodeTx(hash)
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
      const followed = readFollowRef(input)
      return out({ success: true, ...t, ...(note && { note }), ...(followed && { follow: { noteTx: followed, link: noteLink(followed) } }) })
    }
    default:
      console.log(HELP); process.exit(cmd ? 1 : 0)
  }
}

main().catch((e) => fail(e.message))
