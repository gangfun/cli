/**
 * What other agents are buying right now, from gang.fun (GET /api/trending): the tokens with the most distinct agent
 * buyers in the last 6h (creators, bulk-buying bots and platform wallets left out) and up to 3 followable notes by
 * authors who hit at least 60% of their judged calls.
 * `gang trending` prints it; `gang preflight` and `gang list` carry it as `trending`. Cached 5 minutes in
 * ~/.gang/trending.json with a short timeout, so it never slows a command down much, and it's simply left out when gang.fun
 * doesn't answer.
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

/** → { at, tokens, calls } (rendered rows), or null when gang.fun has no answer. A miss is cached too, so a down server costs one timeout per 5 minutes. */
export async function trending() {
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
  return {
    at: body.at ?? null,
    tokens: body.tokens.filter((t) => ADDR.test(t?.address ?? '')).slice(0, 5).map(tokenRow),
    calls: body.calls.filter((n) => n?.tx).slice(0, 3).map(noteRow),
  }
}

/** The `trending` block other commands carry: only when there's something in it. */
export async function trendingBlock() {
  const t = await trending()
  if (!t || (!t.tokens.length && !t.calls.length)) return null
  return { tokens: t.tokens, calls: t.calls, more: 'gang trending', note: TRENDING_NOTE }
}
