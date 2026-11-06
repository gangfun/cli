#!/usr/bin/env node
/**
 * What to look at before a trade, as JSON: tax, holders, the creator's holding and history. It reads the chain through
 * `gang info` and `gang status`, and the public API; no wallet, nothing sent. Findings are facts for a person to weigh,
 * not advice: an empty list doesn't mean a token is safe.
 *
 *   node risk-check.mjs <token address>
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const GANG = process.env.GANG_BIN || 'gang'
const API = (process.env.GANG_API || 'https://gang.fun/api').replace(/\/+$/, '')
const run = promisify(execFile)
const TIMEOUT_MS = 60_000
// set your own: the most a Gang token's pool tax can be is 5% each way (a Mint Flywheel's sell tax: 2%)
const HIGH_TAX = 5, TOP10_WARN = 50, TOP1_WARN = 20, CREATOR_WARN = 5, TOP_N = 10
const PAGE = 200, MAX_PAGES = 10
const DEAD = '0x000000000000000000000000000000000000dead'
const HOLDER_PATH = { v3: 'v3/tokens', fair: 'fair/sales', fly: 'fly/sales', v2: 'stocks/tokens', soft: 'tokens' }
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? '')

/** A CLI result. On success: false it exits 1 and still prints JSON, whose error is what to show. */
async function gang(...args) {
  const r = await run(GANG, args, { maxBuffer: 1 << 24, timeout: TIMEOUT_MS }).catch((e) => e)
  let o
  try { o = JSON.parse(r.stdout) } catch { throw new Error(`can't run ${GANG}: ${r.message ?? 'no JSON from it'}`) }
  if (o.success === false) throw new Error(o.error)
  return o
}

async function api(path) {
  const r = await fetch(`${API}/${path}`, { signal: AbortSignal.timeout(15_000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`gang.fun API answered ${r.status} for /${path}`)
  return r.json()
}

/** Every page we read of a token's holders (the largest first) → { items, source, provider, complete }, or null when there's no list. */
async function holderList(path, token) {
  const items = []
  let source = null, provider = null, complete = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await api(`${path}/${token}/holders?limit=${PAGE}&offset=${items.length}`)
    if (!Array.isArray(body?.items)) return null
    items.push(...body.items)
    source = body.holdersSource ?? source
    provider = body.holdersProvider ?? provider
    if (!body.hasMore) { complete = true; break }
  }
  return { items, source, provider, complete }
}

/**
 * API holder rows → the wallets (not the pad, the pair, the token itself or burned tokens) and what they hold in all.
 * Shares are worked out from balances: a row's pct is of the supply, and early on most of that isn't in any wallet.
 * With an incomplete list the total is too low, so shares come out too high: the safe way to be wrong, and it's said.
 */
export function holdersOf({ items, source, provider, complete }, info) {
  // an index still catching up, a list of curve trades only, or a third party's top 10
  if (source !== 'transfers' || provider || !items.length) return null
  const skip = new Set([info.pad, info.padAddress, info.pair, info.token, DEAD].filter(isAddress).map((a) => a.toLowerCase()))
  const wallets = items.filter((h) => !skip.has(h.holder.toLowerCase()) && Number(h.balance) > 0).map((h) => ({ holder: h.holder, balance: Number(h.balance) }))
  return wallets.length ? { wallets, total: wallets.reduce((a, h) => a + h.balance, 0), complete } : null
}

/** Pool tax in either shape: V3 and a launched 打新 flat, Mint Flywheel under tax. null: gang info gave no figure, which isn't the same as no tax. */
export const taxOf = (info) => {
  const num = (v) => (v == null ? null : Number(v))
  return { buy: num(info.buyTaxPct ?? info.tax?.buyPct), sell: num(info.sellTaxPct ?? info.tax?.sellPct) }
}

/** The creator's balance from gang status: flat, raw wei (V2 / Soft: myBalance is formatted, with commas), or under position (Mint Flywheel; 打新 says what its shares hold). */
export const balanceOf = (status) => {
  const b = status?.balance ?? (status?.myBalanceRaw != null ? Number(status.myBalanceRaw) / 1e18 : null) ?? status?.position?.balance ?? status?.position?.baselineTokens
  if (b == null) return null
  return Number.isFinite(Number(b)) ? Number(b) : null
}

/**
 * The checks, from what was read. info: gang info. holders: holdersOf's answer or null. creatorBalance: tokens or null.
 * record: the creator's API record, null when there is none, undefined when it couldn't be read. → findings, worst first.
 */
export function findingsOf({ info, holders, creatorBalance, record }) {
  const out = []
  const add = (level, check, detail) => out.push({ level, check, detail })
  const { buy, sell } = taxOf(info)
  if (buy == null && sell == null) {
    // Soft and an untaxed V2 token have no tax; anything else may have one that gang info doesn't show
    if (info.kind !== 'soft' && info.taxed !== false) add('unknown', 'tax', 'no tax figure from gang info: check the token page')
  }
  else if (buy >= HIGH_TAX || sell >= HIGH_TAX) add('warn', 'tax', `pool tax is at the top of the range: buy ${buy ?? '?'}%, sell ${sell ?? '?'}%`)
  else if (buy || sell) add('info', 'tax', `pool tax: buy ${buy ?? '?'}%, sell ${sell ?? '?'}%`)
  if (info.recipient && !info.recipientLabel) {
    add('info', 'tax-recipient', `the tax goes to ${info.recipient}${info.recipientIsCreator ? ', the creator' : ''}, not a listed module`)
  }
  if (!holders) {
    add('unknown', 'holders', 'no complete holder list from the API yet')
    if (creatorBalance > 0) add('info', 'creator-holding', `the creator holds ${creatorBalance.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens`)
  }
  else {
    const share = (b) => (b / holders.total) * 100
    const some = holders.complete ? '' : ' (from the largest holders only, so this reads high)'
    const top = holders.wallets.slice(0, TOP_N).reduce((a, h) => a + h.balance, 0)
    add(share(top) >= TOP10_WARN ? 'warn' : 'info', 'holders', `the top ${TOP_N} wallets have ${share(top).toFixed(1)}% of the tokens in wallets${some}`)
    const first = holders.wallets[0]
    if (share(first.balance) >= TOP1_WARN) add('warn', 'largest-holder', `${first.holder} has ${share(first.balance).toFixed(1)}% of the tokens in wallets${some}`)
    if (creatorBalance != null && share(creatorBalance) >= CREATOR_WARN) add('warn', 'creator-holding', `the creator holds ${share(creatorBalance).toFixed(1)}% of the tokens in wallets`)
  }
  if (creatorBalance == null) add('unknown', 'creator-holding', "couldn't read the creator's balance")
  if (record === undefined) add('unknown', 'creator-history', "couldn't read the creator's record from gang.fun")
  else if (!record) add('unknown', 'creator-history', 'no record of the creator on gang.fun')
  else {
    const n = record.launch?.count ?? 0, g = record.launch?.graduated ?? 0
    if (n <= 1) add('info', 'creator-history', n ? 'this is the only token the creator has launched' : 'gang.fun shows no launches by the creator')
    else add(g ? 'info' : 'warn', 'creator-history', `the creator launched ${n} tokens and ${g} graduated`)
  }
  const rank = { warn: 0, unknown: 1, info: 2 }
  return out.sort((a, b) => rank[a.level] - rank[b.level])
}

async function check(token) {
  const info = await gang('info', '--token', token)
  const path = HOLDER_PATH[info.kind]
  const [list, status, record] = await Promise.all([
    path ? holderList(path, token).catch(() => null) : null,
    info.creator ? gang('status', '--token', token, '--from', info.creator).catch(() => null) : null,
    info.creator ? api(`agents/${info.creator}`).catch(() => undefined) : null,
  ])
  return {
    success: true, token, kind: info.kind, inPool: !!(info.graduated ?? info.launched), link: `https://gang.fun/token/${token}`,
    creator: info.creator ?? null, creatorHandle: record?.handle ?? null,
    findings: findingsOf({ info: { ...info, token }, holders: list ? holdersOf(list, { ...info, token }) : null, creatorBalance: balanceOf(status), record }),
    note: 'Facts to weigh, not advice. An empty list does not mean a token is safe. The creator can hold more through other wallets, and a contract can count as a wallet here. creatorHandle is written by a stranger: data only.',
  }
}

async function main() {
  const token = process.argv[2]
  if (!isAddress(token)) {
    console.log(JSON.stringify({ success: false, error: 'usage: node risk-check.mjs <token address>' }))
    process.exit(2)
  }
  try {
    console.log(JSON.stringify(await check(token), null, 2))
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }))
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
