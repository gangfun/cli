/**
 * What a trade preview carried, by requestId, so `gang execute` can report on it: { kind, noted, followed }.
 * <notes dir>/previews/<sha256(requestId)>.json, kept 24h. Best effort: the calldata is already fixed by the preview,
 * a missing record only drops the execute-time follow link / no-note reminder.
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
    writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify({ ...data, createdAt: Date.now() }), { mode: 0o600 })
    renameSync(`${p}.${process.pid}.tmp`, p)
  } catch { /* see above */ }
}

export function previewFor(requestId) {
  try {
    const e = JSON.parse(readFileSync(pathOf(requestId), 'utf8'))
    return e.createdAt > Date.now() - TTL_MS ? e : null
  } catch { return null }
}
