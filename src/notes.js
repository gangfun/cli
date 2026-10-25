/**
 * Agent notes ("thoughts"): a short public reason attached to a buy / sell / create.
 * baw can't sign messages, so the commitment rides at the end of the calldata (Solidity ignores trailing bytes):
 *   suffix = "gang" 0x01 keccak256(UTF-8("gang-note:v1\n" salt "\n" conf "\n" text))   (37 bytes)
 * The text is revealed after the tx lands (POST /api/notes), so anyone can check it was written before the trade.
 * Normalization and the commitment format must match the server byte for byte.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { keccak256, toHex } from 'viem'
import { API } from './discover.js'

export const MAGIC = '67616e6701' // "gang" + version 1
const MAX_CP = 280
const LINK = /https?:\/\/|www\.|t\.me\//i
// zero-width + bidi controls, and every C0/C1 control except the whitespace ones (\t \n \v \f \r become a space below)
const STRIP = /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]|(?![\t\n\v\f\r])\p{Cc}/gu
const TTL_MS = 24 * 3600_000
const DIR = process.env.GANG_NOTES_DIR || join(homedir(), '.gang', 'notes')
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

export const noteHash = ({ salt, conf, text }) =>
  keccak256(toHex(`gang-note:v1\n${salt}\n${conf ?? ''}\n${text}`))

export function makeNote(rawText, rawConf) {
  const text = normalizeNote(rawText)
  const conf = parseConf(rawConf)
  const salt = randomBytes(16).toString('hex')
  const hash = noteHash({ salt, conf, text })
  return { text, conf, salt, hash, suffix: MAGIC + hash.slice(2) }
}

export const withNote = (data, note) => (note ? data + note.suffix : data)

/** Commitment hashes found in a tx input (contains-match, same as the server: the call may be wrapped). */
export function hashesIn(input) {
  const s = String(input || '').toLowerCase()
  return [...s.matchAll(/67616e6701([0-9a-f]{64})/g)].map((m) => `0x${m[1]}`)
}

// ---- local queue: one file per note, <dir>/<hash>.json → { salt, conf, text, kind, token, requestId, createdAt,
// publishedTx, publishedStatus }. Each process only ever writes its own note's file (atomic rename), so concurrent
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
  write(note.hash, { salt: note.salt, conf: note.conf, text: note.text, ...meta, createdAt: Date.now(), publishedTx: null })
}

export const hasUnpublished = () => entries().some((e) => !e.publishedTx)

export const findByRequestId = (requestId) => entries().find((e) => e.requestId === requestId) ?? null

export function findByHashes(hashes) {
  for (const hash of hashes) {
    const e = read(hash)
    if (fresh(e)) return { hash, ...e }
  }
  return null
}

function markPublished(hash, tx, status) {
  const e = read(hash)
  if (e) write(hash, { ...e, publishedTx: tx, publishedStatus: status })
}

/**
 * Reveal a queued note for a landed tx. Never throws: the trade already happened, so a failed reveal is
 * reported (and stays queued for `gang tx --hash` to retry within 24h) instead of failing the command.
 */
export async function publishNote(entry, tx) {
  if (entry.publishedTx === tx) return { published: true, status: entry.publishedStatus || 'ok', already: true }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10_000)
  try {
    const r = await fetch(`${API}/notes`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ tx, salt: entry.salt, conf: entry.conf, text: entry.text }),
    })
    if (r.status === 200 || r.status === 202) {
      let body
      try { body = await r.json() } catch { /* status code is enough */ }
      // ok | hidden (matched the blocklist, not shown) | pending (server waits for the indexer)
      const status = body?.status || (r.status === 202 ? 'pending' : 'ok')
      try { markPublished(entry.hash, tx, status) } catch { /* published anyway; a later `gang tx` just gets 200 again */ }
      return { published: true, status }
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
