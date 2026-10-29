import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPublicClient, http, parseAbi, formatUnits, encodeFunctionData, isAddress, zeroAddress } from 'viem'
import { DIR } from './notes.js'
import { padNets, NOT_ON_MAINNET } from './gangpad.js'
import { bondAddress, BOND_ABI } from './bond.js'
import { walletFor } from './fair.js'
import { parseAmount, parseIntIn, step } from './steps.js'
import { buybackBpsOf, FACTORY_ABI, notDeployed, simulateCall, SPLITTER_ABI, splitterFactoryAddress, splitterOf } from './buyback.js'

/**
 * One command for a launch: `gang create … [--buyback <pct>] [--dev-buy <quote> [--bond <quote> [--bond-hold <tokens|N%|all>]
 * --bond-days <7-90>]]` (V3) and `gang fair create … [--shares <n>] --bond <quote> [--bond-hold …] --bond-days <7-90>` (打新: the dev buys its
 * shares in the create itself). Each run builds the next tx, as every other multi-step command does (wrap / approve
 * steps in between): run it, execute, run the same command again.
 *
 * Progress comes from the chain, not from what was executed: a plan file keeps the wallet, the name / symbol and the
 * pad's token count before the create, and each run looks for a token this wallet created with that symbol since then
 * (none yet → the create; found and the dev holds none → the V3 dev buy; holds some and no bond → the bond; else done).
 * The plan is written only once the create preview succeeds, and a run that finds no token never builds a second
 * create on its own (the first may still be landing): `--restart` does. The plan keeps the token once found (no rescan
 * on later runs) and is marked done at the end: a done launch only reports, even if the dev's balance or the bond
 * changed since (no second buy, bond or create) — for 7 days, then the plan expires.
 * --buyback (V3, taxed): before the create, GangBuybackSplitterFactory clones the dev's splitter at
 * predict(dev, salt), with a fresh salt per plan kept in it (so the address is known before the clone and never another
 * launch's), the create names it as the recipient, and a bind step follows the create. A launch keeps the mode it began
 * with: adding --buyback after the create (or dropping it before) is refused rather than starting over.
 * --buyback-to <addr> names where the dev's part goes (default: the dev); the dev can change it later at once.
 */

const LAUNCH_DIR = process.env.GANG_LAUNCH_DIR || join(dirname(DIR), 'launch')
const TTL_MS = 7 * 24 * 3600_000
const PAD_ABI = parseAbi([
  'function tokenCount() view returns (uint256)',
  'function allTokens(uint256) view returns (address)',
  'function kindOf(address token) view returns (uint8)',
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function sales(address token) view returns (address creator, uint64 progressAt, uint16 capShares, uint16 holdBps, address quote, uint16 sold, bool launched, uint16 mintFeeBps, uint16 exitFeeBps, address gate, uint128 sharePrice, address pair, address refPool, uint16 markSold)',
])
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'])
/** Flags only the chain reads; everything else goes to the step's own command. */
/** GANG on BSC mainnet: a quote gang.fun trusts besides WBNB and the pad's QuoteRegistry. */
const MAINNET_GANG_TOKEN = '0x0c6302401aa5325c2e36f170f52c00b1d220b405'
const REGISTRY_ABI = parseAbi(['function quoteRegistry() view returns (address)', 'function isQuoted(address quote) view returns (bool)'])

/**
 * --buyback only over a quote gang.fun trusts (WBNB, GANG, or listed in the pad's QuoteRegistry): a splitter prices each
 * buy-back chunk on what it sends, so a quote that taxes transfers into pairs fails the pair's K check on every chunk
 * and the buy-back part is stuck for good (GangBond re-review L-1, 2026-10-29; splitter v3 has the same pricing).
 * null when trusted; otherwise the failure to report.
 */
async function untrustedBuybackQuote(read, net, quote) {
  if (!isAddress(quote ?? '')) return { error: '--quote must be a 0x address', got: quote ?? null }
  const q = quote.toLowerCase()
  if (q === String(net.wbnb).toLowerCase() || (String(net.chainId) === '56' && q === MAINNET_GANG_TOKEN)) return null
  const registry = await read(net.pad, REGISTRY_ABI, 'quoteRegistry').catch(() => null)
  const listed = registry === null ? null
    : registry === zeroAddress ? false
      : await read(registry, REGISTRY_ABI, 'isQuoted', [quote]).catch(() => null)
  if (listed) return null
  return {
    error: listed === null
      ? 'could not read the pad\'s QuoteRegistry to check the --buyback quote: try again'
      : '--buyback needs WBNB, GANG or a quote listed in the pad\'s QuoteRegistry: the buy-back splitter cannot buy back with a quote that taxes transfers into the pair, and an unlisted quote may do that',
    quote, hint: 'drop --quote (WBNB), use a listed quote, or launch without --buyback',
  }
}

export const LAUNCH_FLAGS = ['dev-buy', 'bond', 'bond-hold', 'bond-days', 'buyback', 'buyback-to', 'restart']
const NOTE_FLAGS = ['note', 'conf', 'reveal-after']
/** `gang fair create --dev-buy`, with or without --bond (index.js stops the lone flag, runLaunch the chained one). */
export const FAIR_DEV_BUY = 'a 打新 dev buys its shares in the create itself: use --shares <n> (not --dev-buy)'

/** The run asks for a chained launch (`kind` 'v3' | 'fair'). */
export const isLaunch = (kind, flag) => flag('bond') || flag('buyback') || (kind === 'v3' && flag('dev-buy'))

const planPath = (key) => join(LAUNCH_DIR, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)

function readPlan(key) {
  try {
    const p = JSON.parse(readFileSync(planPath(key), 'utf8'))
    return p.createdAt > Date.now() - TTL_MS ? p : null
  } catch { return null }
}

function writePlan(key, plan) {
  mkdirSync(LAUNCH_DIR, { recursive: true, mode: 0o700 })
  for (const name of readdirSync(LAUNCH_DIR)) {
    const f = join(LAUNCH_DIR, name)
    try { if (Date.now() - statSync(f).mtimeMs > TTL_MS) unlinkSync(f) } catch { /* gone */ }
  }
  const p = planPath(key)
  writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify({ ...plan, createdAt: Date.now() }), { mode: 0o600 })
  renameSync(`${p}.${process.pid}.tmp`, p)
}

/** An argv reader over `base` (the real one) with `over` replacing / adding flags; a value of undefined drops one. */
function argsWith(base, over, drop = []) {
  const has = (n) => (n in over ? over[n] !== undefined : !drop.includes(n) && base.flag(n))
  return {
    flag: has,
    opt: (n, def) => (n in over ? (over[n] === undefined ? def : String(over[n])) : drop.includes(n) ? def : base.opt(n, def)),
  }
}

/**
 * Entry. `kind` 'v3' | 'fair'. deps: { io (index.js PAD_IO: opt, flag, out, fail, …), runV3, runFair, runBond, padNotes }.
 */
export async function runLaunch(kind, { io, runV3, runFair, runBond, padNotes }) {
  const { opt, flag, out, fail } = io
  const testnet = flag('testnet')
  const net = padNets(kind)[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) return fail(NOT_ON_MAINNET)
  const name = opt('name'), symbol = opt('symbol')
  if (!name || !symbol) fail('--name and --symbol are required')
  if (flag('follow')) fail('--follow does not apply to a launch')
  if (kind === 'fair' && flag('dev-buy')) fail(FAIR_DEV_BUY)
  if (kind === 'fair' && flag('buyback')) fail('--buyback is for V3 tokens: it makes the tax recipient a buy-back splitter, and a 打新 token has no recipient')

  // everything checked before the create, so a launch never stops half way on a bad flag
  const devBuy = kind === 'v3' && flag('dev-buy') ? parseAmount(fail, 'dev-buy', opt('dev-buy')) : null
  const bonding = flag('bond')
  if (!bonding && (flag('bond-hold') || flag('bond-days'))) fail('--bond-hold / --bond-days go with --bond <quote>')
  let bond = null
  if (bonding) {
    if (flag('cover')) fail('--cover needs the PancakeSwap pair: a launch bonds before it, so give --bond <quote>')
    if (kind === 'v3' && !devBuy) fail('a V3 launch with --bond needs --dev-buy <quote>: the creator holds nothing until it buys on the curve')
    if (!bondAddress(testnet)) fail(`GangBond is not deployed on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} in this CLI version: drop --bond (and --bond-hold / --bond-days), or add --testnet`)
    const hold = String(opt('bond-hold', 'all')).trim()
    if (!(hold === 'all' || /^(\d+(\.\d*)?|\.\d+)%?$/.test(hold)) || /^0*(\.0*)?%?$/.test(hold)) {
      fail('--bond-hold must be all (everything the dev holds), a token amount, or N% of the supply', { got: opt('bond-hold') })
    }
    bond = { amount: parseAmount(fail, 'bond', opt('bond')), hold, days: parseIntIn(fail, 'bond-days', opt('bond-days'), 7, 90) }
  }

  // --buyback: a taxed V3 token whose recipient (the part left after holders) is the dev's splitter
  let buyback = null
  if (flag('buyback-to') && !flag('buyback')) fail('--buyback-to <addr> goes with --buyback <pct>: it names where the part not bought back goes')
  if (flag('buyback')) {
    const zero = (f) => /^0+(\.0+)?$/.test(opt(f) ?? '')
    if (!flag('buy-tax') || !flag('sell-tax') || (zero('buy-tax') && zero('sell-tax'))) {
      fail('--buyback needs a taxed token: add --buy-tax and --sell-tax (each 1–5, in %); the buy-back is paid from the tax')
    }
    if (flag('recipient')) fail('--buyback makes the recipient your buy-back splitter: leave --recipient out')
    if (/^0*100(\.0+)?$/.test(opt('dividend', '0'))) fail('--dividend 100 leaves nothing for the recipient, so nothing to buy back: lower it or drop --buyback')
    const factory = splitterFactoryAddress(testnet)
    if (!factory) fail(notDeployed(testnet))
    let payee = null
    if (flag('buyback-to')) {
      payee = opt('buyback-to')
      if (!isAddress(payee ?? '') || payee === zeroAddress) fail('--buyback-to must be a 0x address, checksummed or all lowercase (where the part not bought back goes; leave it out for your own wallet)', { got: payee ?? null })
    }
    buyback = { bps: buybackBpsOf(fail, opt('buyback')), factory, payee }
  }

  const client = createPublicClient({ chain: net.chain, transport: http(net.rpc) })
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args })
  const me = walletFor({ chainId: net.chainId }, opt('from'))
  const key = [net.chainId, net.pad, me.toLowerCase(), kind, name, symbol].join('|')
  const steps = [...(buyback ? ['buyback-splitter'] : []), kind === 'v3' ? 'create' : 'create (dev shares included)', ...(buyback ? ['bind'] : []),
    ...(devBuy ? ['dev-buy'] : []), ...(bond ? ['bond'] : [])]
  const rerun = 're-run this same command after executing it'
  const tag = (stage, extra = {}) => ({ launch: { stage, steps, ...extra } })
  const withTag = (stage, extra) => (o) => out({ ...o, ...tag(stage, extra) })

  let plan = flag('restart') ? null : readPlan(key)
  const base = { kind, name, symbol, me, chainId: net.chainId, pad: net.pad }

  // ---- a launch keeps the mode it began with (the create, once built, is never redone by a changed flag)
  const created = plan?.startCount !== undefined
  if (buyback && created && !plan.splitter) {
    return fail('this launch was created without --buyback (its recipient is fixed): run it again without --buyback, or add --restart for a new token')
  }
  if (!buyback && !created && plan?.salt) {
    return fail('this launch began with --buyback (its splitter is cloned or on the way): run it again with --buyback, or add --restart without it')
  }

  // ---- buy-back splitter: cloned for the dev before the create, at predict(dev, plan.salt)
  if (buyback && !created) {
    if (!plan?.salt) {
      const refused = await untrustedBuybackQuote(read, net, flag('quote') ? opt('quote') : net.wbnb)
      if (refused) {
        const { error, ...extra } = refused
        return fail(error, extra)
      }
      const salt = `0x${randomBytes(32).toString('hex')}`
      const at = await read(buyback.factory, FACTORY_ABI, 'predict', [me, salt])
      const args = [buyback.bps, salt, buyback.payee ?? zeroAddress]
      const sim = await simulateCall(client, me, buyback.factory, FACTORY_ABI, 'create', args)
      if (sim.failed) return out({ success: false, step: 'buyback-splitter', ...tag('buyback-splitter'), ...sim.failed })
      writePlan(key, { ...base, salt, splitter: at, factory: buyback.factory })
      const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: 'create', args })
      return out({
        ...step({ chainId: net.chainId }, { from: me, to: buyback.factory, data }, {
          step: 'buyback-splitter', chainId: Number(net.chainId), factory: buyback.factory, buybackPct: buyback.bps / 100,
          splitter: at, payee: buyback.payee ?? me,
          note: `clones your buy-back splitter (listed as a tax recipient in the same tx): ${buyback.bps / 100}% of the recipient's part is bought back and burned, the rest goes to ${buyback.payee ? `${buyback.payee} (--buyback-to)` : 'you'}. Later a raise applies at once, a cut only after a 3-day notice; the payee can be changed at once (gang buyback set-payee)`,
        }, flag('calldata'), io.summarize),
        ...tag('buyback-splitter', { splitter: at, next: `${rerun}: it then builds the create with the splitter as the recipient` }),
      })
    }
    if ((await client.getCode({ address: plan.splitter }) ?? '0x') === '0x') {
      return out({
        success: false, ...tag('buyback-splitter', { splitter: plan.splitter }), error: 'the buy-back splitter is not on chain yet',
        hint: `if the clone was executed, wait for it to land and ${rerun.replace(' after executing it', '')}; if it was not, add --restart to build it again`,
      })
    }
    const s = await splitterOf(read, plan.splitter)
    if (!s || s.dev.toLowerCase() !== me.toLowerCase() || s.token) {
      return fail('the splitter at this launch\'s address is not an unbound buy-back splitter of this wallet: add --restart', { splitter: plan.splitter })
    }
    if (s.buybackBps !== buyback.bps) {
      return fail(`this launch's splitter buys back ${s.buybackPct}%, not ${buyback.bps / 100}%: run it again with --buyback ${s.buybackPct}, or add --restart for a new splitter (gang buyback set changes it after the create)`, { splitter: plan.splitter })
    }
    const wantPayee = (buyback.payee ?? me).toLowerCase()
    if (s.payee.toLowerCase() !== wantPayee) {
      const was = s.payee.toLowerCase() === me.toLowerCase() ? 'leave --buyback-to out' : `--buyback-to ${s.payee}`
      return fail(`this launch's splitter pays ${s.payee}, not ${buyback.payee ?? me}: run it again with ${was}, or add --restart for a new splitter (gang buyback set-payee changes it after the create)`, { splitter: plan.splitter })
    }
  }

  // ---- create
  if (!created) {
    const startCount = (await read(net.pad, PAD_ABI, 'tokenCount')).toString()
    const createIo = {
      ...io,
      ...argsWith(io, plan?.splitter ? { recipient: plan.splitter } : {}, LAUNCH_FLAGS),
      out: (o) => {
        // the plan starts with the create tx itself: a wrap / approve step before it (or a failed preview) leaves none,
        // so the next run builds the create again
        const built = o.success && o.step === 'create'
        if (built) writePlan(key, { ...base, ...(plan?.splitter && { salt: plan.salt, splitter: plan.splitter, factory: plan.factory }), startCount })
        const after = steps[steps.indexOf(kind === 'v3' ? 'create' : 'create (dev shares included)') + 1]
        return out({
          ...o,
          ...tag('create', built ? { next: `${rerun}: it finds the new token and continues with ${after ?? 'nothing'}` } : o.success ? { next: `${rerun}: it then builds the create` } : {}),
        })
      },
    }
    if (kind === 'v3') return runV3('create', { ...createIo, notes: padNotes('v3', 'create') })
    return runFair('create', { ...createIo, notes: padNotes('fair', 'create') })
  }

  // ---- the token this plan created: kept in the plan once found, else looked up from the pad's list since the plan
  let token = plan.token ?? null
  if (!token) {
    const count = Number(await read(net.pad, PAD_ABI, 'tokenCount'))
    for (let i = Number(plan.startCount); i < count && !token; i++) {
      const t = await read(net.pad, PAD_ABI, 'allTokens', [BigInt(i)])
      const k = Number(await read(net.pad, PAD_ABI, 'kindOf', [t]))
      const creator = k === 1 ? (await read(net.pad, PAD_ABI, 'curves', [t]))[0] : k === 2 ? (await read(net.pad, PAD_ABI, 'sales', [t]))[0] : zeroAddress
      if (creator.toLowerCase() !== me.toLowerCase()) continue
      if ((await read(t, ERC20_ABI, 'symbol')) === symbol) token = t
    }
    if (token) {
      plan = { ...plan, token }
      writePlan(key, plan)
    }
  }
  if (!token) {
    return out({
      success: false, ...tag('create'), error: 'no token from this launch yet',
      hint: `if the create was executed, wait for it to land and ${rerun.replace(' after executing it', '')}; if it was not (or its preview failed), add --restart to build the create again`,
    })
  }

  // later steps carry no note (it went on the create) and take the token from the plan
  const stepIo = (over) => ({ ...io, ...argsWith(io, { ...over, token }, [...LAUNCH_FLAGS, ...NOTE_FLAGS, 'name', 'symbol']) })
  const bal = await read(token, ERC20_ABI, 'balanceOf', [me])
  const buybackState = () => (plan.splitter ? splitterOf(read, plan.splitter) : null)

  // ---- done: the report only, whatever happened to the balance or the bond since
  const report = async () => {
    const done = {
      success: true, ...tag('done', { token, again: 'this launch is done; running the command again only reports it. Another token with the same name / symbol: add --restart' }),
      token, name, symbol, devBalance: formatUnits(bal, 18), chainId: Number(net.chainId),
    }
    const bb = await buybackState()
    if (bb) done.buyback = bb
    if (!bond) return out({ ...done, note: `launched: gang ${kind} info --token ${token}${testnet ? ' --testnet' : ''}` })
    return runBond('status', { ...stepIo({}), out: (o) => out({ ...done, bondStatus: o, note: `launched and bonded: gang bond status --token ${token}${testnet ? ' --testnet' : ''}` }) })
  }
  if (plan.done) return report()

  // ---- bind the splitter to the token (anyone may; the launch does it right after the create)
  if (plan.splitter) {
    const bound = await read(plan.splitter, SPLITTER_ABI, 'token')
    if (bound === zeroAddress) {
      const sim = await simulateCall(client, me, plan.splitter, SPLITTER_ABI, 'bind', [token])
      if (sim.failed) return out({ success: false, step: 'bind', ...tag('bind', { token }), ...sim.failed })
      const data = encodeFunctionData({ abi: SPLITTER_ABI, functionName: 'bind', args: [token] })
      return out({
        ...step({ chainId: net.chainId }, { from: me, to: plan.splitter, data }, {
          step: 'bind', chainId: Number(net.chainId), token, splitter: plan.splitter,
          note: 'ties the splitter to this token for good (what it buys back and burns)',
        }, flag('calldata'), io.summarize),
        ...tag('bind', { token, next: `${rerun}${devBuy ? ': it continues with the dev buy' : bond ? ': it continues with the bond' : ': the launch is then done'}` }),
      })
    }
    if (bound.toLowerCase() !== token.toLowerCase()) {
      return out({ success: false, ...tag('bind', { token }), error: 'the splitter is bound to another token', splitter: plan.splitter, boundTo: bound })
    }
  }

  // ---- V3 dev buy (a 打新 dev already holds its shares' tokens)
  if (devBuy && bal === 0n) {
    return runV3('buy', {
      ...stepIo({ amount: devBuy }), out: withTag('dev-buy', { token, next: `${rerun}${bond ? ': it continues with the bond' : ': the launch is then done'}` }),
      notes: padNotes('v3', 'buy', { note: null }),
    })
  }

  // ---- bond
  if (bond) {
    const b = await read(bondAddress(testnet), BOND_ABI, 'bondOf', [token])
    if (Number(b.round) === 0) {
      const hold = bond.hold === 'all' ? formatUnits(bal, 18) : bond.hold
      return runBond('post', {
        ...stepIo({ amount: bond.amount, hold, days: bond.days, cover: undefined }),
        out: withTag('bond', { token, next: `${rerun}: it reports the launch` }),
      })
    }
  }

  // ---- every step done: mark the plan, so later runs only report (never a second buy, bond or create)
  writePlan(key, { ...plan, done: true })
  return report()
}
