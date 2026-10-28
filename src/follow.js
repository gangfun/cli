/**
 * Follow trades: a buy that names the note it follows (follow ref in the calldata, see notes.js).
 * gang.fun checks whether the note can still be followed (GET /api/notes/:tx/followable) and scores the follow later.
 */
import { formatUnits } from 'viem'
import { API } from './discover.js'
import { fetchError, statusError, why } from './logo.js'
import { UA } from './version.js'

export const NOTE_TX = /^0x[0-9a-fA-F]{64}$/
export const MIN_FOLLOW_USD = 1 // gang.fun doesn't count a follow paying less
const SITE = /\/api$/.test(API) ? API.slice(0, -4) : 'https://gang.fun'
export const noteLink = (tx) => `${SITE}/note/${tx.toLowerCase()}`

const NOT_FOUND_RETRIES = 3
const RETRY_MS = Number(process.env.GANG_FOLLOW_RETRY_MS || 3000) // env only to make tests fast

export const REASONS = {
  not_found: 'no note with this tx on gang.fun: wrong hash, or the note landed seconds ago and is not indexed yet (try again in a minute)',
  not_followable: 'only buy notes and launch manifestos can be followed (this is a sell note or a sample)',
  expired: 'too late to follow: the 24h follow window passed, the token graduated, or the note was never revealed',
  graduated: 'the token graduated; only curve buys count as follows',
  self: 'this is your own note; you can\'t follow yourself',
  wrong_token: 'this note is about a different token',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(path, timeoutMs = 10_000) {
  let r
  try {
    r = await fetch(`${API}${path}`, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw fetchError(`gang API unreachable (${API}): ${why(e)}`, e)
  }
  let body = null
  try { body = await r.json() } catch { /* status code is enough */ }
  if (body?.error === 'unknown route') {
    throw new Error(`${API} can't check follows yet (no /notes/:tx/followable); set GANG_API to a gang.fun API that has it`)
  }
  if (r.status >= 500 || r.status === 429) throw statusError(`gang API ${r.status} on ${path}`, r.status)
  return { status: r.status, body }
}

/** Retry a not_found a few times: a note that just landed may not be indexed yet. */
async function untilFound(fn) {
  for (let i = 0; ; i++) {
    const r = await fn()
    if (r.reason !== 'not_found' || i >= NOT_FOUND_RETRIES) return r
    await sleep(RETRY_MS)
  }
}

/** → { ok, reason, token, track, expiresAt, blind } from gang.fun; without `token` the note's own token is returned. */
export function checkFollow(noteTx, trader, token) {
  const q = new URLSearchParams({ trader: trader.toLowerCase(), ...(token && { token: token.toLowerCase() }) })
  return untilFound(async () => {
    const { status, body } = await getJson(`/notes/${noteTx}/followable?${q}`)
    if (typeof body?.ok !== 'boolean') {
      throw new Error(`gang API ${status} on /notes/${noteTx}/followable${body?.error ? `: ${body.error}` : ''}`)
    }
    return body
  })
}

// gang.fun's token page per track: Soft (BNB), the LaunchpadV2 family, GangLaunchpad V3
const TRACK_PATH = { soft: '/tokens', v2: '/stocks/tokens', v3: '/v3/tokens' }

/**
 * Rough USD value of paying `wei` of the token's quote (BNB on Soft; `decimals` of the quote), from gang.fun's prices;
 * null if unknown. Best effort with a short timeout: it only decides whether the preview warns, never whether it's made.
 */
export async function amountUsd(token, track, wei, decimals = 18) {
  try {
    const { status, body } = await getJson(`${TRACK_PATH[track]}/${token.toLowerCase()}`, 3_000)
    const unit = Number(track === 'soft' ? body?.bnbUsd : body?.quoteUsd)
    const usd = Number(formatUnits(wei, decimals)) * unit
    if (status !== 200 || !Number.isFinite(usd) || !(unit > 0)) return null
    // cents above $1; two significant digits below, so a tiny buy doesn't read as $0
    return usd >= 1 ? Math.round(usd * 100) / 100 : Number(usd.toPrecision(2))
  } catch { return null }
}

/** Unix seconds / ms / ISO → "2026-10-27 14:05 UTC+8" in the local time zone. */
export function localTime(v) {
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v)
  if (!Number.isFinite(n)) return null
  const ms = n < 1e12 ? n * 1000 : n
  const off = -new Date(ms).getTimezoneOffset()
  const a = Math.abs(off)
  const tz = `UTC${off < 0 ? '-' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`
  return `${new Date(ms + off * 60_000).toISOString().slice(0, 16).replace('T', ' ')} ${tz}`
}
