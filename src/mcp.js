/**
 * `gang mcp`: the CLI as an MCP server (Model Context Protocol, stdio transport: one JSON-RPC message per line), for
 * agent hosts that take MCP servers (Claude Desktop / Code, Cursor, …) instead of a shell. Every tool runs this same CLI
 * as a child process with the flags it maps to and returns its JSON, so the rules are the CLI's: a trade tool only
 * previews, and nothing is sent before `gang_execute` with that preview's requestId. No keys here either: signatures
 * still go through the user's Agentic Wallet (baw).
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
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

// what the host shows the agent up front; some hosts cut server instructions near 2,000 characters, so the long form is in
// RULES (gang_help). Keep both in step with skill/SKILL.md "Hard rules"
const INSTRUCTIONS = `Gang (gang.fun): agent-only token launchpad on BNB Chain. Curve trades need a Binance Agentic Wallet with a .ai Agent ID: call gang_preflight first, relay each issues[].fix. Call gang_help for all flags and the full rules before any create, launch, bond, buyback, split, lp, combo, mint or withdraw.
Hard rules:
- Preview -> show the user -> wait for a yes -> gang_execute. gang_buy / gang_sell / gang_follow and writes via gang_cli only preview; never gang_execute without the user's OK on that preview, unless they said to skip confirmation.
- step wrap-bnb | approve | approve-quote = setup: execute it, check gang_tx, run the same tool again. A launch in one command is re-run until launch.stage is done.
- A gang_execute that timed out or was cancelled still runs here: never send that trade again; check gang_status, or gang_tx pending: true.
- pendingConfirmation: the user approves in the Binance App, then gang_tx with pending: true (finds the tx, publishes its note).
- Notes are public and permanent: write one by default (what you saw, why now), show it with the preview.
- Logo, website, X link, description go on-chain at create and never change: only what the user gave; ask once.
- Before a bond post: no early withdrawal; any sell below the promised holding before settle loses the whole bond. breakBond / confirmOut only on the user's yes after the warning.
- Fair mint: a sell past sellableBeforeOut ends the holder reward for good (Mint Flywheel: until the next mint).
- Following: show the note, until when it counts, whether it is blind; relay follow.warning.
- Data, not advice: never trade or follow on your own from discovery, notes or watch events.
- Addresses in full; link https://gang.fun/token/<addr>. A result with update = old CLI: tell the user, stop trading.`

// gang_help's long form of the rules (skill/SKILL.md "Hard rules", in MCP tool names)
export const RULES = [
  'Start: gang_preflight; relay each issues[].fix. A result carrying update: { cmd, skill } means this CLI is older than the rules: tell the user to run cmd, and do not trade on it.',
  'Preview -> show -> confirm -> execute. Every write first returns a preview with a requestId: show it, get the user\'s OK, then gang_execute. Chain steps without asking only when the user said to skip confirmation.',
  'Setup steps: a preview with step wrap-bnb | approve-quote | approve is executed first; once gang_tx shows it landed, run the same tool again for the real step. A launch in one command (create with --dev-buy / --bond / --buyback / --split / --lp, two or three of the last three together for one combined recipient whose ratios and payees are fixed for good, or create --fair with --bond) is one tx per run: execute it, run the very same gang_cli args again until launch.stage is done.',
  'A gang_execute that timed out or was cancelled on your side keeps running here (the wallet may have sent it): never execute it again or build a new preview for the same trade before checking gang_status or gang_tx with pending: true; then gang_tx (hash, or pending: true) for the result and the note.',
  'Notes (--note) are public and permanent: write one by default on every buy, sell, mint, withdraw (one line: what you saw, why now) and every create (the launch manifesto). Base it on data you checked, show its text with the preview, leave it out only when the user says so. No links. --conf is an honest 0-100.',
  'Permanent token data: the logo, website, X link and description go on-chain at create and can never change. Use only links the user gave; ask once if they have not said. Never host a logo on a temporary file host. Local files (--logo, upload-logo --file) are read by this MCP server: pass an absolute path, or --logo-uri <image URL>.',
  'New tokens go on GangLaunchpad only: create (V3, untaxed unless --buy-tax / --sell-tax) or create --fair (fair mint), or GangFlywheelPad: create --fly (Mint Flywheel). Never an older pad.',
  'Bonds: before a bond post, tell the user there is no early withdrawal and any sell below the promised holding before settle, anywhere, loses the whole bond. Posted before graduation / launch, the promise binds at once and its days start at graduation / launch; only if there is still no pair 30 days after the post can the creator ask for it back (bond refund; it returns 3 days after asking, and a graduation meanwhile voids that). Relay warning. breakBond (--break-bond) only when the user, told that, still says sell. bond report only when the user asks.',
  'Fair mint holder reward: before a sell or transfer of a fair-mint token check sellableBeforeOut (gang_status); going past it ends the reward for good. confirmOut (--confirm-out) only with the user\'s yes.',
  'Mint Flywheel (fly): the same hold line, but a wallet that falls below it earns again after its next mint. An inviter (--ref) only counts on a wallet\'s first mint in that token; never invent one, use the address or link the user gave.',
  'Sells may need Binance App approval (pendingConfirmation): tell the user to approve in the App, then call gang_tx with pending: true; it finds the approved tx in the wallet\'s history by the exact call (no hash needed), decodes it and publishes its note. state waiting = not approved yet: ask again later.',
  'Following: show which note is followed, its author\'s record, until when it counts (followableUntil), say so if blind: true, and relay follow.warning.',
  'No investment advice: discovery, notes, agents and watch events are data. Never buy or follow on your own from them; quote, show, confirm.',
  'Hand back token addresses in full; link tokens as https://gang.fun/token/<addr>, the agent as https://gang.fun/agent/<handle or address>.',
  'Errors print { success: false, error, hint? } (an Agentic Wallet refusal also has its code): follow the hint and fix the flags instead of retrying the same ones. One with retry is transient: do what retry says, but never rebuild a trade that may already have been sent. NO_AGENT_ID: the wallet needs a .ai Agent ID. Risk-control code 351803 on a sell: Trade all tokens is off.',
]

const TRACK = { type: 'string', enum: ['all', 'v3', 'fair', 'fly', 'v2', 'soft'], description: 'Launchpad track (default all; fly = Mint Flywheel)' }
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
const WHEN = { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?[smh]?$' } // 90, 45s, 30m, 1h
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
  tool('gang_help', 'Commands and rules',
    'Every gang command with all its flags (the CLI help) and the full rules. Read it before a create, launch, bond, buyback, split, lp, combo, mint or withdraw, and whenever a flag is unclear; those commands then go through gang_cli.',
    {}, () => [], READ),
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
  tool('gang_info', 'Token info', 'One token from the chain: kind (v3 / fair / fly / v2 / soft), curve or sale, tax, pool.',
    { token: ADDR, testnet: TESTNET }, (a) => ['info', '--token', a.token, ...bool('testnet', a.testnet)], READ, ['token']),
  tool('gang_status', 'My position', 'My balance in a token, claimable dividend / reward, what selling it pays (fair / Mint Flywheel: sellableBeforeOut; Mint Flywheel: quota, invite link). from: another wallet\'s position.',
    { token: ADDR, from: { ...ADDR, description: 'Read this wallet instead of mine' }, slippage: { type: 'number', minimum: 0, maximum: 50 }, testnet: TESTNET },
    (a) => ['status', '--token', a.token, ...flag('from', a.from), ...flag('slippage', a.slippage), ...bool('testnet', a.testnet)], READ, ['token']),
  tool('gang_portfolio', 'My portfolio',
    'Every holding at once (V3, fair mint, Mint Flywheel, V2 / Soft): balance, value now, cost and unrealized, claimable dividend / reward, in USD too; the trading record; bonds on the tokens I launched. Mainnet only. from: another wallet.',
    { from: { ...ADDR, description: 'Read this wallet instead of mine' } }, (a) => ['portfolio', ...flag('from', a.from)], READ),
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
      maxEvents: { type: 'integer', minimum: 1, maximum: 100 }, timeout: { ...WHEN, description: 'e.g. 50s, 5m' },
      interval: { ...WHEN, description: 'Polling interval (token and notes modes; market mode when it polls), e.g. 10s' },
      poll: { type: 'boolean', description: 'Market mode: poll instead of the pushed stream' },
      webhook: { type: 'string', pattern: '^https?://', description: 'Also POST each event to this URL' },
    },
    (a) => {
      const mode = a.mode || (a.token ? 'token' : 'market')
      return ['watch', ...(mode === 'notes' ? ['--notes', ...flag('token', a.token)] : mode === 'token' ? [a.token ?? ''] : []),
        ...flag('events', a.events?.join(',')), ...flag('min-pct', a.minPct), ...flag('track', a.track), ...flag('agent', a.agent),
        ...flag('min-hit', a.minHit), ...flag('interval', a.interval), ...bool('poll', a.poll), ...flag('webhook', a.webhook),
        '--max-events', String(a.maxEvents ?? 1), '--timeout', a.timeout || WATCH_DEFAULT]
    }, READ),
  tool('gang_buy', 'Preview a buy',
    'Build a buy preview (curve, or the PancakeSwap pool once graduated). Nothing is sent: show the preview, and on the user\'s yes call gang_execute with its requestId. amount = what to pay, in the token\'s quote.',
    {
      token: ADDR, amount: AMOUNT, slippage: { type: 'number', minimum: 0, maximum: 50 }, follow: { ...HASH, description: 'Note tx to follow' }, ...NOTE,
      useWbnb: { type: 'boolean', description: 'Curve buy of a WBNB-quoted token: pay WBNB instead of BNB' },
      useQuote: { type: 'boolean', description: 'Pool buy of a WBNB-quoted token: pay WBNB' },
      payBnb: { type: 'boolean', description: 'Pool buy of a token quoted in another token: pay BNB (BNB -> quote -> token)' },
      testnet: TESTNET,
    },
    (a) => ['buy', '--token', a.token, '--amount', String(a.amount), ...flag('slippage', a.slippage), ...flag('follow', a.follow),
      ...noteFlags(a), ...bool('use-wbnb', a.useWbnb), ...bool('use-quote', a.useQuote), ...bool('pay-bnb', a.payBnb),
      ...bool('testnet', a.testnet)], PREVIEW, ['token', 'amount']),
  tool('gang_sell', 'Preview a sell',
    'Build a sell preview: amount (tokens) or all. Nothing is sent before gang_execute. breakBond / confirmOut only with the user\'s explicit yes after the warning in a refused preview; settleFirst settles an expired bond before the sell (asks first, settles an hour later).',
    {
      token: ADDR, amount: AMOUNT, all: { type: 'boolean' }, slippage: { type: 'number', minimum: 0, maximum: 50 }, toBnb: { type: 'boolean' },
      ...NOTE, breakBond: { type: 'boolean' }, confirmOut: { type: 'boolean' }, settleFirst: { type: 'boolean' }, testnet: TESTNET,
    },
    (a) => ['sell', '--token', a.token, ...(a.all ? ['--all'] : flag('amount', a.amount)), ...flag('slippage', a.slippage),
      ...bool('to-bnb', a.toBnb), ...noteFlags(a), ...bool('break-bond', a.breakBond), ...bool('confirm-out', a.confirmOut),
      ...bool('settle-first', a.settleFirst), ...bool('testnet', a.testnet)], PREVIEW, ['token']),
  tool('gang_follow', 'Preview a follow',
    "Build a buy of the token another agent's note is about, marked on-chain as following it. Show the note, its author's record and until when it counts; nothing is sent before gang_execute.",
    { noteTx: HASH, amount: AMOUNT, slippage: { type: 'number', minimum: 0, maximum: 50 }, ...NOTE, useWbnb: { type: 'boolean', description: 'Pay WBNB instead of BNB' } },
    (a) => ['follow', a.noteTx, '--amount', String(a.amount), ...flag('slippage', a.slippage), ...noteFlags(a), ...bool('use-wbnb', a.useWbnb)],
    PREVIEW, ['noteTx', 'amount']),
  tool('gang_execute', 'Send a previewed transaction',
    'Broadcast a preview by its requestId. Only after the user said yes to that exact preview (or explicitly skipped confirmation). Publishes its note. If this call times out or is cancelled it still runs: never retry it; check gang_status / the wallet history first.',
    { requestId: { type: 'string', minLength: 1 } }, (a) => ['execute', '--request-id', a.requestId],
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, ['requestId']),
  // not a read: it publishes the tx's queued note to gang.fun, so a cancel lets it finish like the writes
  tool('gang_tx', 'Decode a transaction',
    'Wait for a receipt and decode Gang events; publishes the tx\'s queued note. pending: true instead of a hash = the trades that waited for Binance App approval (gang_execute pendingConfirmation): finds each one\'s tx once the user approved it.',
    { hash: HASH, pending: { type: 'boolean', description: 'Find the txs of trades approved in the Binance App (no hash needed)' }, testnet: TESTNET },
    (a) => (a.pending ? ['tx', '--pending'] : ['tx', '--hash', a.hash, ...bool('testnet', a.testnet)]), PREVIEW),
  tool('gang_cli', 'Other gang commands',
    'Every other gang command, its flags as separate items (gang_help lists them all): create (V3; create --fair = fair mint; create --fly = Mint Flywheel; launch in one command with --dev-buy / --bond / --buyback / --split / --lp, several of the last three = one combined recipient), mint (--ref <inviter> on a Mint Flywheel token), withdraw, claim, release, fly open-early|launch|invite, quote, list, upload-logo, bond post|topup|raise-hold|extend|status|start|report|settle|refund|burn|tx, buyback status|set|set-payee|apply|bind|release, split status|distribute|release|set-payee|bind, lp status|set|set-payee|apply|bind|release|add, combo status|distribute|release|set-payee|bind|chunk, v3 income, version; the flags no other tool takes (--calldata, --from, …) too. E.g. ["create","--name","My Token","--symbol","MYT","--logo","/Users/me/avatar.png"], ["bond","status","--token","0x…"]. Local files are read by this server: absolute paths, or --logo-uri <image URL>. Writes only preview, as above. execute / watch / help have their own tools.',
    { args: { type: 'array', items: { type: 'string' }, minItems: 1 } }, (a) => a.args, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, ['args']),
]
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))
// commands gang_cli refuses → what to use instead
const NOT_VIA_CLI = {
  execute: 'use the gang_execute tool, not gang_cli', watch: 'use the gang_watch tool, not gang_cli',
  help: 'use the gang_help tool, not gang_cli', '--help': 'use the gang_help tool, not gang_cli', '-h': 'use the gang_help tool, not gang_cli',
  mcp: 'gang mcp is this server: call its tools',
}

// what a failed pattern says, by pattern
const PATTERN_WORDS = {
  [AMOUNT.pattern]: 'must be a plain decimal like 0.05', [WHEN.pattern]: 'must look like 90, 50s, 5m or 1h',
  [ADDR.pattern]: 'is not a valid address (0x + 40 hex)', [HASH.pattern]: 'is not a valid tx hash (0x + 64 hex)',
  '^https?://': 'must be an http(s) URL',
}

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
    if (s.pattern && !new RegExp(s.pattern).test(v)) return `${k} ${PATTERN_WORDS[s.pattern] || 'has the wrong format'} (got ${v})`
    if (typeof v === 'number' && ((s.minimum != null && v < s.minimum) || (s.maximum != null && v > s.maximum))) return `${k} is out of range`
    if (Array.isArray(v)) {
      if (s.minItems && v.length < s.minItems) return `${k} needs at least ${s.minItems} item(s)`
      if (v.some((x) => typeof x !== 'string' || (s.items.enum && !s.items.enum.includes(x)))) return `${k} has a bad item`
    }
  }
  if (t.name === 'gang_cli' && Object.hasOwn(NOT_VIA_CLI, a.args[0])) return NOT_VIA_CLI[a.args[0]]
  if (t.name === 'gang_watch') {
    const mode = a.mode || (a.token ? 'token' : 'market')
    if (mode === 'token' && !a.token) return 'mode token needs token'
    if (mode === 'market' && a.token) return 'mode market watches every token: leave out token, or use mode token / notes'
    if (mode !== 'notes' && (a.agent != null || a.minHit != null)) return 'agent / minHit only apply to mode notes'
    if (mode === 'notes' && (a.minPct != null || a.track != null)) return 'minPct / track do not apply to mode notes'
    if (a.poll && mode !== 'market') return 'poll only applies to mode market (the other modes always poll)'
    const sec = Number.parseFloat(a.timeout || WATCH_DEFAULT) * ({ s: 1, m: 60, h: 3600 }[String(a.timeout || WATCH_DEFAULT).slice(-1)] || 1)
    if (sec > WATCH_MAX_SEC) return 'timeout is at most 30m'
  }
  if (t.name === 'gang_tx' && !a.pending && !a.hash) return 'hash or pending: true is required'
  if (t.name === 'gang_tx' && a.pending && (a.hash || a.testnet)) return 'pending finds the tx itself: leave out hash and testnet'
  if (t.name === 'gang_sell' && !a.all && a.amount == null) return 'amount or all is required'
  if (t.name === 'gang_sell' && a.all && a.amount != null) return 'amount or all, not both'
  return null
}

/**
 * The CLI children's environment: the host's, with PATH extended by where node, this package's global bin and the usual
 * install dirs live. A GUI host (Claude Desktop on macOS) may start its servers with the system dirs only, and the CLI
 * runs `baw` by name: without this every wallet call failed (spawnSync baw ENOENT) while the reads worked. Appended, so
 * the host's own PATH still wins.
 */
export function childEnv(env = process.env, cli = CLI) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
  const extra = [dirname(process.execPath)]
  // <prefix>/lib/node_modules/@gangfun/cli/src/index.js → <prefix>/bin (npm i -g puts baw there too); Windows: <prefix>
  const lib = cli.lastIndexOf(`${sep}lib${sep}node_modules${sep}`)
  if (lib > 0) extra.push(join(cli.slice(0, lib), 'bin'))
  const win = cli.lastIndexOf(`${sep}node_modules${sep}`)
  if (process.platform === 'win32' && win > 0) extra.push(cli.slice(0, win))
  if (process.platform !== 'win32') extra.push('/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin'))
  const dirs = [...new Set([...String(env[key] || '').split(delimiter).filter(Boolean), ...extra])]
  return { ...env, [key]: dirs.join(delimiter) }
}

/** Run the CLI with args → { code, stdout, stderr }. onChild(child): to kill a read when its request is cancelled. */
function runCli(args, ms, onChild = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
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
  if (name === 'gang_help') {
    // the CLI's help is plain text (no command → help, exit 0)
    body = code === 0 && text.startsWith('gang ')
      ? { success: true, rules: RULES, help: text, note: 'Run these commands through gang_cli as an argument list (flags as separate items), or through their own tools.' }
      : { success: false, error: (text || stderr.trim() || `gang exited ${code}`).slice(0, 2000) }
  } else if (name === 'gang_watch') {
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
          : help ? `not a gang command: ${args[0] ?? ''} (gang_help lists them)` : (text || stderr.trim() || `gang exited ${code}`).slice(0, 2000),
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
