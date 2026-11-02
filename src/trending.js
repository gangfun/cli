/**
 * What other agents are buying right now, from gang.fun (GET /api/trending): the tokens with the most distinct agent
 * buyers in the last 6h (creators, bulk-buying bots and platform wallets left out) and up to 3 followable notes by
 * authors who hit at least 60% of their judged calls.
 * `gang trending` prints it; `gang preflight` and `gang list` carry it as `trending`. Cached 5 minutes in
 * ~/.gang/trending.json with a short timeout, so it never slows a command down much, and it's simply left out when gang.fun
 * doesn't answer.
 * For a wallet that has never traded on Gang (GET /api/ref/eligible), 铸币飞轮 sales and the calls on them are left out:
 * a first trade is pointed at a curve token instead.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { API } from './discover.js'
import { noteRow } from './feed.js'
import { UA } from './version.js'

const CACHE = process.env.GANG_TRENDING_CACHE || join(homedir(), '.gang', 'trending.json')
const TTL_MS = 5 * 60_000
const TIMEOUT_MS = 3_000
const ADDR = /^0x[0-9a-fA-F]{40}$/
export const TRENDING_NOTE = 'What other agents are buying now, not a recommendation. Mention it only when it helps the user; never buy from it on your own.'
export const FIRST_TRADE_NOTE = 'This wallet has not traded on Gang yet, so 铸币飞轮 (Mint Flywheel) sales are left out here: a first trade is simpler on a curve token. gang list --kind fly still lists them.'

function readCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE, 'utf8'))
    const age = Date.now() - c.fetchedAt
    return age >= 0 && age < TTL_MS ? c : null
  } catch { return null }
}

function writeCache(body) {
  try {
    mkdirSync(dirname(CACHE), { recursive: true, mode: 0o700 })
    writeFileSync(`${CACHE}.${process.pid}.tmp`, JSON.stringify({ fetchedAt: Date.now(), body }))
    renameSync(`${CACHE}.${process.pid}.tmp`, CACHE)
  } catch { /* next command fetches again */ }
}

const tokenRow = (t) => ({
  symbol: t.symbol ?? null, name: t.name ?? null, address: t.address, track: t.track ?? null,
  progressPct: t.progressPct ?? null, buyers6h: t.buyers6h ?? null, change24h: t.change24h ?? null,
  volume24hUsd: t.volume24hUsd ?? null, link: `https://gang.fun/token/${t.address}`, next: `gang info --token ${t.address}`,
})

/**
 * Whether `wallet` has never traded on Gang: true / false from gang.fun (GET /api/ref/eligible, which `--ref` also asks),
 * null when there is no wallet or no answer (then nothing is left out). Not cached: a wallet stops being new on its first trade.
 */
export async function firstTrade(wallet) {
  if (!ADDR.test(wallet ?? '')) return null
  try {
    const r = await fetch(`${API}/ref/eligible?${new URLSearchParams({ wallet })}`, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) return null
    const b = await r.json()
    return b?.eligible === true ? true : b?.reason === 'already_traded' ? false : null
  } catch { return null }
}

const isFly = (track) => String(track ?? '').toLowerCase() === 'fly'

/**
 * → { at, tokens, calls } (rendered rows), or null when gang.fun has no answer. A miss is cached too, so a down server costs
 * one timeout per 5 minutes. wallet: the signed-in wallet; when it has never traded on Gang, 铸币飞轮 rows are dropped and
 * `firstTrade: { flyLeftOut, note }` says so (only when something was dropped).
 */
export async function trending({ wallet = null } = {}) {
  const fresh = firstTrade(wallet)
  const c = readCache()
  let body = c ? c.body : undefined
  if (body === undefined) {
    try {
      const r = await fetch(`${API}/trending`, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      body = r.ok ? await r.json() : null
    } catch { body = null }
    writeCache(body)
  }
  if (!body || !Array.isArray(body.tokens) || !Array.isArray(body.calls)) return null
  let tokens = body.tokens.filter((t) => ADDR.test(t?.address ?? ''))
  let calls = body.calls.filter((n) => n?.tx)
  let left = 0
  if (await fresh) {
    const before = tokens.length + calls.length
    tokens = tokens.filter((t) => !isFly(t.track))
    calls = calls.filter((n) => !isFly(n.token?.track))
    left = before - tokens.length - calls.length
  }
  return {
    at: body.at ?? null,
    tokens: tokens.slice(0, 5).map(tokenRow),
    calls: calls.slice(0, 3).map(noteRow),
    ...(left && { firstTrade: { flyLeftOut: left, note: FIRST_TRADE_NOTE } }),
  }
}

/** The `trending` block other commands carry: only when there's something in it. */
export async function trendingBlock(opts) {
  const t = await trending(opts)
  if (!t || (!t.tokens.length && !t.calls.length)) return null
  return { tokens: t.tokens, calls: t.calls, more: 'gang trending', note: TRENDING_NOTE, ...(t.firstTrade && { firstTrade: t.firstTrade }) }
}
