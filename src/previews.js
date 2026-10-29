/**
 * What a preview carried, by requestId: { kind, noted, followed } for `gang execute`'s report, the call's fingerprint
 * (print, chainId: baw.js bawPreview) and, once an execute waits for Binance App approval, { pendingAt, orderId } and
 * later the txHash `gang tx --pending` found (pending.js). <notes dir>/previews/<sha256(requestId)>.json, kept 24h; each
 * write merges into the record. Best effort: the calldata is already fixed by the preview, a missing record only drops
 * the execute-time follow link / no-note reminder, or leaves a pending trade to `gang tx --hash`.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIR } from './notes.js'

const PDIR = join(DIR, 'previews')
const TTL_MS = 24 * 3600_000
const pathOf = (requestId) => join(PDIR, `${createHash('sha256').update(String(requestId)).digest('hex').slice(0, 32)}.json`)

export function rememberPreview(requestId, data) {
  try {
    // first use of previews/: drop the follows/ dir 0.6.0 kept follow links in
    if (mkdirSync(PDIR, { recursive: true, mode: 0o700 })) rmSync(join(DIR, 'follows'), { recursive: true, force: true })
    for (const name of readdirSync(PDIR)) {
      const p = join(PDIR, name)
      try { if (Date.now() - statSync(p).mtimeMs > TTL_MS) unlinkSync(p) } catch { /* already gone */ }
    }
    const p = pathOf(requestId)
    let prev = {}
    try { prev = JSON.parse(readFileSync(p, 'utf8')) } catch { /* new record */ }
    const rec = { ...prev, ...data, requestId: String(requestId), createdAt: prev.createdAt ?? Date.now() }
    writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify(rec), { mode: 0o600 })
    renameSync(`${p}.${process.pid}.tmp`, p)
  } catch { /* see above */ }
}

/** Every record from the last 24h. */
function records() {
  let names = []
  try { names = readdirSync(PDIR) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const e = JSON.parse(readFileSync(join(PDIR, name), 'utf8'))
      if (e.createdAt > Date.now() - TTL_MS) out.push(e)
    } catch { /* unreadable: skip */ }
  }
  return out
}

/** Executes still waiting for Binance App approval (no txHash found yet), oldest first. */
export const pendingPreviews = () => records().filter((e) => e.pendingAt && !e.txHash).sort((a, b) => a.pendingAt - b.pendingAt)

/** The tx hashes already given to a pending record: never handed to another one. */
export const claimedTxHashes = () => records().filter((e) => e.txHash).map((e) => e.txHash)

export function previewFor(requestId) {
  try {
    const e = JSON.parse(readFileSync(pathOf(requestId), 'utf8'))
    return e.createdAt > Date.now() - TTL_MS ? e : null
  } catch { return null }
}
