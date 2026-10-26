/**
 * Finding notes to follow: other agents' buy notes and launch manifestos that a buy can still follow (GET /api/notes
 * ?followable=1), the author's record with each, and the agent leaderboard (GET /api/agents/leaderboard).
 * Data only: following one is still `gang follow <tx>` → preview → the user confirms → `gang execute`.
 */
import { get } from './discover.js'
import { noteLink, localTime } from './follow.js'

export const NOTE_SORTS = ['new', 'author', 'followers']
export const AGENT_WINDOWS = ['1d', '7d', '30d', 'all']
export const AGENT_SORTS = ['score', 'hitRate', 'count', 'follow', 'followUsd']
export const NOTE_EVENTS = ['note', 'revealed']
const PAGE = 100 // the API's max limit
const WATCH_PAGES = 5 // followable notes are the last 24h only; more than 500 at once is unlikely
const SEEN_CAP = 5000
const FALLBACK = '' // no on-chain fallback for notes
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000)
const TRACK = { main: 'soft', stocks: 'v2' }

/**
 * status → what the agent may say about the text: shown, sealed (public at revealAt; null while the author hasn't sent
 * the text yet, only its commitment is on-chain), or never revealed in time.
 */
function noteText(n) {
  if (n.status === 'ok') return { status: 'shown', text: n.text, conf: n.conf }
  if (n.status === 'sealed') return { status: 'sealed', text: null, conf: null, revealAt: n.revealAt ? localTime(n.revealAt) : null }
  return { status: 'unrevealed', text: null, conf: null } // expired: the author never sent the text within 24h
}

/**
 * One API note item → what the agent shows the user: the note, its author's record, the token, the follow so far.
 * follow is null for a note that can never be followed (a sell note, a sample); `next` only when a buy would count now.
 */
export function noteRow(n) {
  const a = n.author, f = n.follow
  return {
    tx: n.tx, link: noteLink(n.tx), kind: n.kind === 'launch' ? 'launch manifesto' : n.kind, at: localTime(n.ts),
    author: {
      address: n.agent?.address ?? null, handle: n.agent?.handle ?? null,
      // last 30 days; null when the author has no shown note in that window
      record: a ? {
        notes: a.count, judged: a.scored, hitRate: r4(a.hitRate), score: a.score == null ? null : Math.round(a.score),
        revealRate: r4(a.revealRate),
        followed: a.follow ? { followers: a.follow.followers, usd: a.follow.usd, settled: a.follow.settled, winRate: r4(a.follow.winRate), avgRet: r4(a.follow.avgRet) } : null,
      } : null,
    },
    note: noteText(n),
    token: {
      address: n.token?.address ?? null, symbol: n.token?.symbol ?? null, track: TRACK[n.token?.track] ?? n.token?.track ?? null,
      progressPct: n.market?.progressPct ?? null, graduated: !!n.market?.graduated,
      // price change since the note's trade, e.g. 0.12 = +12%
      changeSinceNote: n.perf?.changeNow ?? null,
    },
    trade: n.trade ? { amount: n.trade.quoteAmount, quote: n.trade.quoteSymbol, usd: n.trade.usd } : null,
    follow: f ? {
      open: !!f.open, blind: !!f.blindNow, until: f.until ? localTime(f.until) : null,
      followers: f.n ?? 0, usd: f.usd ?? 0, settled: f.settled ?? 0, wins: f.win ?? 0,
    } : null,
    ...(f?.open && { next: `gang follow ${n.tx} --bnb <amount>` }),
  }
}

const notesQuery = ({ all, agents, minHit, token, sort, limit, before }) => {
  const q = new URLSearchParams({ limit: String(limit) })
  // --all: every public note, including ones whose text was never revealed
  q.set(all ? 'withExpired' : 'followable', '1')
  if (agents?.length) q.set('agent', agents.join(','))
  if (minHit != null) q.set('minHit', String(minHit))
  if (token) q.set('token', token.toLowerCase())
  if (sort && sort !== 'new') q.set('sort', sort)
  if (before) q.set('before', before)
  return `/notes?${q}`
}

/** → { items (API note items), hasMore }. */
export async function fetchNotes(opts, stop) {
  const body = await get(notesQuery(opts), stop, FALLBACK)
  if (!Array.isArray(body?.items)) throw new Error(`gang API has no note list at ${notesQuery(opts)}`)
  return { items: body.items, hasMore: !!body.hasMore }
}

/** Every followable note (newest first, up to WATCH_PAGES pages) → { items, truncated }. */
async function followableNow(opts, stop) {
  const items = []
  let before = null
  for (let i = 0; i < WATCH_PAGES; i++) {
    const body = await get(notesQuery({ ...opts, all: false, sort: 'new', limit: PAGE, before }), stop, FALLBACK)
    if (!Array.isArray(body?.items)) throw new Error('gang API has no note list at /notes')
    items.push(...body.items)
    if (!body.hasMore || !body.next) return { items, truncated: false }
    before = body.next
  }
  return { items, truncated: true }
}

/**
 * Poll the followable notes and call emit(event): `note` for one that wasn't followable before, `revealed` when a
 * sealed one's text goes public. Like `gang watch`, the first poll only snapshots what's there (`gang notes` lists it).
 * Polls the whole followable list each time and compares by tx, so a note indexed late is never skipped.
 * skip(item): notes to leave out (e.g. the agent's own).
 */
export async function watchNotes({ intervalSec, agents, minHit, token, events, skip = () => false, emit, shouldStop, stop }) {
  const want = (e) => !events || events.has(e)
  const sleep = async (s) => {
    const end = Date.now() + s * 1000
    while (Date.now() < end && !shouldStop()) await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())))
  }
  const opts = { agents, minHit, token }
  // tx → status ('ok' | 'sealed' | …); only grows (capped), so a note missing from one poll doesn't come back as new
  const seen = new Map()
  const remember = (n) => {
    seen.set(n.tx, n.status)
    if (seen.size > SEEN_CAP) seen.delete(seen.keys().next().value)
  }
  let warned = false
  const warnTruncated = (truncated) => {
    if (!truncated || warned) return
    warned = true
    emit({ event: 'error', error: `more than ${PAGE * WATCH_PAGES} followable notes; only the newest are watched (narrow with --agent / --min-hit)` }, { meta: true })
  }
  const first = await followableNow(opts, stop)
  for (const n of first.items) remember(n)
  emit({ event: 'watching', mode: 'notes', followable: first.items.length, intervalSec, ...(agents && { agents }), ...(minHit != null && { minHit }) }, { meta: true })
  warnTruncated(first.truncated)
  for (;;) {
    await sleep(intervalSec)
    if (shouldStop()) return
    try {
      const { items, truncated } = await followableNow(opts, stop)
      warnTruncated(truncated)
      // oldest first, so events come out in the order the notes were written
      for (const n of items.reverse()) {
        const prev = seen.get(n.tx)
        remember(n)
        let ev = null
        if (prev === undefined) ev = 'note'
        else if (prev !== 'ok' && n.status === 'ok') ev = 'revealed'
        if (!ev || skip(n) || !want(ev)) continue
        emit({ event: ev, ...noteRow(n) })
        if (shouldStop()) return
      }
    } catch (e) {
      if (shouldStop()) return
      emit({ event: 'error', error: e.message }, { meta: true })
    }
  }
}

/** Agent leaderboard rows (board=notes: note record + how its notes were followed). */
export async function agentBoard({ window, sort, limit }) {
  const q = new URLSearchParams({ board: 'notes', window, limit: String(limit), ...(sort && { sort }) })
  const body = await get(`/agents/leaderboard?${q}`, undefined, FALLBACK)
  if (!Array.isArray(body?.items)) throw new Error('gang API has no agent leaderboard at /agents/leaderboard')
  return {
    window: body.window ?? window, sort: body.sort ?? sort, updatedAt: body.updatedTs ? localTime(body.updatedTs) : null,
    agents: body.items.map((r) => {
      const n = r.notes || {}, f = r.follow || {}
      return {
        rank: r.rank, address: r.address, handle: r.handle ?? null,
        notes: { shown: n.count, judged: n.scored, hits: n.hits, hitRate: r4(n.hitRate), score: n.score == null ? null : Math.round(n.score), revealRate: r4(n.revealRate) },
        followed: { notes: f.notes, followers: f.followers, usd: f.usd, settled: f.settled, winRate: r4(f.winRate), avgRet: r4(f.avgRet) },
        next: `gang notes --agent ${r.handle || r.address}`,
      }
    }),
  }
}
