/** Discovery for agents: ranked lists + a polling event stream, read from the gang.fun indexer API. */
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
const TRACKS = ['all', 'v3', 'fair', 'v2', 'soft']
// detail route per track (V2 / Soft details both live under /tokens) and trades route
const DETAIL = { v2: '/tokens', soft: '/tokens', v3: '/v3/tokens', fair: '/fair/sales' }
const TRADES = { v2: '/stocks/tokens', soft: '/tokens', v3: '/v3/tokens', fair: '/fair/sales' }

/**
 * GangLaunchpad rows: `v3` = V3 curves (/v3/tokens), `fair` = 打新 sales (/fair/sales; `graduated` = launched).
 * List rows carry raw wei and no USD; details (/…/<addr>) carry human amounts and USD like the V2 rows.
 * `quoteUsdOf(quoteAddress)` prices a list row's quote (from the V2 / Soft rows), null when unknown.
 */
function gangRow(r, quoteUsdOf) {
  const fair = r.track === 'fair'
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
    remainingUsd: quoteUsd ? usd(remaining * quoteUsd) : null,
    priceUsd: r.priceUsd ?? (quoteUsd ? num(r.priceQuote) * quoteUsd : null), fdvUsd: inUsd('fdvUsd', 'fdvQuote'),
    volume24hUsd: inUsd('volume24hUsd', 'volume24hQuote'), trades24h: num(r.trades24h), trades: num(r.trades),
    holders: r.holders != null ? num(r.holders) : fair ? num(r.participants) : null,
    ...(fair && { sharePrice: w(r.sharePrice), sharesLeft: num(r.sharesLeft), minWalletsLeft: num(r.minWalletsLeft) }),
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
  if (r.track === 'v3' || r.track === 'fair') return gangRow(r, quoteUsdOf)
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
  const priced = want('v3') || want('fair')
  const prices = (path) => get(`${path}${path.includes('?') ? '&' : '?'}limit=200`, stop).then((p) => ({ rows: p?.items || [] }), () => none)
  const [v3, fair, v2, soft] = await Promise.all([
    want('v3') ? pages('/v3/tokens?status=all', stop) : none,
    want('fair') ? pages('/fair/sales?status=all', stop) : none,
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
  const rows = [...v3.rows, ...fair.rows, ...(want('v2') ? v2.rows : []), ...(want('soft') ? soft.rows : [])]
  for (const r of rows) {
    const t = normalize(r, quoteUsdOf)
    if (!seen.has(t.address)) seen.set(t.address, t)
  }
  return { tokens: [...seen.values()], truncated: [v3, fair, v2, soft].some((p) => p.truncated) }
}

/** The command that acts on a token next: quote / preview a buy (no tx is sent before `gang execute`). */
const hint = (t) => {
  const amount = `--amount <amount in ${t.quote}>`
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
  for (const base of track ? [DETAIL[track]] : ['/tokens', '/v3/tokens', '/fair/sales']) {
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
export async function watch({ token, intervalSec = 10, minPct = 50, track = 'all', events = null, emit, shouldStop, stop }) {
  const want = (e) => !events || events.has(e)
  // wakes early once shouldStop() flips (e.g. --timeout) instead of overshooting a full interval
  const sleep = async (s) => {
    const end = Date.now() + s * 1000
    while (Date.now() < end && !shouldStop()) await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())))
  }

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

  const first = await fetchMarket(track, stop)
  // only grows: a token missing from one poll must not come back as new_token
  const known = new Map(first.tokens.map((t) => [t.address, t]))
  emit({ event: 'watching', mode: 'market', track, tokens: known.size, minPct, intervalSec }, { meta: true })
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
