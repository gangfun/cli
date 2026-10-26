/**
 * The CLI's own version, sent as User-Agent, and a once-a-day check whether npm has a newer one.
 * Installed agents keep their local copy of the skill, so the CLI output is the only place an old setup learns it's old.
 * The check never delays a command: results come from a cache that a detached child process refreshes.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const UA = `gang-cli/${VERSION}`

// GANG_UPDATE_URL: an npm mirror's …/@gangfun/cli/latest where registry.npmjs.org is slow or blocked
const LATEST_URL = process.env.GANG_UPDATE_URL || 'https://registry.npmjs.org/@gangfun/cli/latest'
const CACHE = join(homedir(), '.gang', 'update.json')
const DAY_MS = 24 * 3600_000
const RETRY_MS = 3600_000 // after a failed (or unfinished) refresh, try again in an hour, not on every command
const FETCH_TIMEOUT_MS = 30_000 // the refresh runs in the background, so a slow registry or proxy is fine
const SELF = fileURLToPath(import.meta.url)

/** a > b for plain x.y.z versions (pre-release tags are ignored). */
export function newer(a, b) {
  const pa = String(a).split(/[.-]/).map(Number), pb = String(b).split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

function readCache() {
  try { return JSON.parse(readFileSync(CACHE, 'utf8')) } catch { return null }
}

function writeCache(c) {
  try {
    mkdirSync(dirname(CACHE), { recursive: true, mode: 0o700 })
    writeFileSync(`${CACHE}.${process.pid}.tmp`, JSON.stringify(c))
    renameSync(`${CACHE}.${process.pid}.tmp`, CACHE)
    return true
  } catch { return false }
}

/** Runs in the detached child: ask npm for the latest version and store it. */
async function refresh() {
  const prev = readCache()
  try {
    const r = await fetch(LATEST_URL, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const v = (await r.json())?.version
    if (!/^\d+\.\d+\.\d+/.test(v ?? '')) throw new Error('no version')
    writeCache({ checkedAt: Date.now(), latest: v })
  } catch {
    writeCache({ checkedAt: Date.now(), latest: prev?.latest ?? null, failed: true })
  }
}

/**
 * { current, latest, cmd, skill } when the cached npm version is newer, else null (`skill` refreshes the agent's skill,
 * which is likely as old as the CLI). Synchronous and never throws.
 * A stale cache (a day old, or an hour after a failed refresh) starts a background refresh for the next command.
 * GANG_UPDATE_CHECK=0 turns it off.
 */
export function checkUpdate() {
  if (process.env.GANG_UPDATE_CHECK === '0') return null
  const c = readCache()
  const age = Date.now() - (c?.checkedAt || 0)
  if (!(age >= 0 && age < (c?.latest && !c.failed ? DAY_MS : RETRY_MS))) {
    // mark it as being checked first, so commands run meanwhile don't each start a refresh
    if (writeCache({ checkedAt: Date.now(), latest: c?.latest ?? null, failed: true })) {
      try {
        spawn(process.execPath, [SELF, 'refresh'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } catch { /* next hour */ }
    }
  }
  if (!c?.latest || !newer(c.latest, VERSION)) return null
  return {
    current: VERSION, latest: c.latest,
    cmd: 'npm i -g @gangfun/cli@latest',
    skill: 'npx skills add gangfun/gang-launchpad/skill',
  }
}

if (process.argv[1] === SELF && process.argv[2] === 'refresh') refresh()
