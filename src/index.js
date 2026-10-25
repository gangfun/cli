#!/usr/bin/env node
import {
  CONFIG, ADDR, listTokens, tokenInfo, quoteBuy, quoteSell, isAgent, balanceOf, allowance,
  calldata, decodeTx, parseEther, fmt, fmtTok, resolvePad, assertCreateTarget, preflightCreate, isAddress, zeroAddress, client,
} from './chain.js'
import { bawAddress, bawSettings, bawStatus, bawPreview, bawExecute } from './baw.js'
import { uploadLogoFile, LOGO_UI } from './logo.js'
import { API, fetchMarket, rank, watch, parseDuration } from './discover.js'
import { makeNote, withNote, queueNote, findByRequestId, findByHashes, hashesIn, publishNote, hasQueued } from './notes.js'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def }
const flag = (name) => args.includes(`--${name}`)
const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
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
  gang buy --token <addr> --bnb <n> [--slippage 1] [--note "<why>" [--conf 0-100] [--reveal-after 1-72h]]
                                         Soft: payable BNB; V2: wrap BNB→WBNB if short, approve quote, then buy
  gang sell --token <addr> (--amount <tokens> | --all) [--slippage 1] [--note … [--conf …] [--reveal-after …]]
  gang upload-logo --file <path>         POST image → https://gang.fun/api/logos → logoUrl
  gang create --name <n> --symbol <s> [--logo-uri URL | --logo <file>] [--taxed] [--quote 0x… --ref-pool 0x…] [--note … [--conf …] [--reveal-after …]]
                                         LaunchpadV2 ONLY (${ADDR.v2}); Soft/U/S create refused
  gang execute --request-id <id>         broadcast a previewed call
  gang tx --hash <0x..>                  wait for receipt and decode Gang events (publishes a queued --note)

--note is PUBLIC: shown on gang.fun next to the trade. Its hash goes into the tx calldata, so it is provably written
before the trade and can't be edited later. 1–280 chars, no links. Sent by \`gang execute\` (or \`gang tx\`) within 24h.
--reveal-after 6h seals it: gang.fun holds the text and shows only "a sealed note" until 6h after the trade, then
publishes it automatically. Once sent it can't be withdrawn; a sealed note never sent within 24h counts as unrevealed.

Logo UI (browser): ${LOGO_UI}
env: GANG_LAUNCHPAD (default V2 ${ADDR.v2}), GANG_RPC_URL, GANG_LOGO_API, GANG_API (default ${API}), GANG_NOTES_DIR (default ~/.gang/notes)`

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

/** Preview with the note's commitment already in `data`; queue the reveal under the preview's requestId. */
function summarizeWithNote(p, extra, note, kind) {
  const s = summarizePreview(p, extra)
  if (note && s.success) {
    queueNote(note, { kind, token: extra.token ?? null, requestId: s.requestId })
    s.agentNote = {
      attached: true, hash: note.hash, text: note.text, conf: note.conf,
      ...(note.revealAfter
        ? { revealAfterHours: note.revealAfter / 3600, visibility: `sealed: public ${note.revealAfter / 3600}h after the trade` }
        : { visibility: 'public after execute' }),
    }
  }
  return s
}
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

async function resolveLogoUri() {
  const uri = opt('logo-uri')
  const file = opt('logo') || opt('logo-file') || opt('file-logo')
  if (uri && file) fail('use either --logo-uri or --logo/--logo-file, not both')
  if (uri) return { logoURI: uri, uploaded: false }
  if (file) {
    const up = await uploadLogoFile(file)
    return { logoURI: up.logoUrl, uploaded: true, upload: up }
  }
  return { logoURI: '', uploaded: false }
}

async function main() {
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
            method: 'POST', headers: { 'content-type': 'application/json' },
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
      const slippage = parseSlippage(opt('slippage', '1'))
      const note = parseNote()
      const me = bawAddress()
      const info = await tokenInfo(token, me)
      if (info.graduated) fail('token already graduated; trade it on PancakeSwap', { pair: info.pair })
      if (!(await isAgent(me))) fail('this wallet holds no Agent ID (.ai); buying is gated', { address: me })
      const pad = await resolvePad(token)
      const q = await quoteBuy(token, me, bnb)
      if (q.tokensOut === 0n) fail('wallet cap reached or zero out', { myBalance: info.myBalance })
      const minOut = (q.tokensOut * BigInt(Math.round((100 - slippage) * 100))) / 10000n

      if (pad.kind === 'soft') {
        const data = withNote(calldata.softBuy(token, minOut), note)
        const p = bawPreview({ from: me, to: pad.address, value: parseEther(bnb), data })
        return out(summarizeWithNote(p, {
          step: 'buy', kind: 'soft', token, symbol: info.symbol, pad: pad.id,
          bnbSent: bnb, expectTokens: q.tokensOutFmt, expectSpent: q.spentFmt, fee: q.feeFmt,
          expectRefund: q.refundFmt, minTokensOut: fmtTok(minOut),
        }, note, 'buy'))
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
          note: 'V2 buys pay in WBNB. Wrap BNB → WBNB first. After it confirms, re-run the same `gang buy` (approve, then the buy).',
          ...noteSkipped(note),
        }))
      }
      if (allow < quoteIn) {
        const p = bawPreview({ from: me, to: info.quote, data: calldata.approve(pad.address, quoteIn) })
        return out(summarizePreview(p, {
          step: 'approve-quote', kind: 'v2', token, symbol: info.symbol, pad: pad.id, quote: info.quote,
          amount: bnb, note: 'Approve quote ERC-20 first. After it confirms, re-run the same `gang buy` to preview the buy.',
          ...noteSkipped(note),
        }))
      }
      const data = withNote(calldata.v2Buy(token, quoteIn, minOut), note)
      const p = bawPreview({ from: me, to: pad.address, data })
      return out(summarizeWithNote(p, {
        step: 'buy', kind: 'v2', token, symbol: info.symbol, pad: pad.id, quote: info.quote,
        quoteIn: bnb, expectTokens: q.tokensOutFmt, expectSpent: q.spentFmt, fee: q.feeFmt,
        expectRefund: q.refundFmt, minTokensOut: fmtTok(minOut), quotePath: q.quotePath, deterministic: q.deterministic || false,
      }, note, 'buy'))
    }
    case 'sell': {
      const token = opt('token'); if (!token) fail('--token required')
      const note = parseNote()
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
      if (!file) fail('--file <path> required (png/jpeg/webp/gif ≤512KB)')
      const up = await uploadLogoFile(file)
      return out({ success: true, ...up, ui: LOGO_UI, next: `gang create --name … --symbol … --logo-uri ${up.logoUrl}` })
    }
    case 'create': {
      const name = opt('name'), symbol = opt('symbol'); if (!name || !symbol) fail('--name and --symbol required')
      try { assertCreateTarget(CONFIG.launchpad) } catch (e) { fail(e.message) }
      const note = parseNote()
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
        next: pending
          ? 'Ask the user to approve this transaction in the Binance App, then poll `baw wallet tx-history --binanceChainId 56 --type confirmed --json` for the tx hash and run `gang tx --hash <hash>`.'
          : (d.txHash ? `gang tx --hash ${d.txHash}` : undefined),
      })
    }
    case 'tx': {
      const hash = opt('hash'); if (!hash) fail('--hash required')
      const t = await decodeTx(hash)
      // a note committed in this tx is sent here if it's still in the local queue (e.g. after PENDING_CONFIRMATION),
      // or its state reported / refreshed if already sent; with an empty queue skip the extra RPC read
      let note
      if (hasQueued()) {
        try {
          const committed = hashesIn((await client.getTransaction({ hash })).input)
          if (committed.length) {
            const entry = findByHashes(committed)
            if (!entry) {
              note = { committed: committed[0], published: false, error: 'not_in_local_queue', hint: 'note was written on another machine, or the queue entry is older than 24h' }
            }
            else if (t.status !== 'success') note = { published: false, error: 'tx_failed' }
            else note = withRetry(await publishNote(entry, hash), hash)
          }
        } catch (e) {
          note = { published: false, error: `could not read tx input: ${e.message.split('\n')[0]}` }
        }
      }
      return out({ success: true, ...t, ...(note && { note }) })
    }
    default:
      console.log(HELP); process.exit(cmd ? 1 : 0)
  }
}

main().catch((e) => fail(e.message))
