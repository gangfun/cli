/**
 * Agent notes ("thoughts"): a short public reason attached to a buy / sell / create.
 * baw can't sign messages, so the commitment rides at the end of the calldata (Solidity ignores trailing bytes):
 *   v1 suffix = "gang" 0x01 keccak256(UTF-8("gang-note:v1\n" salt "\n" conf "\n" text))                     (37 bytes)
 *   v2 suffix = "gang" 0x02 uint32be(revealAfter) keccak256(UTF-8("gang-note:v2\n" salt "\n" conf "\n" revealAfter "\n" text))  (41 bytes)
 *   follow ref = "gang" 0x03 followed note tx hash (37 bytes), right before the note suffix (or last without one)
 * The text is sent after the tx lands (POST /api/notes), so anyone can check it was written before the trade.
 * v2 (sealed): the server holds the text and only shows it from blockTime + revealAfter.
 * Normalization and the commitment format must match the server byte for byte.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { keccak256, toHex } from 'viem'
import { API } from './discover.js'
import { UA } from './version.js'

export const MAGIC = '67616e6701' // "gang" + version 1
export const MAGIC_V2 = '67616e6702' // "gang" + version 2 (sealed)
export const FOLLOW_MAGIC = '67616e6703' // "gang" + 03: follow ref (01 / 02 / 03 are never reused)
const MAX_CP = 280
const REVEAL_MIN_H = 1, REVEAL_MAX_H = 72
const LINK = /https?:\/\/|www\.|t\.me\//i
// a copied command whose placeholder was never filled in (`--note "<your reason>"`): refused by the CLI only, so the
// server's normalization stays the same
const PLACEHOLDER = /^<[^<>]{1,40}>$/
// zero-width + bidi controls, and every C0/C1 control except the whitespace ones (\t \n \v \f \r become a space below)
const STRIP = /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]|(?![\t\n\v\f\r])\p{Cc}/gu
const TTL_MS = 24 * 3600_000 // the server takes a note (v1 or v2) for 24h after the trade
export const DIR = process.env.GANG_NOTES_DIR || join(homedir(), '.gang', 'notes')
const ENTRY = /^0x[0-9a-f]{64}\.json$/
const TMP = /^0x[0-9a-f]{64}\.json\.\d+\.tmp$/ // left behind only if a process died between write and rename

/** NFC → strip invisibles/controls → collapse whitespace → trim. Throws with the server's error code in the message. */
export function normalizeNote(raw) {
  const text = String(raw ?? '').normalize('NFC').replace(STRIP, '').replace(/\s+/gu, ' ').trim()
  const n = [...text].length
  if (n < 1 || n > MAX_CP) throw new Error(`bad_text: note must be 1–${MAX_CP} characters after normalization (got ${n})`)
  if (LINK.test(text)) throw new Error('link_not_allowed: note must not contain links (http://, www., t.me/)')
  return text
}

/** conf is optional; null serializes as '' in the preimage. */
export function parseConf(raw) {
  if (raw == null) return null
  if (!/^\d{1,3}$/.test(String(raw)) || Number(raw) > 100) throw new Error(`bad_conf: --conf must be an integer 0–100 (got ${raw})`)
  return Number(raw)
}

/** --reveal-after: whole hours 1–72, as `6h` or `6`; returns seconds. null when not sealed. */
export function parseRevealAfter(raw) {
  if (raw == null) return null
  const m = /^(\d{1,2})h?$/i.exec(String(raw).trim())
  const h = m ? Number(m[1]) : NaN
  if (!(h >= REVEAL_MIN_H && h <= REVEAL_MAX_H)) {
    throw new Error(`bad_reveal_after: --reveal-after must be whole hours ${REVEAL_MIN_H}–${REVEAL_MAX_H}, e.g. 6h (got ${raw})`)
  }
  return h * 3600
}

export const noteHash = ({ salt, conf, text, revealAfter }) =>
  keccak256(toHex(revealAfter
    ? `gang-note:v2\n${salt}\n${conf ?? ''}\n${revealAfter}\n${text}`
    : `gang-note:v1\n${salt}\n${conf ?? ''}\n${text}`))

export function makeNote(rawText, rawConf, rawRevealAfter) {
  const text = normalizeNote(rawText)
  if (PLACEHOLDER.test(text)) throw new Error(`placeholder_note: --note is still the placeholder ${text}; write the actual reason, or drop --note`)
  const conf = parseConf(rawConf)
  const revealAfter = parseRevealAfter(rawRevealAfter)
  const salt = randomBytes(16).toString('hex')
  const hash = noteHash({ salt, conf, text, revealAfter })
  const suffix = revealAfter
    ? MAGIC_V2 + revealAfter.toString(16).padStart(8, '0') + hash.slice(2)
    : MAGIC + hash.slice(2)
  return { text, conf, revealAfter, salt, hash, suffix }
}

export const withNote = (data, note) => (note ? data + note.suffix : data)

const TX_RE = /^0x[0-9a-f]{64}$/

/** The note suffix at the very end of a tx input ({ version, hash }), or null. Same as the server's readNoteCommit. */
function readNoteCommit(s) {
  const v2 = s.slice(-82)
  if (v2.length === 82 && v2.startsWith(MAGIC_V2)) {
    const revealAfter = parseInt(v2.slice(10, 18), 16)
    if (revealAfter >= REVEAL_MIN_H * 3600 && revealAfter <= REVEAL_MAX_H * 3600) return { version: 2, hash: `0x${v2.slice(18)}` }
  }
  const v1 = s.slice(-74)
  if (v1.length === 74 && v1.startsWith(MAGIC)) return { version: 1, hash: `0x${v1.slice(10)}` }
  return null
}

/**
 * Follow reference (same code as the server's indexer/src/noteCommit.js): this buy follows the note of trade tx noteTx.
 * "gang" 03 noteTx (37 bytes), lower-case hex without 0x, appended after the calldata and before the trade's own note
 * suffix, if any: [calldata][follow][note].
 */
export function followSuffix(noteTx) {
  const tx = String(noteTx || '').toLowerCase()
  if (!TX_RE.test(tx)) throw new Error('bad note tx')
  return `${FOLLOW_MAGIC}${tx.slice(2)}`
}

/**
 * The note tx a tx input follows, or null. Only one place counts: the 37 bytes right before the input's note suffix,
 * or its last 37 bytes when it has none, so one input follows at most one note.
 */
export function readFollowRef(input) {
  const s = String(input || '').toLowerCase()
  const c = readNoteCommit(s)
  const end = s.length - (c ? (c.version === 2 ? 82 : 74) : 0)
  const f = s.slice(Math.max(0, end - 74), end)
  const tx = `0x${f.slice(10)}`
  return f.length === 74 && f.startsWith(FOLLOW_MAGIC) && TX_RE.test(tx) ? tx : null
}

/** Commitment hashes (v1 and v2) found in a tx input (contains-match, same as the server: the call may be wrapped). */
export function hashesIn(input) {
  const s = String(input || '').toLowerCase()
  return [...s.matchAll(/67616e67(?:01|02[0-9a-f]{8})([0-9a-f]{64})/g)].map((m) => `0x${m[1]}`)
}

// ---- local queue: one file per note, <dir>/<hash>.json → { salt, conf, text, revealAfter, kind, token, requestId,
// createdAt, publishedTx, publishedStatus, revealAt }. Kept 24h (the server's submit window), so a failed send
// can still be retried (`gang tx --hash`). Each process only ever writes its own note's file (atomic rename), so concurrent
// `gang` commands need no lock and a damaged file can't take the other notes' salts down with it.

const pathOf = (hash) => join(DIR, `${hash}.json`)

function read(hash) {
  try { return JSON.parse(readFileSync(pathOf(hash), 'utf8')) } catch { return null }
}

function write(hash, entry) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const tmp = `${pathOf(hash)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 })
  renameSync(tmp, pathOf(hash))
}

const fresh = (e) => e?.createdAt > Date.now() - TTL_MS

const old = (path) => Date.now() - statSync(path).mtimeMs > TTL_MS

/** Live entries; entries, unreadable files and stray temp files past the 24h reveal window are deleted. */
function entries() {
  let names
  try { names = readdirSync(DIR) } catch { return [] }
  const live = []
  for (const name of names) {
    const path = join(DIR, name)
    if (TMP.test(name)) {
      try { if (old(path)) unlinkSync(path) } catch { /* already gone */ }
      continue
    }
    if (!ENTRY.test(name)) continue
    const hash = name.slice(0, -5)
    const e = read(hash)
    if (fresh(e)) { live.push({ hash, ...e }); continue }
    try {
      // an unreadable file (e.g. damaged by hand) is kept for 24h so its salt can still be recovered manually
      if (e || old(path)) unlinkSync(path)
    } catch { /* already gone */ }
  }
  return live
}

export function queueNote(note, meta) {
  write(note.hash, {
    salt: note.salt, conf: note.conf, text: note.text, revealAfter: note.revealAfter, ...meta, createdAt: Date.now(), publishedTx: null,
  })
}

/** Any live entry, sent or not: `gang tx` also refreshes a 'pending' one and reports a sealed one's revealAt. */
export const hasQueued = () => entries().length > 0

export const findByRequestId = (requestId) => entries().find((e) => e.requestId === requestId) ?? null

export function findByHashes(hashes) {
  for (const hash of hashes) {
    const e = read(hash)
    if (fresh(e)) return { hash, ...e }
  }
  return null
}

function markPublished(hash, tx, status, revealAt) {
  const e = read(hash)
  if (e) write(hash, { ...e, publishedTx: tx, publishedStatus: status, revealAt })
}

/** revealAt as epoch ms, whatever the server sends (unix seconds, ms or an ISO string); null if unknown. */
function revealMs(v) {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v)
  if (!Number.isFinite(n)) return null
  return n < 1e12 ? n * 1000 : n
}

/**
 * Shape of a successful send: a v2 note not yet public says when it will be (revealAt can be null while 'pending').
 * A stored 'sealed' whose revealAt has passed is reported as 'ok': the server shows it by itself from then on.
 */
function sent(entry, status, revealAt, extra = {}) {
  const ms = revealMs(revealAt)
  if (status === 'sealed' && ms != null && ms <= Date.now()) status = 'ok'
  if (status === 'sealed' || (entry.revealAfter && status === 'pending')) {
    return { published: true, status, sealed: true, revealAt, revealAtIso: ms == null ? null : new Date(ms).toISOString(), ...extra }
  }
  return { published: true, status, ...extra }
}

/**
 * Send a queued note for a landed tx. Never throws: the trade already happened, so a failed send is
 * reported (and stays queued for `gang tx --hash` to retry) instead of failing the command.
 * Sealed (v2) notes are sent right away too: the server keeps the text hidden until revealAt.
 */
export async function publishNote(entry, tx) {
  if (entry.publishedTx !== tx) return post(entry, tx)
  const stored = sent(entry, entry.publishedStatus || 'ok', entry.revealAt ?? null, { already: true })
  if (entry.publishedStatus !== 'pending') return stored
  // sent while the indexer hadn't caught up: re-send (same content → idempotent 200) to refresh the status and a
  // sealed note's revealAt; if that fails the note is still sent, so report the stored state rather than a failure
  const r = await post(entry, tx)
  return r.published ? { ...r, already: true } : stored
}

async function post(entry, tx) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10_000)
  try {
    const r = await fetch(`${API}/notes`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
      body: JSON.stringify({
        tx, salt: entry.salt, conf: entry.conf, text: entry.text, ...(entry.revealAfter && { revealAfter: entry.revealAfter }),
      }),
    })
    if (r.status === 200 || r.status === 202) {
      let body
      try { body = await r.json() } catch { /* status code is enough */ }
      // ok | hidden (matched the blocklist, not shown) | pending (server waits for the indexer) | sealed (v2, shown from revealAt)
      const status = body?.status || (r.status === 202 ? 'pending' : 'ok')
      const revealAt = body?.revealAt ?? null
      try { markPublished(entry.hash, tx, status, revealAt) } catch { /* sent anyway; a later `gang tx` just gets 200 again */ }
      return sent(entry, status, revealAt)
    }
    let code
    try { code = (await r.json())?.error } catch { /* non-JSON error body */ }
    return { published: false, error: code || `http_${r.status}`, httpStatus: r.status }
  } catch (e) {
    return { published: false, error: `unreachable: ${ctl.signal.aborted ? 'timed out after 10s' : e.message}` }
  } finally {
    clearTimeout(timer)
  }
}
