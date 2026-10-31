import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPublicClient, parseAbi, formatUnits, encodeFunctionData, isAddress, zeroAddress } from 'viem'
import { DIR } from './notes.js'
import { creatorFeeShareOf, gradTiersOf, padNets, NOT_ON_MAINNET, rpcTransport } from './gangpad.js'
import { bondAddress, BOND_ABI } from './bond.js'
import { walletFor } from './fair.js'
import { parseAmount, parseIntIn, step } from './steps.js'
import { buybackBpsOf, FACTORY_ABI, notDeployed, simulateCall, SPLITTER_ABI, splitterFactoryAddress, splitterOf } from './buyback.js'
import { parseSplitSpec, simulateSplit, SPLIT_ABI, SPLIT_FACTORY_ABI, splitFactoryAddress, splitLine, splitNotDeployed, splitOf } from './split.js'
import { LP_ABI, LP_FACTORY_ABI, lpBpsOf, lpFactoryAddress, lpNotDeployed, lpOf, simulateLp } from './lp.js'
import { claimCmd, notThroughModule } from './creatorfee.js'
import { COMBO_ABI, COMBO_FACTORY_ABI, comboFactoryAddress, comboLine, comboNotDeployed, comboOf, comboParts, parseComboSpec, PERMANENT_NOTE, simulateCombo } from './combo.js'

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
 * it began with. --recipient goes with none of them (each sets the recipient).
 * More than one of --buyback, --lp, --split (taxed V3): the same three steps with GangComboSplitterFactory — the dev's
 * combined recipient (combo-v1: --buyback % of the recipient's part bought back and burned, --lp % added as liquidity, the
 * rest pushed to the --split payees, or to the dev alone without --split) is cloned at predict(dev, salt), named as the
 * recipient, then bound (`module: 'combo'`). Everything in it is fixed for good, so a re-run with other ratios or payees
 * is refused rather than starting over. --buyback-to / --lp-to don't apply (the payees are --split's).
 */

// the dev's recipient modules by flag, as the creator-fee note names them
const MODULE_NAMES = { buyback: 'buy-back splitter', split: 'split module', lp: 'LP splitter', combo: 'combined recipient' }
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
 * transfers into the pair every chunk makes. A combined recipient (several of them) takes the same quotes for all reasons.
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
  combo: {
    why: 'a combined recipient (more than one of --buyback / --lp / --split) needs WBNB, GANG or a quote listed in the pad\'s QuoteRegistry: its buy-backs and liquidity adds price on what the pair receives (a quote that taxes transfers into the pair fails every chunk), the keeper serves only those quotes, and an unlisted quote may call a payee back on transfer',
    hint: 'drop --quote (WBNB), use a listed quote, or launch without --buyback / --lp / --split',
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
/** The recipient modules a launch can clone (their flags): one alone clones its own module, several a combined one. */
const MODULE_FLAGS = ['buyback', 'split', 'lp']
/** How a module's flags read in a message. */
const MOD_FLAG = { buyback: '--buyback', split: '--split', lp: '--lp', combo: 'more than one of --buyback / --lp / --split' }

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
  const mods = MODULE_FLAGS.filter((f) => flag(f))
  // more than one: one combined recipient (GangComboSplitter) does them all
  const combo = mods.length > 1

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

  // several of --buyback / --lp / --split: a taxed V3 token whose recipient is the dev's combined recipient
  let comboFactory = null
  if (combo) {
    const names = mods.map((f) => `--${f}`).join(' + ')
    comboFactory = comboFactoryAddress(testnet)
    if (!comboFactory) fail(comboNotDeployed(testnet), { flags: mods.map((f) => `--${f}`) })
    for (const to of ['buyback-to', 'lp-to']) {
      if (flag(to)) fail(`--${to} does not apply to a combined recipient (${names}): the part not bought back or added goes to the payees — name them with --split self:<pct>,<addr>:<pct>,… (shares of that rest; without --split it all goes to you)`)
    }
    const zero = (f) => /^0+(\.0+)?$/.test(opt(f) ?? '')
    if (!flag('buy-tax') || !flag('sell-tax') || (zero('buy-tax') && zero('sell-tax'))) {
      fail(`${names} needs a taxed token: add --buy-tax and --sell-tax (each 1–5, in %); the combined recipient is paid from the tax`)
    }
    if (flag('recipient')) fail(`${names} makes the recipient your combined recipient: leave --recipient out`)
    if (/^0*100(\.0+)?$/.test(opt('dividend', '0'))) fail(`--dividend 100 leaves nothing for the recipient: lower it or drop ${names}`)
  }

  // --buyback: a taxed V3 token whose recipient (the part left after holders) is the dev's splitter
  let buyback = null
  if (flag('buyback-to') && !flag('buyback')) fail('--buyback-to <addr> goes with --buyback <pct>: it names where the part not bought back goes')
  if (flag('buyback') && !combo) {
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

  // the combined recipient's ratios and payees (shares of the rest), checked as its initialize checks them
  let comboSpec = null
  if (combo) {
    const spec = parseComboSpec({
      buybackBps: flag('buyback') ? buybackBpsOf(fail, opt('buyback')) : 0,
      lpBps: flag('lp') ? lpBpsOf(fail, opt('lp')) : 0,
      split: flag('split') ? (opt('split') ?? '') : undefined,
    }, me)
    if (spec.error) {
      const { error, ...extra } = spec
      fail(error, extra)
    }
    comboSpec = { ...spec, factory: comboFactory }
  }

  // --split: a taxed V3 token whose recipient is the dev's split module (fixed payees and shares)
  let split = null
  if (flag('split') && !combo) {
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
  if (flag('lp') && !combo) {
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
  const mod = comboSpec ? 'combo' : buyback ? 'buyback' : split ? 'split' : lp ? 'lp' : null

  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args })
  // --grad (2.0): checked here, before a module clone, since the create that takes it comes later
  if (kind === 'v3' && flag('grad')) {
    const tiers = await gradTiersOf({ chainId: net.chainId, pad: net.pad, read })
    if (!tiers) fail(`--grad: GangLaunchpad ${net.gen ?? net.pad} has no graduation target to pick: leave --grad out`)
    if (!tiers.includes(Number(opt('grad')))) fail(`--grad must be one of ${tiers.join(' / ')} (BNB raised)`, { got: opt('grad') ?? null })
  }
  const key = [net.chainId, net.pad, me.toLowerCase(), kind, name, symbol].join('|')
  const cloneStep = { buyback: 'buyback-splitter', split: 'split-module', lp: 'lp-splitter', combo: 'combo-module' }[mod]
  const steps = [...(mod ? [cloneStep] : []), kind === 'v3' ? 'create' : 'create (dev shares included)', ...(mod ? ['bind'] : []),
    ...(devBuy ? ['dev-buy'] : []), ...(bond ? ['bond'] : [])]
  const rerun = 're-run this same command after executing it'
  const tag = (stage, extra = {}) => ({ launch: { stage, steps, ...extra } })
  const withTag = (stage, extra) => (o) => out({ ...o, ...tag(stage, extra) })

  let plan = flag('restart') ? null : readPlan(key)
  // a launch begun on another generation's pad (an older CLI) and not done: its module and token belong to that pad, so
  // it is never carried on here, nor started again without --restart
  if (!plan && !flag('restart')) {
    const old = net.gens.slice(1).map((g) => ({ g, p: readPlan([net.chainId, g.pad, me.toLowerCase(), kind, name, symbol].join('|')) })).find((x) => x.p && !x.p.done)
    if (old) {
      const tn = testnet ? ' --testnet' : ''
      // two pads of one generation (testnet: 2.0 before and after the graduation pick) are told apart by address
      const same = old.g.gen === net.gen
      const lbl = (g) => (same ? `${g.gen ?? ''} pad ${g.pad}`.trim() : g.gen ?? g.pad)
      const [was, now] = [lbl(old.g), lbl(net)]
      return fail(`this launch began on GangLaunchpad ${was} and is not done; new tokens now go to ${now}`, {
        ...(old.p.token ? { token: old.p.token, hint: `the token is out on ${was}: finish its steps one by one (gang buy --token ${old.p.token} --amount <quote>${tn}, gang bond post --token ${old.p.token} …${tn}), or add --restart to launch a new token on ${now}` }
          : { hint: `${old.p.splitter ? `its module ${old.p.splitter} was made for the ${was} pad and does not work with ${now}: ` : ''}add --restart to launch on ${now}` }),
      })
    }
  }
  const base = { kind, name, symbol, me, chainId: net.chainId, pad: net.pad }

  // ---- a launch keeps the mode it began with (the create, once built, is never redone by a changed flag)
  const created = plan?.startCount !== undefined
  // the module this plan cloned: 'split' / 'lp' / 'combo' when it says so, else a --buyback splitter (plans from before --split)
  const planMod = plan?.salt ? (['split', 'lp', 'combo'].includes(plan.module) ? plan.module : 'buyback') : null
  const modNoun = { buyback: 'splitter', split: 'split module', lp: 'LP splitter', combo: 'combined recipient' }
  if (mod && created && !plan.splitter) {
    return fail(`this launch was created without ${MOD_FLAG[mod]} (its recipient is fixed): run it again without ${mod === 'combo' ? '--buyback / --lp / --split' : MOD_FLAG[mod]}, or add --restart for a new token`)
  }
  if (planMod && mod !== planMod && (!created || mod)) {
    const again = planMod === 'combo' ? 'the same --buyback / --lp / --split as before' : MOD_FLAG[planMod]
    return fail(`this launch began with ${MOD_FLAG[planMod]} (its ${modNoun[planMod]} is cloned or on the way): run it again with ${again}${mod ? ` instead of ${MOD_FLAG[mod]}` : ''}, or add --restart${mod ? '' : ' without it'}`)
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

  // ---- combined recipient: cloned for the dev before the create, at predict(dev, plan.salt)
  if (comboSpec && !created) {
    if (!plan?.salt) {
      const refused = await untrustedBuybackQuote(read, net, flag('quote') ? opt('quote') : net.wbnb, 'combo')
      if (refused) {
        const { error, ...extra } = refused
        return fail(error, extra)
      }
      if ((await client.getCode({ address: comboSpec.factory }) ?? '0x') === '0x') {
        const env = testnet ? 'GANG_TESTNET_COMBO_FACTORY' : 'GANG_COMBO_FACTORY'
        return fail(`GangComboSplitterFactory has no code at ${comboSpec.factory} on ${testnet ? 'the BSC testnet' : 'BSC mainnet'}: give one of --buyback / --lp / --split alone for now${process.env[env] ? ` (or fix ${env})` : ''}`, { factory: comboSpec.factory })
      }
      const salt = `0x${randomBytes(32).toString('hex')}`
      const at = await read(comboSpec.factory, COMBO_FACTORY_ABI, 'predict', [me, salt])
      if (comboSpec.payees.some((p) => p.toLowerCase() === at.toLowerCase())) return fail('--split: a payee cannot be the combined recipient itself', { module: at })
      const args = [comboSpec.buybackBps, comboSpec.lpBps, comboSpec.payees, comboSpec.shares, salt]
      const sim = await simulateCombo(client, me, comboSpec.factory, COMBO_FACTORY_ABI, 'create', args)
      if (sim.failed) return out({ success: false, step: 'combo-module', factory: comboSpec.factory, ...tag('combo-module'), ...sim.failed })
      writePlan(key, { ...base, salt, splitter: at, factory: comboSpec.factory, module: 'combo' })
      const data = encodeFunctionData({ abi: COMBO_FACTORY_ABI, functionName: 'create', args })
      const parts = comboParts(comboSpec.buybackBps, comboSpec.lpBps, comboSpec.payees.length)
      return out({
        ...step({ chainId: net.chainId }, { from: me, to: comboSpec.factory, data }, {
          step: 'combo-module', chainId: Number(net.chainId), factory: comboSpec.factory, module: at,
          buybackPct: comboSpec.buybackBps / 100, lpPct: comboSpec.lpBps / 100, payeesPct: (10_000 - comboSpec.buybackBps - comboSpec.lpBps) / 100,
          payees: comboSpec.list, permanent: true, parts,
          note: `clones your combined recipient (combo-v1, listed as a tax recipient in the same tx). Of the recipient's part of the tax: ${comboLine(comboSpec.buybackBps, comboSpec.lpBps, comboSpec.payees, comboSpec.shares)}. ${PERMANENT_NOTE}. ${parts.otherAssets[0].toUpperCase()}${parts.otherAssets.slice(1)}`,
        }, flag('calldata'), io.summarize),
        ...tag('combo-module', { module: at, next: `${rerun}: it then builds the create with the combined recipient as the recipient` }),
      })
    }
    if ((await client.getCode({ address: plan.splitter }) ?? '0x') === '0x') {
      return out({
        success: false, ...tag('combo-module', { module: plan.splitter }), error: 'the combined recipient is not on chain yet',
        hint: `if the clone was executed, wait for it to land and ${rerun.replace(' after executing it', '')}; if it was not, add --restart to build it again`,
      })
    }
    const s = await comboOf(read, plan.splitter, { wbnb: net.wbnb })
    if (!s || s.dev.toLowerCase() !== me.toLowerCase() || s.token) {
      return fail('the module at this launch\'s address is not an unbound combined recipient of this wallet: add --restart', { module: plan.splitter })
    }
    const same = s.buybackBps === comboSpec.buybackBps && s.lpBps === comboSpec.lpBps && s.payees.length === comboSpec.payees.length
      && s.payees.every((p, i) => p.payee.toLowerCase() === comboSpec.payees[i].toLowerCase() && p.bps === comboSpec.shares[i])
    if (!same) {
      return fail(`this launch's combined recipient is ${comboLine(s.buybackBps, s.lpBps, s.payees.map((p) => p.payee), s.payees.map((p) => p.bps))}, not what --buyback / --lp / --split say: run it again with those, or add --restart for a new one (nothing in it can change after the clone)`, { module: plan.splitter })
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
          // 2.0: the creator fee is the dev's own, not the module's
          ...(o.creatorFee && mod && { creatorFee: `${o.creatorFee} ${notThroughModule(MODULE_NAMES[mod], { at: plan?.splitter, net: testnet ? ' --testnet' : '', kind: mod })}` }),
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
  const isCombo = plan.module === 'combo'
  const buybackState = () => (plan.splitter && !isSplit && !isLp && !isCombo ? splitterOf(read, plan.splitter) : null)
  const comboState = () => (plan.splitter && isCombo ? comboOf(read, plan.splitter, { wbnb: net.wbnb, pad: net.pad, ref: `--token ${token}${testnet ? ' --testnet' : ''}` }) : null)
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
    const cs = await comboState()
    if (cs) done.combo = cs
    // 2.0: where the creator fee of a V3 token is claimed (and that a module does not get it)
    const share = kind === 'v3' ? await creatorFeeShareOf({ chainId: net.chainId, pad: net.pad, read }).catch(() => null) : null
    if (share != null) {
      done.creatorFee = `${share / 100}% of the 1% curve fee is kept for you, the creator: ${claimCmd(token, testnet ? ' --testnet' : '')}${plan.splitter ? `. ${notThroughModule(MODULE_NAMES[planMod], { token, at: plan.splitter, net: testnet ? ' --testnet' : '', kind: planMod })}` : ''}`
    }
    if (!bond) return out({ ...done, note: `launched: gang ${kind} info --token ${token}${testnet ? ' --testnet' : ''}` })
    return runBond('status', { ...stepIo({}), out: (o) => out({ ...done, bondStatus: o, note: `launched and bonded: gang bond status --token ${token}${testnet ? ' --testnet' : ''}` }) })
  }
  if (plan.done) return report()

  // ---- bind the splitter / split module / LP splitter / combined recipient to the token (anyone may; the launch does it right after the create)
  if (plan.splitter) {
    const abi = isCombo ? COMBO_ABI : isSplit ? SPLIT_ABI : isLp ? LP_ABI : SPLITTER_ABI
    const bound = await read(plan.splitter, abi, 'token')
    if (bound === zeroAddress) {
      const sim = await (isCombo ? simulateCombo : isSplit ? simulateSplit : isLp ? simulateLp : simulateCall)(client, me, plan.splitter, abi, 'bind', [token])
      if (sim.failed) return out({ success: false, step: 'bind', ...tag('bind', { token }), ...sim.failed })
      const data = encodeFunctionData({ abi, functionName: 'bind', args: [token] })
      return out({
        ...step({ chainId: net.chainId }, { from: me, to: plan.splitter, data }, {
          step: 'bind', chainId: Number(net.chainId), token, ...(isSplit || isCombo ? { module: plan.splitter } : { splitter: plan.splitter }),
          note: isCombo
            ? 'ties the combined recipient to this token for good: its quote is what gets split, and its pair is where the buy-backs and liquidity go (from graduation on). Nothing is split before this'
            : isSplit
            ? 'ties the split module to this token for good: the keeper then splits its quote among the payees'
            : isLp
              ? 'ties the LP splitter to this token for good: its pair is where the liquidity goes (from graduation on)'
              : 'ties the splitter to this token for good (what it buys back and burns)',
        }, flag('calldata'), io.summarize),
        ...tag('bind', { token, next: `${rerun}${devBuy ? ': it continues with the dev buy' : bond ? ': it continues with the bond' : ': the launch is then done'}` }),
      })
    }
    if (bound.toLowerCase() !== token.toLowerCase()) {
      return out({ success: false, ...tag('bind', { token }), error: `the ${isCombo ? 'combined recipient' : isSplit ? 'split module' : isLp ? 'LP splitter' : 'splitter'} is bound to another token`, [isSplit || isCombo ? 'module' : 'splitter']: plan.splitter, boundTo: bound })
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
