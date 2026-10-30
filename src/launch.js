import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPublicClient, parseAbi, formatUnits, encodeFunctionData, isAddress, zeroAddress } from 'viem'
import { DIR } from './notes.js'
import { padNets, NOT_ON_MAINNET, rpcTransport } from './gangpad.js'
import { bondAddress, BOND_ABI } from './bond.js'
import { walletFor } from './fair.js'
import { parseAmount, parseIntIn, step } from './steps.js'
import { buybackBpsOf, FACTORY_ABI, notDeployed, simulateCall, SPLITTER_ABI, splitterFactoryAddress, splitterOf } from './buyback.js'
import { parseSplitSpec, simulateSplit, SPLIT_ABI, SPLIT_FACTORY_ABI, splitFactoryAddress, splitLine, splitNotDeployed, splitOf } from './split.js'
import { LP_ABI, LP_FACTORY_ABI, lpBpsOf, lpFactoryAddress, lpNotDeployed, lpOf, simulateLp } from './lp.js'

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
 * --split <addr>:<pct>[,…] (V3, taxed): the same three steps with GangSplitModuleFactory — the dev's split module (fixed
 * payees and shares, split-v1) is cloned at predict(dev, salt), named as the recipient, then bound. The plan keeps which
 * module it cloned (`module: 'split'`; a plan without it is a --buyback one), and a re-run with other payees or shares is
 * refused rather than starting over.
 * --lp <pct> [--lp-to <addr>] (V3, taxed): the same three steps with GangLiquiditySplitterFactory — the dev's LP splitter
 * (lp-burn-v1: --lp % of the recipient's part added to the pair as liquidity, the LP to 0xdead) is cloned at
 * predict(dev, salt), named as the recipient, then bound (`module: 'lp'` in the plan). A launch keeps the ratio and payee
 * it began with. --buyback, --split, --lp and --recipient are exclusive (each sets the recipient).
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
 * --split takes the same quotes: a quote that calls the receiver back on transfer would let one payee make every split
 * run out of gas, and the keeper splits only these quotes anyway (split spec §2.4).
 * --lp takes the same quotes: the keeper adds liquidity only over these, and an unlisted quote may tax or block the
 * transfers into the pair every chunk makes.
 * null when trusted; otherwise the failure to report.
 */
const UNTRUSTED = {
  buyback: {
    why: '--buyback needs WBNB, GANG or a quote listed in the pad\'s QuoteRegistry: the buy-back splitter cannot buy back with a quote that taxes transfers into the pair, and an unlisted quote may do that',
    hint: 'drop --quote (WBNB), use a listed quote, or launch without --buyback',
  },
  split: {
    why: '--split needs WBNB, GANG or a quote listed in the pad\'s QuoteRegistry: the keeper splits only those quotes, and an unlisted quote may call the receiver back on transfer, letting one payee make every split run out of gas',
    hint: 'drop --quote (WBNB), use a listed quote, or launch without --split',
  },
  lp: {
    why: '--lp needs WBNB, GANG or a quote listed in the pad\'s QuoteRegistry: the keeper adds liquidity only over those quotes, and an unlisted quote may tax or block the transfers into the pair every chunk makes',
    hint: 'drop --quote (WBNB), use a listed quote, or launch without --lp',
  },
}
export async function untrustedBuybackQuote(read, net, quote, mode = 'buyback') {
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
      ? `could not read the pad's QuoteRegistry to check the --${mode} quote: try again`
      : UNTRUSTED[mode].why,
    quote, hint: UNTRUSTED[mode].hint,
  }
}

export const LAUNCH_FLAGS = ['dev-buy', 'bond', 'bond-hold', 'bond-days', 'buyback', 'buyback-to', 'split', 'lp', 'lp-to', 'restart']
const NOTE_FLAGS = ['note', 'conf', 'reveal-after']
/** `gang fair create --dev-buy`, with or without --bond (index.js stops the lone flag, runLaunch the chained one). */
export const FAIR_DEV_BUY = 'a 打新 dev buys its shares in the create itself: use --shares <n> (not --dev-buy)'

/** The run asks for a chained launch (`kind` 'v3' | 'fair'). */
export const isLaunch = (kind, flag) => flag('bond') || flag('buyback') || flag('split') || flag('lp') || (kind === 'v3' && flag('dev-buy'))
/** The recipient modules a launch can clone (their flags), at most one per launch. */
const MODULE_FLAGS = ['buyback', 'split', 'lp']

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
  if (kind === 'fair' && flag('split')) fail('--split is for V3 tokens: it makes the tax recipient a split module, and a 打新 token has no recipient')
  if (kind === 'fair' && flag('lp')) fail('--lp is for V3 tokens: it makes the tax recipient an LP splitter, and a 打新 token has no recipient')
  if (flag('split') && flag('buyback')) fail('give --split or --buyback, not both: each makes the tax recipient its own module (a split with a buy-back is not supported)')
  const mods = MODULE_FLAGS.filter((f) => flag(f))
  if (mods.length > 1) fail(`give one of --${mods.join(' / --')}, not several: each makes the tax recipient its own module`)

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

  const me = walletFor({ chainId: net.chainId }, opt('from'))

  // --split: a taxed V3 token whose recipient is the dev's split module (fixed payees and shares)
  let split = null
  if (flag('split')) {
    const zero = (f) => /^0+(\.0+)?$/.test(opt(f) ?? '')
    if (!flag('buy-tax') || !flag('sell-tax') || (zero('buy-tax') && zero('sell-tax'))) {
      fail('--split needs a taxed token: add --buy-tax and --sell-tax (each 1–5, in %); the split is paid from the tax')
    }
    if (flag('recipient')) fail('--split makes the recipient your split module: leave --recipient out')
    if (/^0*100(\.0+)?$/.test(opt('dividend', '0'))) fail('--dividend 100 leaves nothing for the recipient, so nothing to split: lower it or drop --split')
    const factory = splitFactoryAddress(testnet)
    if (!factory) fail(splitNotDeployed(testnet))
    const spec = parseSplitSpec(opt('split'), me)
    if (spec.error) {
      const { error, ...extra } = spec
      fail(error, extra)
    }
    split = { ...spec, factory }
  }

  // --lp: a taxed V3 token whose recipient is the dev's LP splitter (auto-liquidity, the LP to 0xdead)
  let lp = null
  if (flag('lp-to') && !flag('lp')) fail('--lp-to <addr> goes with --lp <pct>: it names where the part not added to the pool goes')
  if (flag('lp')) {
    const zero = (f) => /^0+(\.0+)?$/.test(opt(f) ?? '')
    if (!flag('buy-tax') || !flag('sell-tax') || (zero('buy-tax') && zero('sell-tax'))) {
      fail('--lp needs a taxed token: add --buy-tax and --sell-tax (each 1–5, in %); the liquidity is paid from the tax')
    }
    if (flag('recipient')) fail('--lp makes the recipient your LP splitter: leave --recipient out')
    if (/^0*100(\.0+)?$/.test(opt('dividend', '0'))) fail('--dividend 100 leaves nothing for the recipient, so nothing to add to the pool: lower it or drop --lp')
    const factory = lpFactoryAddress(testnet)
    if (!factory) fail(lpNotDeployed(testnet))
    let payee = null
    if (flag('lp-to')) {
      payee = opt('lp-to')
      if (!isAddress(payee ?? '') || payee === zeroAddress) fail('--lp-to must be a 0x address, checksummed or all lowercase (where the part not added to the pool goes; leave it out for your own wallet)', { got: payee ?? null })
    }
    lp = { bps: lpBpsOf(fail, opt('lp')), factory, payee }
  }
  const mod = buyback ? 'buyback' : split ? 'split' : lp ? 'lp' : null

  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args })
  const key = [net.chainId, net.pad, me.toLowerCase(), kind, name, symbol].join('|')
  const cloneStep = buyback ? 'buyback-splitter' : split ? 'split-module' : 'lp-splitter'
  const steps = [...(mod ? [cloneStep] : []), kind === 'v3' ? 'create' : 'create (dev shares included)', ...(mod ? ['bind'] : []),
    ...(devBuy ? ['dev-buy'] : []), ...(bond ? ['bond'] : [])]
  const rerun = 're-run this same command after executing it'
  const tag = (stage, extra = {}) => ({ launch: { stage, steps, ...extra } })
  const withTag = (stage, extra) => (o) => out({ ...o, ...tag(stage, extra) })

  let plan = flag('restart') ? null : readPlan(key)
  const base = { kind, name, symbol, me, chainId: net.chainId, pad: net.pad }

  // ---- a launch keeps the mode it began with (the create, once built, is never redone by a changed flag)
  const created = plan?.startCount !== undefined
  // the module this plan cloned: 'split' / 'lp' when it says so, else a --buyback splitter (plans from before --split)
  const planMod = plan?.salt ? (plan.module === 'split' || plan.module === 'lp' ? plan.module : 'buyback') : null
  const modNoun = { buyback: 'splitter', split: 'split module', lp: 'LP splitter' }
  if (mod && created && !plan.splitter) {
    return fail(`this launch was created without --${mod} (its recipient is fixed): run it again without --${mod}, or add --restart for a new token`)
  }
  if (planMod && mod !== planMod && (!created || mod)) {
    return fail(`this launch began with --${planMod} (its ${modNoun[planMod]} is cloned or on the way): run it again with --${planMod}${mod ? ` instead of --${mod}` : ''}, or add --restart${mod ? '' : ` without it`}`)
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

  // ---- split module: cloned for the dev before the create, at predict(dev, plan.salt)
  if (split && !created) {
    if (!plan?.salt) {
      const refused = await untrustedBuybackQuote(read, net, flag('quote') ? opt('quote') : net.wbnb, 'split')
      if (refused) {
        const { error, ...extra } = refused
        return fail(error, extra)
      }
      const salt = `0x${randomBytes(32).toString('hex')}`
      const at = await read(split.factory, SPLIT_FACTORY_ABI, 'predict', [me, salt])
      if (split.payees.some((p) => p.toLowerCase() === at.toLowerCase())) return fail('--split: a payee cannot be the split module itself', { module: at })
      const args = [split.payees, split.shares, salt]
      const sim = await simulateSplit(client, me, split.factory, SPLIT_FACTORY_ABI, 'create', args)
      if (sim.failed) return out({ success: false, step: 'split-module', factory: split.factory, ...tag('split-module'), ...sim.failed })
      writePlan(key, { ...base, salt, splitter: at, factory: split.factory, module: 'split' })
      const data = encodeFunctionData({ abi: SPLIT_FACTORY_ABI, functionName: 'create', args })
      return out({
        ...step({ chainId: net.chainId }, { from: me, to: split.factory, data }, {
          step: 'split-module', chainId: Number(net.chainId), factory: split.factory, module: at, payees: split.list,
          note: `clones your split module (listed as a tax recipient in the same tx). The recipient's part of the tax is split ${splitLine(split.payees, split.shares)}. PERMANENT: nobody (not you, not the platform) can change the payees or shares later; each payee can only move its own slot to another address (gang split set-payee). The first payee also takes the rounding dust`,
        }, flag('calldata'), io.summarize),
        ...tag('split-module', { module: at, next: `${rerun}: it then builds the create with the module as the recipient` }),
      })
    }
    if ((await client.getCode({ address: plan.splitter }) ?? '0x') === '0x') {
      return out({
        success: false, ...tag('split-module', { module: plan.splitter }), error: 'the split module is not on chain yet',
        hint: `if the clone was executed, wait for it to land and ${rerun.replace(' after executing it', '')}; if it was not, add --restart to build it again`,
      })
    }
    const s = await splitOf(read, plan.splitter, { wbnb: net.wbnb })
    if (!s || s.dev.toLowerCase() !== me.toLowerCase() || s.token) {
      return fail('the module at this launch\'s address is not an unbound split module of this wallet: add --restart', { module: plan.splitter })
    }
    const same = s.payees.length === split.payees.length
      && s.payees.every((p, i) => p.payee.toLowerCase() === split.payees[i].toLowerCase() && p.bps === split.shares[i])
    if (!same) {
      return fail(`this launch's split module pays ${splitLine(s.payees.map((p) => p.payee), s.payees.map((p) => p.bps))}, not what --split says: run it again with that --split, or add --restart for a new module (the payees and shares can never change after the clone)`, { module: plan.splitter })
    }
  }

  // ---- LP splitter: cloned for the dev before the create, at predict(dev, plan.salt)
  if (lp && !created) {
    if (!plan?.salt) {
      const refused = await untrustedBuybackQuote(read, net, flag('quote') ? opt('quote') : net.wbnb, 'lp')
      if (refused) {
        const { error, ...extra } = refused
        return fail(error, extra)
      }
      if ((await client.getCode({ address: lp.factory }) ?? '0x') === '0x') {
        return fail(`GangLiquiditySplitterFactory has no code at ${lp.factory} on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} yet: launch without --lp for now${process.env[testnet ? 'GANG_TESTNET_LP_FACTORY' : 'GANG_LP_FACTORY'] ? ` (or fix ${testnet ? 'GANG_TESTNET_LP_FACTORY' : 'GANG_LP_FACTORY'})` : ''}`, { factory: lp.factory })
      }
      const salt = `0x${randomBytes(32).toString('hex')}`
      const at = await read(lp.factory, LP_FACTORY_ABI, 'predict', [me, salt])
      if (lp.payee && lp.payee.toLowerCase() === at.toLowerCase()) return fail('--lp-to: the payee cannot be the LP splitter itself', { splitter: at })
      const args = [lp.bps, salt, lp.payee ?? zeroAddress]
      const sim = await simulateLp(client, me, lp.factory, LP_FACTORY_ABI, 'create', args)
      if (sim.failed) return out({ success: false, step: 'lp-splitter', factory: lp.factory, ...tag('lp-splitter'), ...sim.failed })
      writePlan(key, { ...base, salt, splitter: at, factory: lp.factory, module: 'lp' })
      const data = encodeFunctionData({ abi: LP_FACTORY_ABI, functionName: 'create', args })
      return out({
        ...step({ chainId: net.chainId }, { from: me, to: lp.factory, data }, {
          step: 'lp-splitter', chainId: Number(net.chainId), factory: lp.factory, lpPct: lp.bps / 100,
          splitter: at, payee: lp.payee ?? me,
          note: `clones your LP splitter (listed as a tax recipient in the same tx): ${lp.bps / 100}% of the recipient's part is added to the token's PancakeSwap pair as liquidity, the LP sent to 0xdead (locked for good), the rest goes to ${lp.payee ? `${lp.payee} (--lp-to)` : 'you'}. After graduation the keeper adds it in chunks. Later a raise applies at once, a cut only after a 3-day notice; the payee can be changed at once (gang lp set-payee)`,
        }, flag('calldata'), io.summarize),
        ...tag('lp-splitter', { splitter: at, next: `${rerun}: it then builds the create with the LP splitter as the recipient` }),
      })
    }
    if ((await client.getCode({ address: plan.splitter }) ?? '0x') === '0x') {
      return out({
        success: false, ...tag('lp-splitter', { splitter: plan.splitter }), error: 'the LP splitter is not on chain yet',
        hint: `if the clone was executed, wait for it to land and ${rerun.replace(' after executing it', '')}; if it was not, add --restart to build it again`,
      })
    }
    const s = await lpOf(read, plan.splitter)
    if (!s || s.dev.toLowerCase() !== me.toLowerCase() || s.token) {
      return fail('the LP splitter at this launch\'s address is not an unbound LP splitter of this wallet: add --restart', { splitter: plan.splitter })
    }
    if (s.lpBps !== lp.bps) {
      return fail(`this launch's LP splitter adds ${s.lpPct}% to the pool, not ${lp.bps / 100}%: run it again with --lp ${s.lpPct}, or add --restart for a new splitter (gang lp set changes it after the create)`, { splitter: plan.splitter })
    }
    const wantPayee = (lp.payee ?? me).toLowerCase()
    if (s.payee.toLowerCase() !== wantPayee) {
      const was = s.payee.toLowerCase() === me.toLowerCase() ? 'leave --lp-to out' : `--lp-to ${s.payee}`
      return fail(`this launch's LP splitter pays ${s.payee}, not ${lp.payee ?? me}: run it again with ${was}, or add --restart for a new splitter (gang lp set-payee changes it after the create)`, { splitter: plan.splitter })
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
        if (built) writePlan(key, { ...base, ...(plan?.splitter && { salt: plan.salt, splitter: plan.splitter, factory: plan.factory, ...(plan.module && { module: plan.module }) }), startCount })
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
  const isSplit = plan.module === 'split'
  const isLp = plan.module === 'lp'
  const buybackState = () => (plan.splitter && !isSplit && !isLp ? splitterOf(read, plan.splitter) : null)
  const lpState = () => (plan.splitter && isLp ? lpOf(read, plan.splitter, { pad: net.pad }) : null)
  const splitState = () => (plan.splitter && isSplit ? splitOf(read, plan.splitter, { wbnb: net.wbnb, ref: `--token ${token}${testnet ? ' --testnet' : ''}` }) : null)

  // ---- done: the report only, whatever happened to the balance or the bond since
  const report = async () => {
    const done = {
      success: true, ...tag('done', { token, again: 'this launch is done; running the command again only reports it. Another token with the same name / symbol: add --restart' }),
      token, name, symbol, devBalance: formatUnits(bal, 18), chainId: Number(net.chainId),
    }
    const bb = await buybackState()
    if (bb) done.buyback = bb
    const sp = await splitState()
    if (sp) done.split = sp
    const lps = await lpState()
    if (lps) done.lp = lps
    if (!bond) return out({ ...done, note: `launched: gang ${kind} info --token ${token}${testnet ? ' --testnet' : ''}` })
    return runBond('status', { ...stepIo({}), out: (o) => out({ ...done, bondStatus: o, note: `launched and bonded: gang bond status --token ${token}${testnet ? ' --testnet' : ''}` }) })
  }
  if (plan.done) return report()

  // ---- bind the splitter / split module / LP splitter to the token (anyone may; the launch does it right after the create)
  if (plan.splitter) {
    const abi = isSplit ? SPLIT_ABI : isLp ? LP_ABI : SPLITTER_ABI
    const bound = await read(plan.splitter, abi, 'token')
    if (bound === zeroAddress) {
      const sim = await (isSplit ? simulateSplit : isLp ? simulateLp : simulateCall)(client, me, plan.splitter, abi, 'bind', [token])
      if (sim.failed) return out({ success: false, step: 'bind', ...tag('bind', { token }), ...sim.failed })
      const data = encodeFunctionData({ abi, functionName: 'bind', args: [token] })
      return out({
        ...step({ chainId: net.chainId }, { from: me, to: plan.splitter, data }, {
          step: 'bind', chainId: Number(net.chainId), token, ...(isSplit ? { module: plan.splitter } : { splitter: plan.splitter }),
          note: isSplit
            ? 'ties the split module to this token for good: the keeper then splits its quote among the payees'
            : isLp
              ? 'ties the LP splitter to this token for good: its pair is where the liquidity goes (from graduation on)'
              : 'ties the splitter to this token for good (what it buys back and burns)',
        }, flag('calldata'), io.summarize),
        ...tag('bind', { token, next: `${rerun}${devBuy ? ': it continues with the dev buy' : bond ? ': it continues with the bond' : ': the launch is then done'}` }),
      })
    }
    if (bound.toLowerCase() !== token.toLowerCase()) {
      return out({ success: false, ...tag('bind', { token }), error: `the ${isSplit ? 'split module' : isLp ? 'LP splitter' : 'splitter'} is bound to another token`, [isSplit ? 'module' : 'splitter']: plan.splitter, boundTo: bound })
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
