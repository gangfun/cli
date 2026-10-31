/** Discovery for agents: ranked lists + an event stream (Server-Sent Events, or polling), read from the gang.fun indexer API. */
import { websiteError, twitterError } from './links.js'
import { UA } from './version.js'

export const API = (process.env.GANG_API || 'https://gang.fun/api').replace(/\/+$/, '')

const SOFT_GRAD_BNB = 20
const MILESTONES = [25, 50, 75, 90]
const MARKET_PAGES = 10 // × 200 rows per track
const TRADE_PAGE = 50
const TRADE_PAGES = 4
const SEEN_CAP = 2000
const num = (v) => (v == null || v === '' ? 0 : Number(v))
const usd = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const now = () => Math.floor(Date.now() / 1000)

/**
 * GET API + path → parsed JSON, null on 404. `stop` (optional AbortSignal) cancels an in-flight request, e.g. when
 * `gang watch --timeout` expires. `fallback`: what to suggest when the API is unreachable.
 */
export async function get(path, stop, fallback = 'On-chain fallback without volume: `gang list`') {
  // own controller instead of AbortSignal.any (Node ≥20.3); listener removed after each request so a
  // long-lived `stop` signal doesn't pile up one listener per poll
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error('timed out after 15s')), 15_000)
  const onStop = () => ctl.abort(new Error('stopped'))
  if (stop?.aborted) onStop()
  else stop?.addEventListener('abort', onStop, { once: true })
  try {
    let r
    try {
      r = await fetch(`${API}${path}`, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } })
    } catch (e) {
      if (stop?.aborted) throw e
      throw new Error(`gang API unreachable (${API}${path}): ${ctl.signal.reason?.message || e.message}${fallback ? `. ${fallback}` : ''}`)
    }
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`gang API ${r.status} on ${path}`)
    try {
      return await r.json()
    } catch (e) {
      // body read can also hit the 15s timeout or a truncated/non-JSON body; keep the path in the message
      if (stop?.aborted) throw e
      throw new Error(`gang API bad response on ${path}: ${ctl.signal.reason?.message || e.message}`)
    }
  } finally {
    clearTimeout(timer)
    stop?.removeEventListener('abort', onStop)
  }
}

/** "90" | "45s" | "30m" | "2h" | "1d" → seconds */
export function parseDuration(raw, name) {
  const m = String(raw ?? '').trim().match(/^(\d+(?:\.\d+)?)([smhd]?)$/i)
  if (!m) throw new Error(`--${name} must look like 90, 45s, 30m, 2h or 1d (got ${raw})`)
  return Math.round(Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()])
}

const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
// BSC USDT / USDC: $1 when no V2 row prices them
const STABLES = ['0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d']
const TRACKS = ['all', 'v3', 'fair', 'fly', 'v2', 'soft']
// detail route per track (V2 / Soft details both live under /tokens) and trades route
const DETAIL = { v2: '/tokens', soft: '/tokens', v3: '/v3/tokens', fair: '/fair/sales', fly: '/fly/tokens' }
const TRADES = { v2: '/stocks/tokens', soft: '/tokens', v3: '/v3/tokens', fair: '/fair/sales', fly: '/fly/tokens' }

/**
 * GangLaunchpad rows: `v3` = V3 curves (/v3/tokens), `fair` = 打新 sales (/fair/sales; `graduated` = launched); GangFlywheelPad
 * rows: `fly` = 铸币飞轮 sales (/fly/tokens, shaped like the 打新 rows; launched ones may still mint).
 * List rows carry raw wei and no USD; details (/…/<addr>) carry human amounts and USD like the V2 rows.
 * `quoteUsdOf(quoteAddress)` prices a list row's quote (from the V2 / Soft rows), null when unknown.
 */
function gangRow(r, quoteUsdOf) {
  // a 铸币飞轮 row reads like a 打新 one (sharePrice = basePrice, raiseQuote, sold of 10,000)
  const fair = r.track === 'fair' || r.track === 'fly'
  const dec = r.quoteDecimals ?? 18
  const w = (v) => num(v) / 10 ** dec
  const detail = r.raisedQuote != null
  const graduated = !!r.graduated || r.status === 'launched'
  const raised = detail ? num(r.raisedQuote) : fair ? w(r.sharePrice) * num(r.sold) : w(r.realQuote)
  const target = detail ? num(r.gradAmtQuote) : fair ? w(r.raiseQuote) : w(r.gradAmt)
  const remaining = graduated ? 0 : detail ? num(r.graduationRemainingQuote) : Math.max(0, target - raised)
  const quoteUsd = num(r.quoteUsd) || quoteUsdOf(r.quoteAddress) || null
  const inUsd = (field, quoteField) => (r[field] != null ? usd(num(r[field])) : quoteUsd ? usd(num(r[quoteField]) * quoteUsd) : null)
  return {
    address: r.address, symbol: r.symbol, name: r.name, track: r.track,
    quote: r.quoteSymbol || '?', quoteAddress: r.quoteAddress || null,
    // 打新: the 1% pool tax after launch; V3: its own buy / sell tax, pool only
    taxed: fair || num(r.buyTaxBps) > 0 || num(r.sellTaxBps) > 0,
    graduated, pair: r.pair || null,
    progressPct: num(r.progressPct), raised, graduationTarget: target, remaining,
    // a V3 curve's target in BNB raised (2.0: the creator's pick) when gang.fun sends it; graduationTarget is it in the quote
    ...(r.track === 'v3' && r.gradTargetBnb != null && { graduationTargetBnb: num(r.gradTargetBnb) }),
    remainingUsd: quoteUsd ? usd(remaining * quoteUsd) : null,
    priceUsd: r.priceUsd ?? (quoteUsd ? num(r.priceQuote) * quoteUsd : null), fdvUsd: inUsd('fdvUsd', 'fdvQuote'),
    volume24hUsd: inUsd('volume24hUsd', 'volume24hQuote'), trades24h: num(r.trades24h), trades: num(r.trades),
    holders: r.holders != null ? num(r.holders) : fair ? num(r.participants) : null,
    ...(fair && { sharePrice: w(r.sharePrice), sharesLeft: num(r.sharesLeft), minWalletsLeft: num(r.minWalletsLeft) }),
    // mintPaused: gang.fun's code for why post-launch mints are refused now (below_average, …), null when not paused
    ...(r.track === 'fly' && {
      status: r.status ?? null, postMint: !!r.postMint, mintPaused: r.mintPaused ?? null, baseQuota: num(r.baseQuota), inviteBonus: num(r.inviteBonus),
    }),
    createdAt: r.createdAt, ageMin: r.createdAt ? Math.floor((now() - r.createdAt) / 60) : null,
    lastTradeAt: r.lastTradeAt || r.lastActivityAt || null, creatorHandle: r.creatorHandle || null, logoUrl: r.logoUrl || null,
    website: r.website && !websiteError(r.website) ? r.website : null,
    twitter: r.twitter && !twitterError(r.twitter) ? r.twitter : null,
  }
}

/**
 * One shape for every API track: GangLaunchpad `v3` / `fair` (gangRow), `v2` = quote-ERC20 curves (/stocks/tokens,
 * LaunchpadV2 family), `soft` = legacy BNB curve (/tokens, 20 BNB graduation). Amounts are human units of `quote`.
 */
export function normalize(r, quoteUsdOf = () => null) {
  if (r.track === 'v3' || r.track === 'fair' || r.track === 'fly') return gangRow(r, quoteUsdOf)
  const v2 = r.track === 'stocks'
  const quote = v2 ? (r.quoteSymbol || '?') : 'BNB'
  const raised = v2 ? num(r.raisedQuote) : num(r.raisedBnb)
  const target = v2 ? num(r.gradAmtQuote) : SOFT_GRAD_BNB
  const remaining = r.graduated ? 0 : (v2 ? num(r.graduationRemainingQuote) : Math.max(0, target - raised))
  const quoteUsd = v2 ? num(r.quoteUsd) : num(r.bnbUsd)
  return {
    address: r.address, symbol: r.symbol, name: r.name, track: v2 ? 'v2' : 'soft',
    quote, quoteAddress: v2 ? r.quoteAddress : null, taxed: v2 ? !!r.taxed : false,
    graduated: !!r.graduated, pair: r.pair || null,
    progressPct: num(r.progressPct), raised, graduationTarget: target, remaining,
    remainingUsd: quoteUsd ? usd(remaining * quoteUsd) : null,
    priceUsd: r.priceUsd ?? null, fdvUsd: usd(num(r.fdvUsd)),
    volume24hUsd: usd(num(r.volume24hUsd)), trades24h: num(r.trades24h), trades: num(r.trades), holders: num(r.holders),
    createdAt: r.createdAt, ageMin: r.createdAt ? Math.floor((now() - r.createdAt) / 60) : null,
    lastTradeAt: r.lastTradeAt || null, creatorHandle: r.creatorHandle || null, logoUrl: r.logoUrl || null,
    // the creator's links from the create tx (V2, CLI ≥0.7.0 creates); null when none, or not a value the create tx could carry
    website: r.website && !websiteError(r.website) ? r.website : null,
    twitter: r.twitter && !twitterError(r.twitter) ? r.twitter : null,
  }
}

async function pages(path, stop) {
  const rows = []
  for (let offset = 0, i = 0; i < MARKET_PAGES; i++) {
    const sep = path.includes('?') ? '&' : '?'
    const page = await get(`${path}${sep}limit=200&offset=${offset}`, stop)
    // list routes always exist: a 404 is an outage, never "no tokens"
    if (!page) throw new Error(`gang API 404 on ${path}`)
    rows.push(...(page.items || []))
    if (!page.hasMore || page.nextOffset == null) return { rows, truncated: false }
    offset = page.nextOffset
  }
  return { rows, truncated: true }
}

/** All indexed tokens, normalized and de-duplicated. track: all | v3 | fair | v2 | soft */
export async function fetchMarket(track = 'all', stop) {
  if (!TRACKS.includes(track)) throw new Error(`--track must be ${TRACKS.join(', ')} (got ${track})`)
  const none = { rows: [], truncated: false }
  const want = (t) => track === 'all' || track === t
  // the GangLaunchpad list rows have no USD: the V2 / Soft rows price their quotes. A track not listed is read for that
  // only, one page and best effort: no truncation, and a failure just leaves the USD fields null
  const priced = want('v3') || want('fair') || want('fly')
  const prices = (path) => get(`${path}${path.includes('?') ? '&' : '?'}limit=200`, stop).then((p) => ({ rows: p?.items || [] }), () => none)
  const [v3, fair, fly, v2, soft] = await Promise.all([
    want('v3') ? pages('/v3/tokens?status=all', stop) : none,
    want('fair') ? pages('/fair/sales?status=all', stop) : none,
    // 铸币飞轮 (2026-10-30): a server without the route yet lists none, unless --track fly asked for it alone
    want('fly') ? pages('/fly/tokens?status=all', stop).catch((e) => (track === 'fly' ? Promise.reject(e) : none)) : none,
    want('v2') ? pages('/stocks/tokens', stop) : priced ? prices('/stocks/tokens') : none,
    want('soft') ? pages('/tokens?sort=new', stop) : priced ? prices('/tokens?sort=new') : none,
  ])
  const usdOf = new Map()
  for (const r of v2.rows) if (num(r.quoteUsd) > 0 && r.quoteAddress) usdOf.set(r.quoteAddress.toLowerCase(), num(r.quoteUsd))
  const bnbUsd = soft.rows.find((r) => num(r.bnbUsd) > 0)?.bnbUsd
  if (!usdOf.has(WBNB) && bnbUsd) usdOf.set(WBNB, num(bnbUsd))
  for (const a of STABLES) if (!usdOf.has(a)) usdOf.set(a, 1)
  const quoteUsdOf = (a) => (a ? usdOf.get(a.toLowerCase()) ?? null : null)
  const seen = new Map()
  const rows = [...v3.rows, ...fair.rows, ...fly.rows, ...(want('v2') ? v2.rows : []), ...(want('soft') ? soft.rows : [])]
  for (const r of rows) {
    const t = normalize(r, quoteUsdOf)
    if (!seen.has(t.address)) seen.set(t.address, t)
  }
  return { tokens: [...seen.values()], truncated: [v3, fair, fly, v2, soft].some((p) => p.truncated) }
}

/** The command that acts on a token next: quote / preview a buy (no tx is sent before `gang execute`). */
const hint = (t) => {
  const amount = `--amount <amount in ${t.quote}>`
  // 铸币飞轮: minting before launch, and after it while the server's postMint flag is on (gang mint picks the post-launch
  // mint); a filled sale waits for its launch, a refund-only one only sells back
  if (t.track === 'fly' && t.status === 'filled') return `gang info --token ${t.address}`
  if (t.track === 'fly' && t.status === 'refund') return `gang withdraw --token ${t.address} --all`
  // launched with post-launch minting paused (gang.fun's mintPaused, from the same reads as the pad): the pool, not a mint
  if (t.track === 'fly' && (!t.graduated || (t.postMint && !t.mintPaused))) return `gang mint --token ${t.address} --shares <n>`
  if (t.graduated) return `gang buy --token ${t.address} ${amount}` // the PancakeSwap pool, through GangRouter
  if (t.track === 'fair') return `gang mint --token ${t.address} --shares <n>`
  if (t.track === 'v3') return `gang buy --token ${t.address} ${amount}`
  return `gang quote --token ${t.address} ${amount}`
}
const withHint = (t) => ({ ...t, next: hint(t) })

/** hot = 24h USD volume on the curve; new = newest first; near-grad = closest to graduation. */
export function rank(tokens, sort, { limit = 10, minPct = 50, maxAgeSec = null, includeGraduated = false } = {}) {
  let list = includeGraduated ? tokens : tokens.filter((t) => !t.graduated)
  if (sort === 'hot') {
    // graduated rows carry DEX volume with trades24h = 0, so volume alone also qualifies
    list = list.filter((t) => t.trades24h > 0 || t.volume24hUsd > 0)
      .sort((a, b) => ((b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)) || (b.trades24h - a.trades24h))
  } else if (sort === 'new') {
    const t0 = now()
    if (maxAgeSec != null) list = list.filter((t) => t0 - t.createdAt <= maxAgeSec)
    list.sort((a, b) => b.createdAt - a.createdAt)
  } else if (sort === 'near-grad') {
    list = list.filter((t) => !t.graduated && t.progressPct >= minPct)
      .sort((a, b) => (b.progressPct - a.progressPct) || ((a.remainingUsd ?? Infinity) - (b.remainingUsd ?? Infinity)))
  }
  return list.slice(0, limit).map(withHint)
}

/** One token's detail. `track` known (later polls): its own route; else each route in turn. */
async function tokenDetail(addr, stop, track) {
  const a = addr.toLowerCase()
  for (const base of track ? [DETAIL[track]] : ['/tokens', '/v3/tokens', '/fair/sales', '/fly/tokens']) {
    const r = await get(`${base}/${a}`, stop)
    if (r) return normalize(r)
  }
  throw new Error(`token not indexed by ${API}: ${addr}. On-chain view: \`gang info --token ${addr}\``)
}

/** One page of trades, newest first. */
async function tradePage(t, offset = 0, stop) {
  const page = await get(`${TRADES[t.track]}/${t.address}/trades?limit=${TRADE_PAGE}&offset=${offset}`, stop)
  const items = (page?.items || []).map((x) => ({
    side: x.side, trader: x.trader, traderHandle: x.traderHandle || null,
    amount: num(x.quoteIn ?? x.bnb), quote: t.quote, tokens: num(x.tokens),
    price: num(x.price), at: x.ts, tx: x.tx,
  }))
  return { items, next: page?.hasMore && page.nextOffset != null ? page.nextOffset : null }
}

const tradeKey = (x) => `${x.tx}:${x.side}:${x.trader}:${x.tokens}`

/**
 * Trades not in `seen`, oldest first. Pages back until a page contains a known trade; `gap` = gave up
 * after TRADE_PAGES pages of only-unseen trades, so older ones in between were skipped.
 */
async function freshTrades(t, seen, stop) {
  const fresh = []
  const local = new Set() // offsets shift when trades land mid-pagination → same row on two pages
  for (let offset = 0, i = 0; i < TRADE_PAGES; i++) {
    const { items, next } = await tradePage(t, offset, stop)
    let hit = false
    for (const x of items) {
      const k = tradeKey(x)
      if (seen.has(k)) hit = true
      else if (!local.has(k)) { local.add(k); fresh.push(x) }
    }
    if (hit || next == null) return { fresh: fresh.reverse(), gap: false }
    offset = next
  }
  return { fresh: fresh.reverse(), gap: true }
}

// --- market mode over Server-Sent Events (GET /stream): the server compares its board snapshots, we only normalize ---
const MARKET_EVENTS = ['new_token', 'near_grad', 'graduated']
const STREAM_STALL_MS = 45_000 // the server pings every 15 s: this long without a byte is a dead connection
const STREAM_BACKOFF = [1, 2, 5, 10, 30] // seconds before reconnect n (the last repeats)

/** Wait s seconds, waking early once shouldStop() flips (e.g. --timeout) instead of overshooting. */
async function pause(s, shouldStop) {
  const end = Date.now() + s * 1000
  while (Date.now() < end && !shouldStop()) await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())))
}

/** SSE messages ({ id, data }) from a fetch body; onBytes() on every chunk (stall watchdog). Comments are skipped. */
export async function* sseMessages(body, onBytes = () => {}) {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    onBytes()
    buf += dec.decode(chunk, { stream: true }).replace(/\r/g, '')
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let id = null
      const data = []
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue
        const k = line.indexOf(':')
        const field = k < 0 ? line : line.slice(0, k)
        const value = k < 0 ? '' : line.slice(k + 1).replace(/^ /, '')
        if (field === 'data') data.push(value)
        else if (field === 'id') id = value
      }
      if (data.length) yield { id, data: data.join('\n') }
    }
  }
}

/**
 * A stream event's USD per quote: the server's price of the row's quote (GANG, …), else WBNB at its BNB price and the BSC
 * stables at $1 (a server from before quoteUsd), else unknown.
 */
const quoteUsdFrom = ({ quoteUsd, rate }) => (a) => {
  if (Number(quoteUsd) > 0) return Number(quoteUsd)
  const x = a?.toLowerCase()
  if (x === WBNB) return Number(rate) > 0 ? Number(rate) : null
  return STABLES.includes(x) ? 1 : null
}

/**
 * Market mode from GET /stream. Resolves 'done' (stopped: --timeout / --max-events), 'unavailable' (the server
 * has no stream: the caller polls instead) or 'poll' (it went away mid-run: the caller polls from a fresh snapshot).
 * Reconnects with Last-Event-ID, so the server replays what a dropped connection missed; events received after the
 * last snapshot line are not emitted twice.
 */
export async function streamMarket({ track = 'all', minPct = 50, events = null, emit, shouldStop, stop }) {
  if (!TRACKS.includes(track)) throw new Error(`--track must be ${TRACKS.join(', ')} (got ${track})`)
  const want = (e) => !events || events.has(e)
  const q = new URLSearchParams({ track, minPct: String(minPct) })
  const asked = events ? MARKET_EVENTS.filter((e) => events.has(e)) : []
  if (asked.length) q.set('events', asked.join(','))
  let lastId = null
  let started = false
  let failures = 0
  let partial = new Set() // events since the last snapshot line: a reconnect replays them
  let replayed = new Set() // the ones to skip in the replay now coming in

  for (;;) {
    if (shouldStop()) return 'done'
    const ctl = new AbortController()
    const onStop = () => ctl.abort(new Error('stopped'))
    if (stop?.aborted) onStop()
    else stop?.addEventListener('abort', onStop, { once: true })
    let lastByte = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastByte > STREAM_STALL_MS) ctl.abort(new Error(`no data for ${STREAM_STALL_MS / 1000}s`))
    }, 5000)
    let reason = null
    try {
      const r = await fetch(`${API}/stream?${q}`, {
        signal: ctl.signal,
        headers: { accept: 'text/event-stream', 'user-agent': UA, ...(lastId && { 'last-event-id': lastId }) },
      })
      const sse = r.ok && /^text\/event-stream/.test(r.headers.get('content-type') || '')
      if (!sse) {
        await r.body?.cancel().catch(() => {})
        // no stream route (an older server, 404) or not for us (400, 429 too many streams, 503 warming): poll instead
        if (!started) return 'unavailable'
        if (r.status === 404 || r.status === 400 || r.ok) return 'poll'
        throw new Error(`gang API ${r.status} on /stream`)
      }
      if (started) {
        replayed = partial
        partial = new Set()
      }
      for await (const { id, data } of sseMessages(r.body, () => { lastByte = Date.now() })) {
        let m
        try { m = JSON.parse(data) } catch { continue }
        if (m.event === 'ready') {
          failures = 0
          if (!started) {
            started = true
            emit({ event: 'watching', mode: 'market', transport: 'stream', track, tokens: m.tokens, minPct }, { meta: true })
          }
          if (id) lastId = id
          if (!m.resumed) replayed = new Set() // nothing replayed: the next events are all new
        } else if (m.event === 'snapshot') {
          lastId = id || String(m.at)
          partial = new Set()
          replayed = new Set()
        } else if (m.event === 'gap') {
          replayed = new Set()
          emit({ event: 'error', error: 'stream reconnected too late: changes while it was down were missed' }, { meta: true })
        } else if (MARKET_EVENTS.includes(m.event) && m.row) {
          const key = `${m.event}:${String(m.row.address).toLowerCase()}`
          // still in partial: if this connection drops before its snapshot line too, the next replay has it again
          partial.add(key)
          if (replayed.has(key)) continue
          if (!want(m.event)) continue
          const t = normalize(m.row, quoteUsdFrom(m))
          if (m.event === 'new_token') emit({ event: 'new_token', ...withHint(t) })
          else if (m.event === 'graduated') emit({ event: 'graduated', ...brief(t), pair: t.pair })
          else emit({ event: 'near_grad', ...brief(t), next: hint(t) })
        }
        if (shouldStop()) return 'done'
      }
      reason = 'the server closed the stream'
    } catch (e) {
      if (shouldStop()) return 'done'
      // a startup failure: polling reports the API being down in its own words
      if (!started) return 'unavailable'
      reason = ctl.signal.reason?.message || e.message
    } finally {
      clearInterval(watchdog)
      stop?.removeEventListener('abort', onStop)
      ctl.abort()
    }
    const wait = STREAM_BACKOFF[Math.min(failures++, STREAM_BACKOFF.length - 1)]
    emit({ event: 'error', error: `stream: ${reason}; reconnecting in ${wait}s` }, { meta: true })
    await pause(wait, shouldStop)
  }
}

const crossed = (prev, cur, levels) => levels.filter((m) => prev < m && cur >= m)
const brief = (t) => ({
  token: t.address, symbol: t.symbol, track: t.track, quote: t.quote, progressPct: t.progressPct,
  remaining: t.remaining, remainingUsd: t.remainingUsd, volume24hUsd: t.volume24hUsd, holders: t.holders,
})

/**
 * Poll the API and call emit(event) for each change. Token mode: trade / progress / graduated.
 * Market mode: new_token / near_grad (crossing minPct upward) / graduated.
 * The first tick only snapshots state; current matches come from `gang near-grad` / `gang new`.
 * `stop` (AbortSignal) cancels in-flight requests; errors after shouldStop() flips are dropped, not emitted.
 */
export async function watch({ token, intervalSec = 10, minPct = 50, track = 'all', events = null, poll = false, emit, shouldStop, stop }) {
  const want = (e) => !events || events.has(e)
  const sleep = (s) => pause(s, shouldStop)

  if (token) {
    // graduation always ends a token watch; when --events filters it out, end with a meta line instead
    const finish = (t) => (want('graduated')
      ? emit({ event: 'graduated', ...brief(t), pair: t.pair })
      : emit({ event: 'ended', reason: 'graduated', token: t.address, pair: t.pair }, { meta: true }))
    let t = await tokenDetail(token, stop)
    const seen = new Set((await tradePage(t, 0, stop)).items.map(tradeKey))
    const remember = (k) => {
      seen.add(k)
      if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value) // Set keeps insertion order → drops oldest
    }
    emit({ event: 'watching', mode: 'token', ...brief(t), graduated: t.graduated, intervalSec }, { meta: true })
    if (t.graduated) return finish(t)
    for (;;) {
      await sleep(intervalSec)
      if (shouldStop()) return
      try {
        const cur = await tokenDetail(token, stop, t.track)
        const { fresh, gap } = await freshTrades(cur, seen, stop)
        // advance state only after both reads succeed, so a failed tick can't swallow a prev → cur transition
        const prev = t
        t = cur
        if (gap) emit({ event: 'error', error: `more than ${TRADE_PAGE * TRADE_PAGES} trades since last poll; older ones skipped` }, { meta: true })
        for (const x of fresh) {
          remember(tradeKey(x))
          if (want('trade')) emit({ event: 'trade', token: t.address, symbol: t.symbol, ...x, progressPct: t.progressPct })
          if (shouldStop()) return
        }
        for (const m of crossed(prev.progressPct, t.progressPct, MILESTONES)) {
          if (want('progress')) emit({ event: 'progress', milestone: m, ...brief(t), next: hint(t) })
          if (shouldStop()) return
        }
        if (!prev.graduated && t.graduated) return finish(t)
      } catch (e) {
        if (shouldStop()) return
        emit({ event: 'error', error: e.message }, { meta: true })
      }
      if (shouldStop()) return
    }
  }

  // market mode: the server's stream when it has one (one connection instead of every list every interval)
  if (!poll) {
    const how = await streamMarket({ track, minPct, events, emit, shouldStop, stop })
    if (how === 'done') return
    if (how === 'poll') emit({ event: 'error', error: 'stream no longer offered; polling from here (changes in between not replayed)' }, { meta: true })
  }
  const first = await fetchMarket(track, stop)
  // only grows: a token missing from one poll must not come back as new_token
  const known = new Map(first.tokens.map((t) => [t.address, t]))
  emit({ event: 'watching', mode: 'market', transport: 'poll', track, tokens: known.size, minPct, intervalSec }, { meta: true })
  let warned = false
  const warnTruncated = (truncated) => {
    if (!truncated || warned) return
    warned = true
    emit({ event: 'error', error: `market list capped at ${MARKET_PAGES * 200} tokens per track; tokens beyond the cap are not watched` }, { meta: true })
  }
  warnTruncated(first.truncated)
  for (;;) {
    await sleep(intervalSec)
    if (shouldStop()) return
    try {
      const { tokens, truncated } = await fetchMarket(track, stop)
      warnTruncated(truncated)
      for (const t of tokens) {
        const prev = known.get(t.address)
        known.set(t.address, t)
        const out = []
        if (!prev) out.push({ event: 'new_token', ...withHint(t) })
        else if (!prev.graduated && t.graduated) out.push({ event: 'graduated', ...brief(t), pair: t.pair })
        else if (!t.graduated && prev.progressPct < minPct && t.progressPct >= minPct) {
          out.push({ event: 'near_grad', ...brief(t), next: hint(t) })
        }
        for (const ev of out) {
          if (want(ev.event)) emit(ev)
          if (shouldStop()) return
        }
      }
    } catch (e) {
      if (shouldStop()) return
      emit({ event: 'error', error: e.message }, { meta: true })
    }
  }
}
