/**
 * Anonymous usage counts, on by default; GANG_TELEMETRY=0 (or DO_NOT_TRACK=1) turns them off.
 * One event per command: its name, the flag names (never their values), whether it succeeded and, when not, a short
 * error code, and the host's name when known (`gang mcp`: the MCP client's own name; else GANG_CLIENT). `gang preflight`
 * adds which checks passed. The only id is a random one (~/.gang/install-id); no wallet, address, amount, token, note text
 * or flag value goes out. gang.fun uses it to see where agents get stuck before a first trade and which hosts they use.
 * Events queue in ~/.gang/events.ndjson and a detached child posts them to POST /api/t at most once a minute, so a
 * command never waits on the network; a failed post is dropped.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API } from './discover.js'
import { UA, VERSION } from './version.js'

const DIR = process.env.GANG_TELEMETRY_DIR || join(homedir(), '.gang')
const ID_FILE = join(DIR, 'install-id')
const QUEUE = join(DIR, 'events.ndjson')
const STAMP = join(DIR, 'events.flush') // mtime = last flush start
const FLUSH_MS = 60_000
const QUEUE_MAX_BYTES = 64 * 1024 // offline for long: stop queueing rather than grow the file
const BATCH = 50 // the server takes 1–50 events per post
const POST_TIMEOUT_MS = 10_000
const SELF = fileURLToPath(import.meta.url)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NAME = /^[a-z0-9-]{1,24}$/
const CODE = /^[A-Za-z0-9_.:-]{1,48}$/
const MAX_FLAGS = 16
// commands whose second word is a subcommand (gang fly mint, gang bond create, …)
const WITH_SUB = new Set(['fair', 'v3', 'fly', 'bond', 'buyback', 'split', 'lp', 'combo', 'capped', 'creator-fee'])

export const enabled = () => process.env.GANG_TELEMETRY !== '0' && process.env.DO_NOT_TRACK !== '1'

/** The random install id, created on first use; null when it can't be read or written. */
export function installId() {
  try {
    const id = readFileSync(ID_FILE, 'utf8').trim()
    if (UUID.test(id)) return id
  } catch { /* first run */ }
  try {
    const id = randomUUID()
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    writeFileSync(ID_FILE, `${id}\n`, { mode: 0o600 })
    return id
  } catch { return null }
}

/**
 * A short code for a failed command: the result's own code (preflight issue, baw code, follow reason) when it has one,
 * else a coarse class read from the message. The message itself never leaves the machine.
 */
export function codeOf(o = {}) {
  for (const v of [o.code, o.errorName, o.issues?.[0]?.code]) {
    if (v != null && CODE.test(String(v)) && !/^0x/i.test(String(v))) return String(v)
  }
  const msg = String(o.error ?? '')
  if (/^[A-Z][A-Za-z0-9]{2,47}$/.test(msg)) return msg // a custom error name (NotAgent, PaceExceeded, …)
  // only a word-like reason (follow's not_found, fly's pace): a revert's `reason` is its first argument, maybe an address or amount
  if (/^[a-z][a-z_]{1,31}$/.test(String(o.reason ?? ''))) return o.reason
  const baw = msg.match(/\(code (\d{1,10})\)/)
  if (baw) return baw[1]
  if (/^this wallet holds no Agent ID/i.test(msg)) return 'NO_AGENT_ID' // this wallet's: an inviter's is a usage matter
  if (/baw auth signin|not signed in/i.test(msg)) return 'NOT_SIGNED_IN'
  if (/unreachable|timed out|fetch failed|ECONN|ENOTFOUND|API 5\d\d|RPC error|data unavailable/i.test(msg)) return 'NETWORK'
  if (/revert/i.test(msg)) return 'REVERT'
  // the command itself is wrong: a flag named, or a form the CLI asks for. State errors ("needs at least 3000 shares") are not
  if (/^--|^usage|^pass |^give |^use either |^unknown |^gang .*\b(needs|takes)\b|--[a-z][a-z-]+ must|must be (a|an|one|between) /i.test(msg)) return 'USAGE'
  return 'ERROR'
}

/**
 * A host's name as the events carry it: a slug of a-z 0-9 -, at most 24 characters. Only what looks like a product's name
 * goes out: anything else (a full address, an email, a path, a dotted hostname, a long key: other characters, too long, a
 * long hex run) is 'other', never a shortened copy. '' when there is no name. These rules can't tell a person's name from
 * a product's: a host that sends one as its own name sends it here too.
 */
export function clientOf(raw = process.env.GANG_CLIENT) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const s = raw.trim()
  if (!/^[A-Za-z][A-Za-z0-9 _-]{0,23}$/.test(s) || /[0-9a-f]{12}/i.test(s)) return 'other'
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
}

/** The event for one command (argv after `gang`) and its JSON result. */
export function eventOf(argv, o = {}) {
  const c = NAME.test(argv[0] ?? '') ? argv[0] : 'other'
  const s = WITH_SUB.has(c) && NAME.test(argv[1] ?? '') ? argv[1] : ''
  const f = [...new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2)))].filter((n) => NAME.test(n)).slice(0, MAX_FLAGS)
  const ok = o.success !== false
  const pf = c === 'preflight'
    ? { signedIn: o.status === 'CONNECTED', agent: o.isAgent ?? null, dev: o.devMode ?? null, all: o.tradeAllTokens ?? null }
    : null
  const cl = clientOf()
  return { t: Math.floor(Date.now() / 1000), c, s, f, ok, code: ok ? '' : codeOf(o), pf, ...(cl && { cl }) }
}

let recorded = false

/** Queue this process's event (only its first result counts) and start a flush if the last one was a minute ago. Never throws. */
export function record(argv, o) {
  if (recorded || !enabled()) return
  recorded = true
  try {
    let size = 0
    try { size = statSync(QUEUE).size } catch { /* empty */ }
    if (size > QUEUE_MAX_BYTES) return
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    appendFileSync(QUEUE, `${JSON.stringify(eventOf(argv, o))}\n`, { mode: 0o600 })
    let last = 0
    try { last = statSync(STAMP).mtimeMs } catch { /* never flushed */ }
    if (Date.now() - last < FLUSH_MS) return
    // stamp first, so commands run meanwhile don't each start a flush
    try { utimesSync(STAMP, new Date(), new Date()) } catch { writeFileSync(STAMP, '') }
    spawn(process.execPath, [SELF, 'flush'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch { /* telemetry never breaks a command */ }
}

/** Runs in the detached child: take the queue, post it in batches, drop it either way. */
export async function flush() {
  const id = installId()
  const taken = `${QUEUE}.${process.pid}.sending`
  try { renameSync(QUEUE, taken) } catch { return }
  try {
    if (!id) return
    const events = readFileSync(taken, 'utf8').split('\n').flatMap((l) => {
      try { return l ? [JSON.parse(l)] : [] } catch { return [] }
    })
    for (let i = 0; i < events.length; i += BATCH) {
      const r = await fetch(`${API}/t`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ i: id, v: VERSION, e: events.slice(i, i + BATCH) }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      })
      if (!r.ok) break
    }
  } catch { /* offline, or an older server without /t */ } finally {
    try { unlinkSync(taken) } catch { /* gone */ }
  }
}

if (process.argv[1] === SELF && process.argv[2] === 'flush') flush()
