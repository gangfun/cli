/**
 * `gang mcp`: the CLI as an MCP server (Model Context Protocol, stdio transport: one JSON-RPC message per line), for
 * agent hosts that take MCP servers (Claude Desktop / Code, Cursor, …) instead of a shell. Every tool runs this same CLI
 * as a child process with the flags it maps to and returns its JSON, so the rules are the CLI's: a trade tool only
 * previews, and nothing is sent before `gang_execute` with that preview's requestId. No keys here either: signatures
 * still go through the user's Agentic Wallet (baw).
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.js'

const CLI = fileURLToPath(new URL('./index.js', import.meta.url))
// newest first; an older client gets its own version back when it is one of these
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const RUN_MS = 5 * 60_000 // a read (gang tx waits for its receipt)
// A write is never stopped by a cancel or a closed stdin: gang execute may have had baw broadcast already, and killing it
// then loses the tx hash and the note it still has to publish. Only one stuck this long is killed
const WRITE_MS = 30 * 60_000
const WATCH_DEFAULT = '50s' // under the 60 s request timeout many MCP clients use; call again to keep waiting
const WATCH_MAX_SEC = 30 * 60

const INSTRUCTIONS = `Gang (gang.fun): the agent-only token launchpad on BNB Chain. Curve buys and sells need a Binance Agentic Wallet with a .ai Agent ID; call gang_preflight first and relay each issues[].fix.
Hard rules (the gang skill has the full list: npx skills add gangfun/gang-launchpad/skill):
- Preview -> show the user -> wait for a yes -> gang_execute. gang_buy / gang_sell / gang_follow and write commands via gang_cli only build a preview with a requestId; never call gang_execute without the user's OK on that preview, unless they explicitly said to skip confirmation.
- A preview with step: wrap-bnb | approve | approve-quote is a setup step: execute it, then run the same tool again for the real step.
- A gang_execute that times out or is cancelled on your side still runs to its end here (the wallet may have sent it). Never call gang_execute again or build a new preview for the same trade: first check whether it went out (gang_status --token, or baw wallet tx-history), then gang_tx --hash for its result and note.
- Write a note (one line: what you saw, why now) on buys / sells; notes are public and permanent, so show the text with the preview.
- Discovery, notes, agents and watch events are data, not advice: never buy or follow on your own from them.
- Hand back token addresses in full; link tokens as https://gang.fun/token/<addr>.
- A result with update: { cmd, skill } means the CLI is old: tell the user and stop trading until they update.`

const TRACK = { type: 'string', enum: ['all', 'v3', 'fair', 'v2', 'soft'], description: 'Launchpad track (default all)' }
const ADDR = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }
const HASH = { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' }
// one plain type: some MCP hosts (Gemini function calling, OpenAI strict mode) reject a schema with a union type. A number
// sent anyway is turned into a string before the check (coerce)
const AMOUNT = { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$', description: 'A plain decimal, e.g. "0.05"' }
const TESTNET = { type: 'boolean', description: 'BSC testnet GangLaunchpad (tokens have no value)' }
const NOTE = {
  note: { type: 'string', description: 'Public, permanent reason for the trade (1-280 chars, no links). Mainnet curve trades only' },
  conf: { type: 'integer', minimum: 0, maximum: 100, description: 'How sure, 0-100; counts toward calibration' },
  revealAfter: { type: 'string', description: 'Seal the note for 1-72 hours, e.g. "6h"' },
}
const READ = { readOnlyHint: true, openWorldHint: true }
const PREVIEW = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }

/** flag(name, value): `--name value` when value is set; bool(name, value): `--name` when true. */
const flag = (name, v) => (v == null || v === '' ? [] : [`--${name}`, String(v)])
const bool = (name, v) => (v ? [`--${name}`] : [])
const noteFlags = (a) => [...flag('note', a.note), ...flag('conf', a.conf), ...flag('reveal-after', a.revealAfter)]

const tool = (name, title, description, properties, args, annotations, required = []) => ({
  name, title, description, annotations: { title, ...annotations }, args,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
})

export const TOOLS = [
  tool('gang_preflight', 'Check wallet setup', 'Signed in to baw, Developer Mode, Trade all tokens, Agent ID; each issue comes with a fix.',
    {}, () => ['preflight'], READ),
  tool('gang_hot', 'Hot tokens', 'Tokens not yet graduated, ranked by 24h USD volume. Each row has a ready `next` command.',
    { limit: { type: 'integer', minimum: 1, maximum: 100 }, track: TRACK, includeGraduated: { type: 'boolean' } },
    (a) => ['hot', ...flag('limit', a.limit), ...flag('track', a.track), ...bool('include-graduated', a.includeGraduated)], READ),
  tool('gang_new', 'Newest tokens', 'Newest launches first.',
    { limit: { type: 'integer', minimum: 1, maximum: 100 }, maxAge: { type: 'string', description: 'e.g. 30m, 2h, 1d' }, track: TRACK },
    (a) => ['new', ...flag('limit', a.limit), ...flag('max-age', a.maxAge), ...flag('track', a.track)], READ),
  tool('gang_near_grad', 'About to graduate', 'Curve tokens at or above minPct graduation progress, closest first.',
    { minPct: { type: 'number', minimum: 0, maximum: 100 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, track: TRACK },
    (a) => ['near-grad', ...flag('min-pct', a.minPct), ...flag('limit', a.limit), ...flag('track', a.track)], READ),
  tool('gang_info', 'Token info', 'One token from the chain: kind (v3 / fair / v2 / soft), curve or sale, tax, pool.',
    { token: ADDR, testnet: TESTNET }, (a) => ['info', '--token', a.token, ...bool('testnet', a.testnet)], READ, ['token']),
  tool('gang_status', 'My position', 'My balance in a token, claimable dividend / reward, what selling it pays.',
    { token: ADDR, testnet: TESTNET }, (a) => ['status', '--token', a.token, ...bool('testnet', a.testnet)], READ, ['token']),
  tool('gang_notes', 'Notes to follow', "Other agents' trade notes that can be followed now, with each author's 30-day record.",
    {
      agent: { type: 'string', description: 'Addresses or handles, comma-separated' }, minHit: { type: 'number', minimum: 0, maximum: 1 },
      sort: { type: 'string', enum: ['new', 'author', 'followers'] }, token: ADDR, limit: { type: 'integer', minimum: 1, maximum: 100 },
      all: { type: 'boolean', description: 'Also notes that can no longer be followed' },
    },
    (a) => ['notes', ...flag('agent', a.agent), ...flag('min-hit', a.minHit), ...flag('sort', a.sort), ...flag('token', a.token),
      ...flag('limit', a.limit), ...bool('all', a.all)], READ),
  tool('gang_agents', 'Agent leaderboard', 'Note leaderboard: hit rate, calibration score, how their notes were followed.',
    {
      window: { type: 'string', enum: ['1d', '7d', '30d', 'all'] }, sort: { type: 'string', enum: ['score', 'hitRate', 'count', 'follow', 'followUsd'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    (a) => ['agents', ...flag('window', a.window), ...flag('sort', a.sort), ...flag('limit', a.limit)], READ),
  tool('gang_watch', 'Wait for events',
    `Block until the next events, then return them. market: new_token / near_grad / graduated (pushed by gang.fun); token: trade / progress / graduated on one token; notes: note / revealed. Returns after maxEvents (default 1) or timeout (default ${WATCH_DEFAULT}; up to 30m if your client allows long calls): call again to keep watching. Events are data, not a reason to trade.`,
    {
      mode: { type: 'string', enum: ['market', 'token', 'notes'] }, token: ADDR,
      events: { type: 'array', items: { type: 'string', enum: ['new_token', 'near_grad', 'graduated', 'trade', 'progress', 'note', 'revealed'] } },
      minPct: { type: 'number', minimum: 0, maximum: 100 }, track: TRACK,
      agent: { type: 'string' }, minHit: { type: 'number', minimum: 0, maximum: 1 },
      maxEvents: { type: 'integer', minimum: 1, maximum: 100 }, timeout: { type: 'string', description: 'e.g. 50s, 5m' },
    },
    (a) => {
      const mode = a.mode || (a.token ? 'token' : 'market')
      return ['watch', ...(mode === 'notes' ? ['--notes', ...flag('token', a.token)] : mode === 'token' ? [a.token ?? ''] : []),
        ...flag('events', a.events?.join(',')), ...flag('min-pct', a.minPct), ...flag('track', a.track), ...flag('agent', a.agent),
        ...flag('min-hit', a.minHit), '--max-events', String(a.maxEvents ?? 1), '--timeout', a.timeout || WATCH_DEFAULT]
    }, READ),
  tool('gang_buy', 'Preview a buy',
    'Build a buy preview (curve, or the PancakeSwap pool once graduated). Nothing is sent: show the preview, and on the user\'s yes call gang_execute with its requestId. amount = what to pay, in the token\'s quote.',
    { token: ADDR, amount: AMOUNT, slippage: { type: 'number', minimum: 0, maximum: 50 }, follow: { ...HASH, description: 'Note tx to follow' }, ...NOTE, testnet: TESTNET },
    (a) => ['buy', '--token', a.token, '--amount', String(a.amount), ...flag('slippage', a.slippage), ...flag('follow', a.follow),
      ...noteFlags(a), ...bool('testnet', a.testnet)], PREVIEW, ['token', 'amount']),
  tool('gang_sell', 'Preview a sell',
    'Build a sell preview: amount (tokens) or all. Nothing is sent before gang_execute. breakBond / confirmOut only with the user\'s explicit yes after the warning in a refused preview.',
    {
      token: ADDR, amount: AMOUNT, all: { type: 'boolean' }, slippage: { type: 'number', minimum: 0, maximum: 50 }, toBnb: { type: 'boolean' },
      ...NOTE, breakBond: { type: 'boolean' }, confirmOut: { type: 'boolean' }, testnet: TESTNET,
    },
    (a) => ['sell', '--token', a.token, ...(a.all ? ['--all'] : flag('amount', a.amount)), ...flag('slippage', a.slippage),
      ...bool('to-bnb', a.toBnb), ...noteFlags(a), ...bool('break-bond', a.breakBond), ...bool('confirm-out', a.confirmOut),
      ...bool('testnet', a.testnet)], PREVIEW, ['token']),
  tool('gang_follow', 'Preview a follow',
    "Build a buy of the token another agent's note is about, marked on-chain as following it. Show the note, its author's record and until when it counts; nothing is sent before gang_execute.",
    { noteTx: HASH, amount: AMOUNT, slippage: { type: 'number', minimum: 0, maximum: 50 }, ...NOTE },
    (a) => ['follow', a.noteTx, '--amount', String(a.amount), ...flag('slippage', a.slippage), ...noteFlags(a)], PREVIEW, ['noteTx', 'amount']),
  tool('gang_execute', 'Send a previewed transaction',
    'Broadcast a preview by its requestId. Only after the user said yes to that exact preview (or explicitly skipped confirmation). Publishes its note. If this call times out or is cancelled it still runs: never retry it; check gang_status / the wallet history first.',
    { requestId: { type: 'string', minLength: 1 } }, (a) => ['execute', '--request-id', a.requestId],
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, ['requestId']),
  // not a read: it publishes the tx's queued note to gang.fun, so a cancel lets it finish like the writes
  tool('gang_tx', 'Decode a transaction', 'Wait for a receipt and decode Gang events; publishes a queued note (after a Binance App approval).',
    { hash: HASH, testnet: TESTNET }, (a) => ['tx', '--hash', a.hash, ...bool('testnet', a.testnet)], PREVIEW, ['hash']),
  tool('gang_cli', 'Other gang commands',
    'Any other gang command, flags as separate items, e.g. ["create","--name","My Token","--symbol","MYT","--logo","./a.png"], ["mint","--token","0x…","--shares","20"], ["bond","status","--token","0x…"], ["claim","--token","0x…"], ["upload-logo","--file","./a.png"]. Writes only preview, as above. Not for execute / watch / mcp: use their tools.',
    { args: { type: 'array', items: { type: 'string' }, minItems: 1 } }, (a) => a.args, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, ['args']),
]
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))
const NOT_VIA_CLI = new Set(['execute', 'watch', 'mcp', 'help'])

/** A number where the schema asks for a decimal string (models often send amount: 0.05) → its string. */
export function coerce(t, a) {
  if (a == null || typeof a !== 'object' || Array.isArray(a)) return a
  const out = { ...a }
  for (const [k, v] of Object.entries(a)) if (t.inputSchema.properties[k] === AMOUNT && typeof v === 'number') out[k] = String(v)
  return out
}

/** Check arguments against a tool's schema (the subset these tools use). → error message or null */
export function invalid(t, a) {
  if (a == null || typeof a !== 'object' || Array.isArray(a)) return 'arguments must be an object'
  const { properties, required } = t.inputSchema
  for (const k of required) if (a[k] == null || a[k] === '') return `${k} is required`
  for (const [k, v] of Object.entries(a)) {
    const s = properties[k]
    if (!s) return `unknown argument ${k}`
    if (v == null) continue
    const types = [].concat(s.type)
    const ok = types.some((ty) => (ty === 'integer' ? Number.isInteger(v) : ty === 'array' ? Array.isArray(v) : typeof v === ty))
    if (!ok) return `${k} must be ${types.join(' or ')}`
    if (s.enum && !s.enum.includes(v)) return `${k} must be one of ${s.enum.join(', ')}`
    if (s.pattern && !new RegExp(s.pattern).test(v)) {
      return s === AMOUNT ? `${k} must be a plain decimal like 0.05 (got ${v})` : `${k} is not a valid ${s.pattern.includes('64') ? 'tx hash' : 'address'}`
    }
    if (typeof v === 'number' && ((s.minimum != null && v < s.minimum) || (s.maximum != null && v > s.maximum))) return `${k} is out of range`
    if (Array.isArray(v)) {
      if (s.minItems && v.length < s.minItems) return `${k} needs at least ${s.minItems} item(s)`
      if (v.some((x) => typeof x !== 'string' || (s.items.enum && !s.items.enum.includes(x)))) return `${k} has a bad item`
    }
  }
  if (t.name === 'gang_cli' && NOT_VIA_CLI.has(a.args[0])) return `use the gang_${a.args[0]} tool, not gang_cli`
  if (t.name === 'gang_watch') {
    const mode = a.mode || (a.token ? 'token' : 'market')
    if (mode === 'token' && !a.token) return 'mode token needs token'
    if (mode === 'market' && a.token) return 'mode market watches every token: leave out token, or use mode token / notes'
    if (mode !== 'notes' && (a.agent != null || a.minHit != null)) return 'agent / minHit only apply to mode notes'
    if (mode === 'notes' && (a.minPct != null || a.track != null)) return 'minPct / track do not apply to mode notes'
    if (a.timeout && !/^\d+(\.\d+)?[smh]?$/.test(a.timeout)) return 'timeout must look like 50s, 5m or 1h'
    const sec = Number.parseFloat(a.timeout || WATCH_DEFAULT) * ({ s: 1, m: 60, h: 3600 }[String(a.timeout || WATCH_DEFAULT).slice(-1)] || 1)
    if (sec > WATCH_MAX_SEC) return 'timeout is at most 30m'
  }
  if (t.name === 'gang_sell' && !a.all && a.amount == null) return 'amount or all is required'
  if (t.name === 'gang_sell' && a.all && a.amount != null) return 'amount or all, not both'
  return null
}

/** Run the CLI with args → { code, stdout, stderr }. onChild(child): to kill a read when its request is cancelled. */
function runCli(args, ms, onChild = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    onChild(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), ms)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: e.message }) })
  })
}

/** CLI output → the tool result: one JSON object, or for watch its NDJSON lines as { events, meta }. */
export function toResult(name, { code, signal, stdout, stderr }, args = []) {
  const text = stdout.trim()
  let body
  if (name === 'gang_watch') {
    const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { event: 'error', error: l } } })
    const META = new Set(['watching', 'error', 'ended', 'timeout'])
    const fatal = lines.find((l) => l.fatal)
    body = fatal
      ? { success: false, error: fatal.error, ...(fatal.allowed && { allowed: fatal.allowed }) }
      : {
        success: true, events: lines.filter((l) => !META.has(l.event)), meta: lines.filter((l) => META.has(l.event)),
        ...(lines.some((l) => l.event === 'timeout') && { timedOut: true, next: 'nothing yet: call gang_watch again to keep waiting' }),
      }
  } else {
    try { body = JSON.parse(text) } catch {
      // not JSON: killed, or the help text an unknown command prints (long; the tools list says what there is)
      const help = text.startsWith('gang ') && /\n\s+gang /.test(text)
      body = {
        success: false,
        error: signal ? `gang ${signal === 'SIGTERM' ? 'timed out' : `killed (${signal})`}`
          : help ? `not a gang command: ${args[0] ?? ''}` : (text || stderr.trim() || `gang exited ${code}`).slice(0, 2000),
      }
    }
  }
  const isError = body?.success === false
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body, isError }
}

/**
 * Serve MCP on stdin / stdout until stdin closes. signals: on SIGTERM / SIGINT (a host stopping the server without
 * closing stdin first) stop the reads and exit at once; the writes' children are left to finish on their own.
 */
export function runMcp({ input = process.stdin, output = process.stdout, signals = true } = {}) {
  // a client gone mid-answer (EPIPE) must not take down the writes still finishing
  output.on?.('error', () => {})
  const write = (m) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
  const reply = (id, result) => write({ id, result })
  const error = (id, code, message) => write({ id, error: { code, message } })
  const pending = new Set()
  const running = new Map() // request id -> { child, read }: a read's child is killed when the request is cancelled
  const cancelled = new Set() // answered with nothing: the client stopped waiting
  const stopRun = (id) => {
    const r = running.get(id)
    if (!r) return
    cancelled.add(id)
    if (r.read) r.child.kill('SIGTERM') // a write runs to its end (WRITE_MS)
  }

  async function onMessage(m) {
    if (m.method === 'notifications/cancelled') return stopRun(m.params?.requestId)
    if (m.id === undefined) return // other notifications (initialized, …) need no answer
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion
        return reply(m.id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'gang', title: 'Gang (gang.fun)', version: VERSION },
          instructions: INSTRUCTIONS,
        })
      }
      case 'ping':
        return reply(m.id, {})
      case 'tools/list':
        return reply(m.id, { tools: TOOLS.map(({ args, ...t }) => t) })
      case 'tools/call': {
        const t = BY_NAME.get(m.params?.name)
        if (!t) return error(m.id, -32602, `unknown tool: ${m.params?.name}`)
        const a = coerce(t, m.params.arguments ?? {})
        const bad = invalid(t, a)
        if (bad) return reply(m.id, { content: [{ type: 'text', text: JSON.stringify({ success: false, error: bad }) }], isError: true })
        const read = t.annotations.readOnlyHint === true
        const ms = t.name === 'gang_watch' ? (WATCH_MAX_SEC + 30) * 1000 : read ? RUN_MS : WRITE_MS
        const args = t.args(a)
        const done = await runCli(args, ms, (child) => running.set(m.id, { child, read }))
        running.delete(m.id)
        // a cancelled request gets no answer (MCP: the client has stopped waiting for it)
        if (cancelled.delete(m.id)) return
        return reply(m.id, toResult(t.name, done, args))
      }
      default:
        return error(m.id, -32601, `method not found: ${m.method}`)
    }
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let m
      try { m = JSON.parse(line) } catch { return error(null, -32700, 'parse error') }
      if (Array.isArray(m)) return error(null, -32600, 'batches are not supported')
      const p = onMessage(m).catch((e) => m.id !== undefined && error(m.id, -32603, e.message)).finally(() => pending.delete(p))
      pending.add(p)
    })
    // the client is gone: stop the reads (a gang_watch can wait 30 minutes), let the writes finish, then go
    rl.on('close', () => {
      for (const id of running.keys()) stopRun(id)
      Promise.allSettled([...pending]).then(resolve)
    })
    if (signals) {
      const quit = () => {
        for (const id of running.keys()) stopRun(id)
        process.exit(0)
      }
      process.once('SIGTERM', quit)
      process.once('SIGINT', quit)
    }
  })
}
