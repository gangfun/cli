import { createPublicClient, encodeFunctionData, formatUnits, getAddress, hexToString, isAddress, parseAbi, parseUnits, zeroAddress } from 'viem'
import { walletFor } from './fair.js'
import { atTokenPad, gangGens, KIND_UNREAD, NOT_ON_MAINNET, padNets, rpcTransport, gangSwapTakesNone } from './gangpad.js'
import { decimalsOf, fundingStep, GAS_RESERVE, revertOf as revertIn, routerDeadline, step } from './steps.js'

/**
 * 倒计时奖励, the countdown reward (GangCountdownReward, `countdown-v1`; docs/SPEC-COUNTDOWN-REWARD-2026-11-17.md): one
 * V3 token's tax recipient that turns the recipient's part of the pool tax (the dev's own share) into a reward pool for
 * the token's buyers, and that is also the buy entry that counts. A buy through the module (`buy` with BNB on a
 * WBNB-quoted token, `buyWithQuote` otherwise; after graduation only, on the token's own pair) of at least `minBuy` is
 * counted: it puts the round's deadline `window` ahead, never past the round's cap (its first counted buy + `maxRound`).
 * Once the deadline passes, the round's last `entries` counted buys share min(pool × payoutBps, maxPayout): an equal
 * share each, the newest `lastBps` of it on top (a round that ended at its cap: equal shares, no extra). Buys through
 * PancakeSwap's router, an aggregator or GangRouter never count. A reward paid by fixed public rules from the dev's tax
 * share: buyers buy the token at the pool price and pay the usual buy tax, nothing extra.
 * The token is fixed when the module is cloned (`rewardToken`, its CREATE2 address before it exists), as the floor
 * module's: a launch computes the token's address first, clones the module for it, creates the token at that address,
 * then binds (launch.js). A module is a countdown module only when GangCountdownRewardFactory listed it
 * (GangHandlerAdmin.moduleOf), as for the floor module: a contract that merely answers `countdown-v1` is not one.
 * Env: GANG_COUNTDOWN_FACTORY / GANG_TESTNET_COUNTDOWN_FACTORY (gangpad.js).
 */

export const COUNTDOWN_TYPE = 'countdown-v1'
const BPS = 10_000
const MIN = 60, HOUR = 3600, DAY = 86_400
export const BOUNDS = {
  window: [30 * MIN, 24 * HOUR], maxRound: [HOUR, 24 * HOUR], idle: [7 * DAY, 90 * DAY],
  payoutBps: [1_000, 5_000], lastBps: [0, 2_000], devBps: [0, 5_000], entries: [1, 20],
}
/** The user's defaults (2026-11-17): minBuy / minPot in BNB, for a WBNB-quoted token only. */
export const DEFAULTS = { window: 60 * MIN, maxRound: 6 * HOUR, idle: 30 * DAY, payoutBps: 3_000, lastBps: 2_000, devBps: 0, entries: 10, minBuy: '0.05', minPot: '0.1' }

const CFG = '(uint64 window, uint64 maxRound, uint64 idle, uint16 payoutBps, uint16 lastBps, uint16 devBps, uint8 entries, uint256 minBuy, uint256 minPot, uint256 maxPayout)'
const ERRORS = [
  'error ZeroAddress()', 'error NotClone()', 'error NotFactory()', 'error AlreadyInitialized()', 'error BadQuote()',
  'error BadConfig()', 'error AlreadyBound()', 'error NotBound()', 'error WrongToken()', 'error NotCurve()',
  'error NotCreator()', 'error WrongQuote()', 'error NothingForRecipient()', 'error NotRecipient()', 'error NotTradable()',
  'error NotWbnb()', 'error Expired()', 'error ZeroAmount()', 'error Slippage()', 'error NothingToClaim()', 'error NotDue()',
  'error NotCounted()',
]
export const COUNTDOWN_FACTORY_ABI = parseAbi([
  `function create(address token, address quote, ${CFG} config, bytes32 salt) returns (address module)`,
  'function predict(address dev, bytes32 salt) view returns (address)',
  'function pad() view returns (address)',
  'function admin() view returns (address)',
  'function implementation() view returns (address)',
  'function vanityEnabled() view returns (bool)',
  'error NotAgent()', 'error WrongHandler()', 'error NoVanityDeployer()', 'error BadToken()',
  `event Created(address indexed dev, address indexed module, address indexed token, address quote, ${CFG} config)`,
  ...ERRORS,
])
export const COUNTDOWN_ABI = parseAbi([
  'function moduleType() view returns (bytes32)',
  'function pad() view returns (address)',
  'function factory() view returns (address)',
  `function config() view returns (${CFG})`,
  'function dev() view returns (address)',
  'function rewardToken() view returns (address)',
  'function rewardQuote() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function pot() view returns (uint256)',
  'function potAvailable() view returns (uint256)',
  'function reservedTotal() view returns (uint256)',
  'function claimTotal() view returns (uint256)',
  'function devOwed() view returns (uint256)',
  'function claimableOf(address) view returns (uint256)',
  'function cur() view returns (uint8)',
  'function deadline() view returns (uint64)',
  'function lastRoundId() view returns (uint64)',
  'function lastCountedAt() view returns (uint64)',
  'function lastFinalizedAt() view returns (uint64)',
  'function currentRound() view returns (uint64)',
  'function roundEndsBy() view returns (uint64)',
  'function round(uint8 b) view returns (uint64 id, uint32 count, bool frozen, bool settled, uint256 reserved, (address buyer, uint96 tokens)[] list)',
  'function wouldCount(uint256 quoteIn) view returns (bool)',
  'function previewWork() view returns (bool due, uint256 minOut)',
  'function keeperServes(address q) view returns (bool)',
  'function buy(uint256 minTokensOut, uint256 deadline, bool mustCount) payable returns (uint256 tokensOut)',
  'function buyWithQuote(uint256 quoteIn, uint256 minTokensOut, uint256 deadline, bool mustCount) returns (uint256 tokensOut)',
  'function claim(address to) returns (uint256 amount)',
  'function fund(uint256 amount)',
  'function bind(address token)',
  'function settle()',
  'function finalize()',
  'function claimDev() returns (uint256 amount)',
  'function work(uint256)',
  'function distribute(address asset) returns (uint256 amount)',
  'event Bound(address indexed token, address indexed quote)',
  'event Funded(address indexed from, uint256 amount)',
  'event TaxBooked(uint256 incoming, uint256 toPot, uint256 toDev)',
  'event Shortfall(uint256 amount)',
  'event RoundStarted(uint64 indexed round)',
  'event Counted(uint64 indexed round, address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint64 deadline)',
  'event RoundFrozen(uint64 indexed round, uint256 payout, uint256 entries)',
  'event Settled(uint64 indexed round, uint256 payout, uint256 credited, uint256 dust)',
  'event Finalized(uint64 indexed round, uint256 payout)',
  'event Credited(address indexed buyer, uint64 indexed round, uint256 amount)',
  'event Claimed(address indexed buyer, address indexed to, uint256 amount)',
  'event DevClaimed(address indexed dev, uint256 amount)',
  'event Distributed(address indexed asset, uint256 amount)',
  ...ERRORS,
])
/** gang tx decodes these (the factory's Created and the module's own events). */
export const COUNTDOWN_EVENT_ABIS = [COUNTDOWN_FACTORY_ABI, COUNTDOWN_ABI]

const PAIR_ABI = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)'])
const PAD_ABI = parseAbi([
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)',
  'function PLATFORM_TAX_BPS() view returns (uint256)',
])
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])

export const HINTS = {
  NotAgent: 'only an Agent can create a V3 token, so only an Agent gets a countdown reward module',
  NotFactory: 'this countdown factory is not allowed on the platform\'s GangHandlerAdmin: it cannot list a module as a tax recipient. If GANG_COUNTDOWN_FACTORY / GANG_TESTNET_COUNTDOWN_FACTORY is set, unset or fix it; otherwise launch without --countdown-reward',
  NoVanityDeployer: 'this pad does not create its tokens at an address known in advance (its CREATE2 deployer is not on): a countdown module is cloned for one token address, so --countdown-reward is not available here yet',
  BadToken: 'the token address a countdown module is cloned for must end in abcd and have no token at it yet: the launch computes it; run it again (or add --restart)',
  BadConfig: 'a --cd-* setting is out of bounds: window 30m–24h; max round 1h–24h and at least the window; idle 7–90 days; payout 10–50%; last 0–20%; dev 0–50%; entries 1–20; min buy and max payout above 0',
  BadQuote: 'the reward pool\'s quote must be WBNB, GANG or a quote in the pad\'s QuoteRegistry: a launch with --countdown-reward needs one of those as its quote',
  AlreadyBound: 'the countdown module is bound to its token already',
  NotBound: 'the countdown module is not bound to its token yet: nothing is counted, funded or paid before that (the launch binds it right after the create)',
  WrongToken: 'a countdown module serves only the token it was cloned for (rewardToken): this is another token',
  NotCurve: 'the token the countdown module was cloned for is not created yet (or is not a V3 curve token on this pad)',
  NotCreator: 'the token at the module\'s address was not created by the module\'s dev',
  NotRecipient: 'the token does not pay its tax to this countdown module',
  WrongQuote: 'the token\'s quote (or its pair\'s other token) is not the countdown module\'s quote',
  NothingForRecipient: 'the token gives all of its tax to the holders\' dividend (--dividend 100): nothing would ever reach the reward pool',
  NotTradable: 'the token has not graduated: buys through the countdown module (and the countdown) start once it trades in its PancakeSwap pair',
  NotWbnb: 'only a WBNB-quoted token takes BNB: pay with the token\'s quote',
  Expired: 'the buy\'s deadline passed before it landed: run gang buy again',
  ZeroAmount: 'the amount is 0, or too small to buy a single token unit',
  Slippage: 'the price moved past --slippage before the buy landed: run gang buy again to re-quote',
  NothingToClaim: 'nothing to claim for this wallet',
  NotDue: 'nothing is due yet: the running round has not passed its deadline, or for finalize: not idle long enough, or the pool is under its minimum',
  NotCounted: 'the buy would not be counted (below the minimum buy, or the pool is under its minimum and no round runs), and it asked to count: nothing is bought. Add --cd-uncounted to buy through the module anyway without counting',
}
export const revertOf = (e) => revertIn(e, [COUNTDOWN_ABI, COUNTDOWN_FACTORY_ABI], HINTS)

/** Dry-run a call; { result } or { failed } with the revert. */
export async function simulateCountdown(client, from, address, abi, functionName, args = [], value = 0n) {
  try {
    const { result } = await client.simulateContract({ account: from, address, abi, functionName, args, value })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

/** The create target's countdown factory, or null when this network has none in this CLI version (mainnet now). */
export const countdownFactoryAddress = (testnet) => gangGens(testnet)[0].countdownFactory || null
export const countdownNotLive = (testnet) => (testnet
  ? 'the countdown reward (countdown-v1) has no factory on the BSC testnet in this CLI version: set GANG_TESTNET_COUNTDOWN_FACTORY to its address'
  : 'the countdown reward (countdown-v1) has no factory on BSC mainnet for this pad in this CLI version: set GANG_COUNTDOWN_FACTORY to its address')

// ---- the wording (the user's framing: the dev's own tax share becomes the buyers' reward, paid by fixed public rules)
export const WHAT_IT_IS = 'the dev turned its own share of the pool tax into a reward for buyers: when the countdown runs out, the last counted buys share this round\'s reward by a fixed public rule. Buyers pay only the pool price and the usual buy tax, nothing extra, and keep the tokens they buy. Who gets what follows from the order of counted buys alone, by rules anyone can read on chain'
export const ONLY_GANG_BUYS = 'only buys through the countdown module count, as the gang CLI and MCP send them (gang buy): a buy on PancakeSwap\'s own router, through an aggregator or through GangRouter is a normal buy and never counts'
export const MULTI_WALLET_NOTE = 'anyone, the dev included, can take several reward slots with several wallets: each slot only costs a counted buy (at least the minimum buy, paying the buy tax), and the same wallet may hold several slots'
export const CAPPED_NOTE = 'a round that keeps getting buys ends at its cap (its first counted buy + the max round time): that end time is public in advance, so its last slots favour whoever controls the order of the last block (block builders, private relays, bundles). For that reason a round that ends at its cap pays all its slots equally, with no extra for the last buy'
export const POOL_GROWS_NOTE = 'the pool grows only when the held tax is sold: on pool sells, or by the keeper in small chunks; with buys alone it grows slowly'
export const SELL_NOTE = 'sells never take out a buyer\'s slots and there is no holding check: a slot stays in its round whether or not the wallet still holds the tokens'
export const PERMANENT_NOTE = 'PERMANENT: the token it serves, the quote and every setting (window, max round, idle, payout %, last-buy %, dev %, slots, minimum buy, minimum pool, max payout) are fixed for good — nobody (not you, not the platform) can change them or take the pool out. Credited rewards never expire'
export const UNCHECKED_NOTE = 'could not check whether GangCountdownRewardFactory made this module (RPC error): nothing is shown or built until it is known — run the same command again'
export const UNVERIFIED_NOTE = 'this contract says it is a countdown reward module, but GangCountdownRewardFactory did not make it (GangHandlerAdmin.moduleOf): its numbers are its own claims, and this CLI builds no buy or other call against it'

// ---- the launch's flags

export const CD_FLAGS = ['cd-window', 'cd-max-round', 'cd-idle', 'cd-payout', 'cd-last', 'cd-dev', 'cd-entries', 'cd-min-buy', 'cd-min-pot', 'cd-max-payout', 'cd-seed', 'cd-seed-again']
export const CD_USAGE = '--countdown-reward --cd-max-payout <amount> [--cd-window 60m] [--cd-max-round 6h] [--cd-idle 30d] [--cd-payout 30] [--cd-last 20] [--cd-dev 0] [--cd-entries 10] [--cd-min-buy 0.05] [--cd-min-pot 0.1] [--cd-seed <amount>]'
export const CD_ALONE = '--cd-* settings go with --countdown-reward (a launch whose tax recipient is a countdown reward module)'

const NUM_RE = /^(\d+(\.\d*)?|\.\d+)$/
const PCT_RE = /^(\d{1,3})(?:\.(\d{1,2}))?$/
const pctBps = (raw) => {
  const m = PCT_RE.exec(String(raw ?? '').trim())
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null
}
/** "60m" / "1h" / "90" (minutes) → seconds; days with `unit` 'd' ("30d" / "30"). null when not a whole number of them. */
export function parseDuration(raw, unit = 'm') {
  const m = /^(\d+)\s*([mhd])?$/i.exec(String(raw ?? '').trim())
  if (!m) return null
  const u = (m[2] ?? unit).toLowerCase()
  return Number(m[1]) * { m: MIN, h: HOUR, d: DAY }[u]
}
const human = (s) => (s % DAY === 0 ? `${s / DAY}d` : s % HOUR === 0 ? `${s / HOUR}h` : `${s / MIN}m`)

/**
 * The --countdown-reward launch's --cd-* flags → { window, maxRound, idle, payoutBps, lastBps, devBps, entries, minBuy,
 * minPot, maxPayout, seed } (amounts as typed; minBuy / minPot null = the BNB default), or { error }. Bounds as
 * GangCountdownReward.initialize checks them.
 */
export function parseCountdownSpec(opt, flag) {
  const dur = (name, def, unit, [lo, hi], what) => {
    if (!flag(name)) return { v: def }
    const s = parseDuration(opt(name), unit)
    const hm = (x) => (unit === 'd' ? `${x / DAY}d` : x % HOUR === 0 ? `${x / HOUR}h` : `${x / MIN}m`)
    if (s === null || s < lo || s > hi) return { error: `--${name} must be ${what} (${hm(lo)}–${hm(hi)}; e.g. ${unit === 'd' ? '30d' : '60m or 1h'})`, got: opt(name) ?? null }
    return { v: s }
  }
  const pct = (name, def, [lo, hi], what) => {
    if (!flag(name)) return { v: def }
    const b = pctBps(opt(name))
    if (b === null || b < lo || b > hi) return { error: `--${name} must be ${what}: ${lo / 100} to ${hi / 100} (in %, at most 2 decimals)`, got: opt(name) ?? null }
    return { v: b }
  }
  const amount = (name, { required = false, zero = false } = {}) => {
    if (!flag(name)) return required ? { error: `--${name} <amount> is required: ${name === 'cd-max-payout' ? 'the most one round can ever pay, in the token\'s quote (e.g. --cd-max-payout 1)' : 'an amount of the token\'s quote'}` } : { v: null }
    const raw = String(opt(name) ?? '').trim()
    if (!NUM_RE.test(raw) || (!zero && !(Number(raw) > 0))) return { error: `--${name} must be ${zero ? 'an amount (0 or more)' : 'a positive amount'} of the token's quote`, got: opt(name) ?? null }
    return { v: raw }
  }
  const window = dur('cd-window', DEFAULTS.window, 'm', BOUNDS.window, 'how long after each counted buy the countdown runs out')
  if (window.error) return window
  const maxRound = dur('cd-max-round', DEFAULTS.maxRound, 'm', BOUNDS.maxRound, 'the longest a round can run from its first counted buy')
  if (maxRound.error) return maxRound
  if (maxRound.v < window.v) return { error: `--cd-max-round (${human(maxRound.v)}) must be at least --cd-window (${human(window.v)})` }
  const idle = dur('cd-idle', DEFAULTS.idle, 'd', BOUNDS.idle, 'the days with no counted buy after which the last round can be paid again (finalize)')
  if (idle.error) return idle
  const payout = pct('cd-payout', DEFAULTS.payoutBps, BOUNDS.payoutBps, 'the % of the pool a round pays')
  if (payout.error) return payout
  const last = pct('cd-last', DEFAULTS.lastBps, BOUNDS.lastBps, 'the % of a round\'s payout the last counted buy gets on top')
  if (last.error) return last
  const devPart = pct('cd-dev', DEFAULTS.devBps, BOUNDS.devBps, 'the % of the arriving tax you keep (the rest goes to the pool)')
  if (devPart.error) return devPart
  let entries = DEFAULTS.entries
  if (flag('cd-entries')) {
    const n = Number(opt('cd-entries'))
    if (!Number.isInteger(n) || n < BOUNDS.entries[0] || n > BOUNDS.entries[1]) return { error: '--cd-entries must be an integer between 1 and 20 (how many of a round\'s last counted buys share it)', got: opt('cd-entries') ?? null }
    entries = n
  }
  const minBuy = amount('cd-min-buy')
  if (minBuy.error) return minBuy
  const minPot = amount('cd-min-pot', { zero: true })
  if (minPot.error) return minPot
  const maxPayout = amount('cd-max-payout', { required: true })
  if (maxPayout.error) return maxPayout
  const seed = amount('cd-seed')
  if (seed.error) return seed
  return {
    window: window.v, maxRound: maxRound.v, idle: idle.v, payoutBps: payout.v, lastBps: last.v, devBps: devPart.v, entries,
    minBuy: minBuy.v, minPot: minPot.v, maxPayout: maxPayout.v, seed: seed.v,
  }
}

/**
 * The spec in the quote's units → { config (the contract's Config), seed (bigint, 0n for none), defaults: [notes] } or
 * { error }. The minimum buy / pool defaults are BNB amounts: only a WBNB-quoted token takes them as they are; any other
 * quote needs them given.
 */
export function countdownConfig(spec, { decimals, wbnbQuoted, symbol = 'the quote' }) {
  const notes = []
  const amt = (raw, name, def) => {
    if (raw !== null) return parseUnits(raw, decimals)
    if (!wbnbQuoted) return { error: `--${name} <amount> is required on a token quoted in ${symbol}: its default (${def} BNB) is a BNB amount` }
    notes.push(`--${name} left out: ${def} BNB`)
    return parseUnits(def, 18)
  }
  const minBuy = amt(spec.minBuy, 'cd-min-buy', DEFAULTS.minBuy)
  if (minBuy.error) return minBuy
  const minPot = amt(spec.minPot, 'cd-min-pot', DEFAULTS.minPot)
  if (minPot.error) return minPot
  const maxPayout = parseUnits(spec.maxPayout, decimals)
  if (minBuy === 0n) return { error: '--cd-min-buy rounds to 0 in the quote\'s decimals', got: spec.minBuy }
  if (maxPayout === 0n) return { error: '--cd-max-payout rounds to 0 in the quote\'s decimals', got: spec.maxPayout }
  const seed = spec.seed ? parseUnits(spec.seed, decimals) : 0n
  if (spec.seed && seed === 0n) return { error: '--cd-seed rounds to 0 in the quote\'s decimals', got: spec.seed }
  return {
    config: {
      window: BigInt(spec.window), maxRound: BigInt(spec.maxRound), idle: BigInt(spec.idle), payoutBps: spec.payoutBps,
      lastBps: spec.lastBps, devBps: spec.devBps, entries: spec.entries, minBuy, minPot, maxPayout,
    },
    seed, notes,
  }
}

/** Two Configs (as typed here, or as config() returns it) are the same. */
export function sameConfig(a, b) {
  return ['window', 'maxRound', 'idle', 'minBuy', 'minPot', 'maxPayout'].every((k) => BigInt(a[k]) === BigInt(b[k]))
    && ['payoutBps', 'lastBps', 'devBps', 'entries'].every((k) => Number(a[k]) === Number(b[k]))
}

// ---- the contract's math (pure: unit-tested to the wei)

/** _payoutOf: what a freeze of a pool `p` reserves for its round. */
export const payoutOf = (p, cfg) => {
  const x = (BigInt(p) * BigInt(cfg.payoutBps)) / BigInt(BPS)
  return x > BigInt(cfg.maxPayout) ? BigInt(cfg.maxPayout) : x
}

/** _credit: `payout` over `k` entries (the newest `last`), capped or not → { each, last, dust }. */
export function sharesOf(payout, k, cfg, capped = false) {
  payout = BigInt(payout)
  if (k === 0 || payout === 0n) return { each: 0n, last: 0n, dust: payout }
  const extra = k === 1 || capped ? 0n : (payout * BigInt(cfg.lastBps)) / BigInt(BPS)
  const each = (payout - extra) / BigInt(k)
  return { each, last: each + extra, dust: payout - each * BigInt(k) - extra }
}

/**
 * How much of the pool's volume reaches the reward pool, in % of volume: (tax − platform tax) × (1 − dividend) ×
 * (1 − dev %). Buys pay the buy tax, sells the sell tax: `{ buys, sells }` when they differ.
 */
export function poolShare({ buyTaxPct, sellTaxPct, platformTaxPct = 0.5, dividendPct = 0, devBps = 0 }) {
  const at = (tax) => Math.max(0, Math.round((tax - platformTaxPct) * (1 - dividendPct / 100) * (1 - devBps / BPS) * 1e4) / 1e4)
  const [a, b] = [at(buyTaxPct), at(sellTaxPct)]
  return {
    pctOfVolume: a === b ? a : { buys: a, sells: b },
    how: `(tax − ${platformTaxPct}% platform) × (1 − ${dividendPct}% dividend)${devBps ? ` × (1 − ${devBps / 100}% kept by the dev)` : ''}, of pool volume after graduation, as the held tax is sold. While no holder has 10,000+ tokens the holders' part falls back to the recipient, so a little more arrives`,
  }
}

/** The call reached a contract (or a wallet) and got a revert or no data back: its answer, not the node's failure. */
const reverted = (e) => !e?.walk?.((x) => x?.code === -32603)
  && !!e?.walk?.((x) => ['ContractFunctionRevertedError', 'ContractFunctionZeroDataError', 'ExecutionRevertedError'].includes(x?.name) || x?.code === 3)

const fmt = (x, decimals) => formatUnits(BigInt(x), decimals)

/**
 * What a launch preview says about the countdown reward (pure). `cfg`: the Config; amounts in the quote's units.
 * The economics the spec asks the dev to see: what share of pool volume reaches the pool, what a round can pay at most,
 * and what taking every slot costs.
 */
export function countdownCreateView({ cfg, seed = 0n, decimals, symbol, buyTaxPct, sellTaxPct, platformTaxPct, dividendPct, defaults = [] }) {
  const f = (x) => `${fmt(x, decimals)} ${symbol}`
  const n = Number(cfg.entries)
  const fill = BigInt(n) * BigInt(cfg.minBuy)
  const fillTax = (fill * BigInt(Math.round(buyTaxPct * 100))) / BigInt(BPS)
  const share = poolShare({ buyTaxPct, sellTaxPct, platformTaxPct, dividendPct, devBps: Number(cfg.devBps) })
  const last = Number(cfg.lastBps) / 100
  return {
    what: WHAT_IT_IS,
    rules: {
      window: human(Number(cfg.window)), maxRound: human(Number(cfg.maxRound)), idle: human(Number(cfg.idle)),
      payoutPct: Number(cfg.payoutBps) / 100, lastPct: last, devPct: Number(cfg.devBps) / 100, entries: n,
      minBuy: f(cfg.minBuy), minPot: f(cfg.minPot), maxPayout: f(cfg.maxPayout),
    },
    how: `after graduation, each buy of at least ${f(cfg.minBuy)} through the module puts the countdown ${human(Number(cfg.window))} ahead, but a round never runs past ${human(Number(cfg.maxRound))} from its first counted buy. When the countdown runs out, the round's last ${n} counted buys share ${Number(cfg.payoutBps) / 100}% of the pool (never more than ${f(cfg.maxPayout)}): an equal share each${last > 0 ? `, and the very last buy ${last}% of the round's payout on top` : ''}. The rest of the pool carries over. No round starts while the pool is under ${f(cfg.minPot)}. With no counted buy for ${human(Number(cfg.idle))}, anyone may pay the last round's slots once more (finalize), again at most ${f(cfg.maxPayout)}`,
    poolGets: share,
    fromYourTax: Number(cfg.devBps) > 0 ? `of the tax that reaches the module you keep ${Number(cfg.devBps) / 100}% (claim with gang countdown claim-dev); the rest is the buyers' pool` : 'all of the tax that reaches the module goes to the buyers\' pool: you keep none of it',
    roundPaysAtMost: f(cfg.maxPayout),
    takingAllSlots: {
      buys: `${n} counted buys of ${f(cfg.minBuy)} = ${f(fill)} spent on the token (the buyer keeps the tokens)`,
      buyTax: `about ${f(fillTax)} in buy tax at ${buyTaxPct}%, plus price impact and the risk of holding the tokens; part of that tax comes back into the pool`,
      versusPayout: `so one buyer (or several wallets of one) filling every slot could take up to ${f(cfg.maxPayout)} in one round for roughly that cost. A higher --cd-min-buy, more --cd-entries or a lower --cd-max-payout makes that dearer`,
    },
    ...(seed > 0n && { seed: `${f(seed)} from your wallet into the pool after the bind (approve, then fund): all of it is the buyers' pool, none of it ever comes back to you` }),
    honest: [MULTI_WALLET_NOTE, CAPPED_NOTE, ONLY_GANG_BUYS, POOL_GROWS_NOTE, SELL_NOTE],
    ...(defaults.length && { defaults }),
    permanent: PERMANENT_NOTE,
  }
}

const iso = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null)

/**
 * What a buy of `quoteIn` would mean, if no other counted buy came after it before the deadline (pure). `s`: the raw
 * state (countdownRaw): cfg, deadline, roundEndsBy, potAvailable, cur round's count, now. → { k, payout, mine, capped,
 * startsRound, freezesPrevious } or null when the buy would not count.
 */
export function estimateShare(s, counted) {
  if (!counted) return null
  const cfg = s.cfg, now = BigInt(s.now), dl = BigInt(s.deadline), n = Number(cfg.entries)
  let pool = BigInt(s.potAvailable)
  let running = dl !== 0n && now <= dl
  const freezesPrevious = dl !== 0n && now > dl
  if (freezesPrevious) pool -= payoutOf(pool, cfg)
  const count = running ? Number(s.count) : 0
  const k = Math.min(count + 1, n)
  // the deadline this buy sets, and whether it lands on the round's cap
  const endsBy = running ? BigInt(s.roundEndsBy) : now + BigInt(cfg.maxRound)
  const capped = now + BigInt(cfg.window) >= endsBy
  const payout = payoutOf(pool, cfg)
  const sh = sharesOf(payout, k, cfg, capped)
  return { k, payout, mine: sh.last, each: sh.each, capped, startsRound: !running, freezesPrevious }
}

/**
 * The raw state of a module for printing (reads it all). null when `addr` does not answer countdown-v1. `factory`: the
 * countdown factory of the pad's generation (the provenance check). `me`: a wallet to report its claimable and slots.
 */
export async function countdownRaw(read, addr, { factory, admin, token = null, me = null, getBlock } = {}) {
  if (!addr || addr === zeroAddress) return null
  let type
  try { type = await read(addr, COUNTDOWN_ABI, 'moduleType') } catch (e) {
    // no such function (a wallet, another contract) is "not one"; a node's failure is not an answer
    if (reverted(e)) return null
    throw e
  }
  if (hexToString(type, { size: 32 }).replace(/\0+$/, '') !== COUNTDOWN_TYPE) return null
  // provenance first: a module of another factory (the superseded one) or any contract that answers countdown-v1 is
  // read no further, so an older or bad ABI can't look like an RPC failure. Only the warning is shown for it
  const [verified, rewardToken] = await Promise.all([
    countdownVerified(read, addr, factory, admin),
    read(addr, COUNTDOWN_ABI, 'rewardToken').catch(() => null),
  ])
  if (verified !== true) return { module: addr, verified, rewardToken, partial: true }
  if (token && String(rewardToken).toLowerCase() !== token.toLowerCase()) return { module: addr, verified, rewardToken, partial: true }
  const FIELDS = ['config', 'dev', 'rewardToken', 'rewardQuote', 'token', 'pot', 'potAvailable', 'reservedTotal', 'claimTotal', 'devOwed', 'cur', 'deadline', 'lastRoundId', 'lastCountedAt', 'lastFinalizedAt', 'currentRound', 'roundEndsBy', 'previewWork']
  const [vals, rounds, block, claimable] = await Promise.all([
    Promise.all(FIELDS.map((f) => read(addr, COUNTDOWN_ABI, f))),
    Promise.all([0, 1].map((b) => read(addr, COUNTDOWN_ABI, 'round', [b]))),
    getBlock ? getBlock() : null,
    me ? read(addr, COUNTDOWN_ABI, 'claimableOf', [me]) : 0n,
  ])
  const r = Object.fromEntries(FIELDS.map((f, i) => [f, vals[i]]))
  const cur = Number(r.cur)
  const buf = (b) => {
    const [id, count, frozen, settled, reserved, list] = rounds[b]
    return { id: Number(id), count: Number(count), frozen, settled, reserved, list: list.map((e) => ({ buyer: e.buyer, tokens: e.tokens })) }
  }
  return {
    module: addr, verified, cfg: r.config, dev: r.dev, rewardToken: r.rewardToken, rewardQuote: r.rewardQuote,
    token: r.token === zeroAddress ? null : r.token, pot: r.pot, potAvailable: r.potAvailable, reservedTotal: r.reservedTotal,
    claimTotal: r.claimTotal, devOwed: r.devOwed, cur, deadline: r.deadline, lastRoundId: Number(r.lastRoundId),
    lastCountedAt: r.lastCountedAt, lastFinalizedAt: r.lastFinalizedAt, currentRound: Number(r.currentRound), roundEndsBy: r.roundEndsBy,
    due: r.previewWork[0], rounds: [buf(0), buf(1)], count: buf(cur).count,
    now: block ? block.timestamp : BigInt(Math.floor(Date.now() / 1000)), me, claimable,
  }
}

const ADMIN_ABI = parseAbi(['function moduleOf(address module) view returns (address)'])
/**
 * Whether `module` was made by `factory`: the factory's admin() is the network's pinned GangHandlerAdmin (`admin`, from
 * gangpad.js; never from the env) and that admin's moduleOf(module) is the factory. null when it could not be read.
 */
export async function countdownVerified(read, module, factory, admin) {
  if (!factory || !admin) return false
  try {
    const a = await read(factory, COUNTDOWN_FACTORY_ABI, 'admin')
    if (a.toLowerCase() !== admin.toLowerCase()) return false
    return (await read(a, ADMIN_ABI, 'moduleOf', [module])).toLowerCase() === factory.toLowerCase()
  } catch { return null }
}

/** Whether a settle / finalize is due now, from the raw state (as the contract's _due). */
export function dueOf(s) {
  const now = BigInt(s.now), dl = BigInt(s.deadline)
  const settle = (dl !== 0n && now > dl) || s.rounds.some((b) => b.frozen && !b.settled)
  if (settle) return { settle: true, finalize: false }
  const last = BigInt(s.lastCountedAt)
  if (last === 0n || dl !== 0n) return { settle: false, finalize: false, finalizeFrom: null }
  const since = BigInt(s.lastFinalizedAt) > last ? BigInt(s.lastFinalizedAt) : last
  const from = since + BigInt(s.cfg.idle)
  const p = BigInt(s.potAvailable)
  return { settle: false, finalize: now >= from && p >= BigInt(s.cfg.minPot) && payoutOf(p, s.cfg) !== 0n, finalizeFrom: from }
}

/** The module's state for printing (pure). `q`: { symbol, decimals }; `ref`: how later commands name it. */
export function formatCountdown(s, q, ref) {
  const d = q.decimals ?? 18
  const f = (x) => fmt(x, d)
  const sym = q.symbol ?? 'of the quote'
  const now = BigInt(s.now), dl = BigInt(s.deadline)
  const running = dl !== 0n && now <= dl
  const due = dueOf(s)
  const me = s.me ? String(s.me).toLowerCase() : null
  const roundOf = (b) => {
    const r = s.rounds[b]
    if (!r.id) return null
    const n = Number(s.cfg.entries)
    return {
      id: r.id, countedBuys: r.count, slots: Math.min(r.count, n),
      state: r.settled ? 'paid' : r.frozen ? 'ended: its payout is set aside, waiting to be credited (settle)' : b === s.cur && running ? 'running' : b === s.cur && dl !== 0n ? 'ended: waiting for the freeze (settle, or the next counted buy)' : 'ended',
      ...(r.frozen && !r.settled && { reserved: f(r.reserved) }),
      // oldest first: the last one is the newest counted buy
      slotsOldestFirst: r.list.map((e) => ({ buyer: e.buyer, tokens: formatUnits(e.tokens, 18), ...(me && e.buyer.toLowerCase() === me && { you: true }) })),
    }
  }
  const curRound = roundOf(s.cur)
  const prev = roundOf(1 - s.cur)
  const payoutNow = payoutOf(s.potAvailable, s.cfg)
  const state = s.verified === null ? 'unchecked' : s.verified !== true ? 'unverified' : !s.token ? 'unbound' : running ? 'running' : dl !== 0n ? 'ended' : s.lastRoundId ? 'waiting' : 'not started'
  const next = []
  const tn = ref
  if (s.verified === true && s.token) {
    if (due.settle) next.push(`gang countdown settle ${tn} (anyone: the round passed its deadline)`)
    if (due.finalize) next.push(`gang countdown finalize ${tn} (anyone: idle long enough, pays the last round's slots again)`)
    if (s.me && BigInt(s.claimable) > 0n) next.push(`gang countdown claim ${tn}`)
    if (s.me && String(s.dev).toLowerCase() === me && BigInt(s.devOwed) > 0n) next.push(`gang countdown claim-dev ${tn}`)
  }
  return {
    module: s.module, moduleType: COUNTDOWN_TYPE, verified: s.verified, state, dev: s.dev, rewardToken: s.rewardToken, token: s.token,
    quote: s.rewardQuote, quoteSymbol: q.symbol ?? null, quoteDecimals: d,
    rules: {
      window: human(Number(s.cfg.window)), maxRound: human(Number(s.cfg.maxRound)), idle: human(Number(s.cfg.idle)),
      payoutPct: Number(s.cfg.payoutBps) / 100, lastPct: Number(s.cfg.lastBps) / 100, devPct: Number(s.cfg.devBps) / 100,
      entries: Number(s.cfg.entries), minBuy: f(s.cfg.minBuy), minPot: f(s.cfg.minPot), maxPayout: f(s.cfg.maxPayout),
    },
    pool: f(s.potAvailable), poolBooked: f(s.pot), reserved: f(s.reservedTotal), creditedUnclaimed: f(s.claimTotal), devOwed: f(s.devOwed),
    nextRoundPays: `${f(payoutNow)} ${sym} if a round ended now (${Number(s.cfg.payoutBps) / 100}% of the pool, at most ${f(s.cfg.maxPayout)})`,
    round: {
      current: s.currentRound || null,
      deadline: iso(s.deadline), ...(running && { secondsLeft: Number(dl - now) }),
      endsBy: running ? iso(s.roundEndsBy) : null,
      ...(dl !== 0n && !running && { ended: 'the deadline passed: the round is paid on the next settle (anyone) or the next counted buy' }),
      ...(curRound && { latest: curRound }), ...(prev && { previous: prev }),
    },
    lastCountedAt: iso(s.lastCountedAt),
    due: { settle: due.settle, finalize: due.finalize, ...(due.finalizeFrom && !due.finalize && { finalizeFrom: iso(due.finalizeFrom) }) },
    ...(s.me && { wallet: s.me, claimable: f(s.claimable) }),
    ...(next.length && { next }),
    what: WHAT_IT_IS,
    notes: [ONLY_GANG_BUYS, MULTI_WALLET_NOTE, CAPPED_NOTE, SELL_NOTE, POOL_GROWS_NOTE],
  }
}

/** The status of a module that may not be shown (unchecked, unverified, or cloned for another token): the warning only. */
export function countdownShown(s, token) {
  const warning = s.verified === null ? UNCHECKED_NOTE : s.verified !== true ? UNVERIFIED_NOTE
    : token && String(s.rewardToken).toLowerCase() !== token.toLowerCase()
      ? `this token pays its tax to a countdown reward module cloned for another token (${s.rewardToken}): this token has NO countdown reward, and its tax feeds that other token's pool` : null
  return warning ? { module: s.module, claims: COUNTDOWN_TYPE, verified: s.verified, isThisTokensCountdown: false, warning } : null
}

/**
 * The countdown reward of a V3 `token` whose tax recipient is `recipient`, on ctx (already on the token's generation).
 * → null (none: no factory here, or the recipient is no countdown module) | { unread } | { warning } (claims to be one,
 * or is one for another token: never bought through) | { live: true, raw } (made by the factory, cloned for this token).
 */
export async function countdownForToken(ctx, token, recipient, me = null) {
  const factory = ctx.countdownFactory || null
  if (!factory || !recipient || recipient === zeroAddress) return null
  let raw
  try { raw = await countdownRaw(ctx.read, recipient, { factory, admin: ctx.handlerAdmin, token, me, getBlock: () => ctx.client.getBlock() }) } catch (e) {
    return { unread: e.shortMessage || e.message.split('\n')[0] }
  }
  if (!raw) return null
  if (raw.verified === null) return { unread: UNCHECKED_NOTE }
  const shown = countdownShown(raw, token)
  if (shown) return { warning: shown.warning, module: raw.module }
  return { live: true, raw }
}

/** rewards.countdown of a pool buy through the module (pure). `counted`: wouldCount(quoteIn). */
export function countdownBuyLine(s, quoteIn, counted, q, { mustCount = true } = {}) {
  const d = q.decimals ?? 18
  const f = (x) => `${fmt(x, d)} ${q.symbol ?? 'of the quote'}`
  const now = BigInt(s.now), dl = BigInt(s.deadline)
  const running = dl !== 0n && now <= dl
  const belowMin = BigInt(quoteIn) < BigInt(s.cfg.minBuy)
  const why = counted
    ? `it spends at least the ${f(s.cfg.minBuy)} minimum${running ? ' and a round is running' : ` and the pool (${f(s.potAvailable)}) can start a round`}`
    : belowMin ? `it spends less than the ${f(s.cfg.minBuy)} minimum`
      : `no round is running and the pool would be under its ${f(s.cfg.minPot)} minimum${dl !== 0n ? ' once the ended round takes its payout' : ''}: no round starts until the tax brings it back`
  const est = estimateShare(s, counted)
  return {
    counts: counted, why, mustCount,
    ...(!counted && { ifNotCounted: mustCount ? 'with the default mustCount the buy reverts (NotCounted): nothing is bought' : '--cd-uncounted: the buy goes through as a plain buy, not counted' }),
    pool: f(s.potAvailable), minBuy: f(s.cfg.minBuy), slots: Number(s.cfg.entries),
    round: {
      current: running ? s.currentRound : null,
      deadline: iso(s.deadline), ...(running && { secondsLeft: Number(dl - now), endsBy: iso(s.roundEndsBy), countedSoFar: s.count }),
      ...(dl !== 0n && !running && { ended: 'its deadline passed: this buy first ends it (its slots are paid as they stand), then starts the next round' }),
    },
    ...(est && {
      estimate: {
        yourShareIfLast: f(est.mine), roundPays: f(est.payout), slotsFilled: est.k,
        ...(est.startsRound && { startsRound: true }),
        ...(est.capped && { atCap: 'the countdown this buy sets reaches the round\'s cap: the round ends at a public time and its slots are paid equally (no extra for the last buy)' }),
        note: `if no other counted buy came before the deadline (as the pool stands now). Every later counted buy puts the deadline ${human(Number(s.cfg.window))} ahead and, once ${Number(s.cfg.entries)} more come, pushes this buy out of the round's slots; the pool also grows as tax is sold`,
      },
    }),
    note: `${WHAT_IT_IS}. ${MULTI_WALLET_NOTE}. ${ONLY_GANG_BUYS}`,
  }
}

/** rewards.countdown of a pool sell (pure): sells don't touch slots. */
export const countdownSellLine = (s, q) => ({
  pool: `${fmt(s.potAvailable, q.decimals ?? 18)} ${q.symbol ?? 'of the quote'}`,
  note: `${SELL_NOTE}. Pool sells sell some of the held tax first: that is how the countdown pool grows`,
})

/**
 * A pool buy of `amount` (decimal string) through the module, for a graduated token whose recipient is its own
 * countdown module (`cd.raw`). Returns what the command prints. `c`: curveOf(…). `payBnb`: pay native BNB (WBNB-quoted
 * only). `mustCount`: revert unless counted.
 */
export async function countdownBuy(ctx, { token, c, cd, me, amount, slippage, payBnb, mustCount, rawOnly, summarize, base = {} }) {
  const s = cd.raw
  const quote = s.rewardQuote
  const wbnbQuoted = quote.toLowerCase() === String(ctx.wbnb).toLowerCase()
  const failOut = (o) => ({ success: false, ...base, step: 'pool-buy', via: 'countdown', module: s.module, ...o })
  if (payBnb && !wbnbQuoted) return failOut({ error: '--pay-bnb: the countdown reward module takes the token\'s own quote only (it buys on the token\'s own pair)', hint: `drop --pay-bnb and pay in ${c.quoteSymbol ?? quote}` })
  const useBnb = wbnbQuoted && payBnb
  const decimals = await decimalsOf(ctx, quote)
  const q = { symbol: c.quoteSymbol, decimals }
  const quoteIn = parseUnits(amount, useBnb ? 18 : decimals)
  if (quoteIn === 0n) return failOut({ error: `--amount ${amount} rounds to 0` })
  const counted = await ctx.read(s.module, COUNTDOWN_ABI, 'wouldCount', [quoteIn])
  const line = countdownBuyLine(s, quoteIn, counted, q, { mustCount })
  if (mustCount && !counted) {
    return failOut({
      error: `this buy would not count for the countdown reward: ${line.why}`, rewards: { countdown: line },
      hint: BigInt(quoteIn) < BigInt(s.cfg.minBuy) ? `buy at least ${line.minBuy} (--amount), or add --cd-uncounted to buy through the module without counting` : 'add --cd-uncounted to buy through the module without counting, or wait for the pool to grow',
    })
  }
  // the pool's own price for the estimate (the module swaps on the pair at Pancake V2's 0.25% fee), less the buy tax
  const [[r0, r1], t0] = await Promise.all([ctx.read(c.pair, PAIR_ABI, 'getReserves'), ctx.read(c.pair, PAIR_ABI, 'token0')])
  const [rT, rQ] = t0.toLowerCase() === token.toLowerCase() ? [r0, r1] : [r1, r0]
  const inFee = quoteIn * 9_975n
  const gross = rQ > 0n ? (inFee * rT) / (rQ * 10_000n + inFee) : 0n
  const buyTaxBps = BigInt(Math.round(c.buyTaxPct * 100))
  const estimate = gross - (gross * buyTaxBps) / 10_000n
  const deadline = routerDeadline()
  const minOf = (x) => (x * BigInt(Math.round((100 - slippage) * 100))) / 10_000n
  const fields = {
    step: 'pool-buy', venue: 'pancakeswap', via: 'countdown', module: s.module, function: useBnb ? 'buy' : 'buyWithQuote',
    spend: amount, payWith: useBnb ? 'BNB' : c.quoteSymbol, quote: c.quoteSymbol, pair: c.pair, buyTaxPct: c.buyTaxPct,
    slippagePct: slippage, deadline: Number(deadline), mustCount,
    ...base, rewards: { countdown: line },
  }
  if (useBnb) {
    const native = await ctx.client.getBalance({ address: me })
    if (native < quoteIn + GAS_RESERVE) {
      return failOut({ error: 'not enough BNB for this buy (native BNB must also cover gas)', haveBnb: formatUnits(native, 18), needBnb: amount, reserveForGas: formatUnits(GAS_RESERVE, 18), hint: 'add --use-quote to pay from WBNB instead' })
    }
  } else {
    const pre = await fundingStep(ctx, { me, token: quote, need: quoteIn, spender: s.module, sym: c.quoteSymbol, approveStep: 'approve-quote' }, rawOnly, summarize)
    if (pre) {
      return pre.success === false ? failOut(pre) : {
        ...pre, chainId: Number(ctx.chainId), token, module: s.module, next: 'pool-buy',
        then: { via: 'countdown', function: 'buyWithQuote', spend: amount, expectTokens: formatUnits(estimate, 18), mustCount },
        rewards: { countdown: line }, note: `${pre.note ? `${pre.note}. ` : ''}the countdown module pulls the quote straight to the pair (it never holds it): approve it for this buy's amount, then run the same command again`,
      }
    }
  }
  const fn = useBnb ? 'buy' : 'buyWithQuote'
  const args = useBnb ? [0n, deadline, mustCount] : [quoteIn, 0n, deadline, mustCount]
  const sim = await simulateCountdown(ctx.client, me, s.module, COUNTDOWN_ABI, fn, args, useBnb ? quoteIn : 0n)
  if (sim.failed) return failOut({ ...fields, ...sim.failed })
  const tokensOut = sim.result
  const minOut = minOf(tokensOut)
  const data = encodeFunctionData({ abi: COUNTDOWN_ABI, functionName: fn, args: useBnb ? [minOut, deadline, mustCount] : [quoteIn, minOut, deadline, mustCount] })
  return step(ctx, { from: me, to: s.module, data, value: useBnb ? quoteIn : 0n }, {
    chainId: Number(ctx.chainId), token, ...fields,
    expectTokens: formatUnits(tokensOut, 18), minTokensOut: formatUnits(minOut, 18), quotedWith: 'simulation',
    note: `bought through the token's countdown reward module on its own PancakeSwap pair (${useBnb ? 'BNB, wrapped in the same call' : 'the quote goes straight from this wallet to the pair'}); the tokens go to ${me}, after the ${c.buyTaxPct}% buy tax. minTokensOut = the simulated amount less --slippage. ${mustCount ? 'mustCount: if the buy would not count when it lands, it reverts and nothing is bought (--cd-uncounted to buy anyway)' : '--cd-uncounted: the buy goes through even if it is not counted'}. Let the wallet estimate gas (a buy that ends a round pays it out in place: up to about 350k gas)`,
  }, rawOnly, summarize)
}

// ---- gang countdown <sub>

function cdCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const SUBS = ['status', 'claim', 'settle', 'finalize', 'claim-dev']
const USAGE = 'usage: gang countdown <status|claim|settle|finalize|claim-dev> --token <addr> [--to <addr>] [--from <addr>] [--testnet] [--calldata] — see gang help'

/** `gang countdown <sub>`: the countdown reward module of a V3 token (its tax recipient), found from --token. */
export async function runCountdown(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  let ctx
  try { ctx = cdCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)
  const tn = testnet ? ' --testnet' : ''
  // no generation of this network has a countdown factory (mainnet now): said before any read
  if (!gangGens(testnet).some((g) => g.countdownFactory)) return fail(countdownNotLive(testnet))
  const token = opt('token')
  if (!isAddress(token ?? '')) return fail('--token must be a V3 token address (0x…)', { got: token ?? null })
  const kind = await atTokenPad(ctx, token)
  if (kind === null) return fail(KIND_UNREAD.error, { token, retry: KIND_UNREAD.retry })
  if (kind === 'gangswap') return fail(gangSwapTakesNone(kind, 'countdown reward'), { token, chainId, kind })
  if (kind !== 'v3') return fail(`not a V3 curve token on a GangLaunchpad (${testnet ? 'BSC testnet' : 'BSC mainnet; add --testnet for a testnet token'})`, { token, chainId, ...(kind && kind !== 'none' && { kind }) })
  if (!ctx.countdownFactory) return fail(countdownNotLive(testnet), { token, padGen: ctx.gen ?? null })
  if (flag('to') && sub !== 'claim') return fail('--to applies to gang countdown claim only (where your reward is paid)')
  let curve, recipient
  try {
    [curve, [, , , recipient]] = await Promise.all([ctx.read(ctx.pad, PAD_ABI, 'curves', [token]), ctx.read(ctx.pad, PAD_ABI, 'taxConfigOf', [token])])
  } catch (e) {
    return fail('could not read the token\'s curve and tax recipient (RPC error)', { token, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' })
  }
  let me = null
  try { me = walletFor(ctx, opt('from')) } catch { /* status works without a wallet */ }
  let raw
  try { raw = await countdownRaw(ctx.read, recipient, { factory: ctx.countdownFactory, admin: ctx.handlerAdmin, token, me, getBlock: () => ctx.client.getBlock() }) } catch (e) {
    return fail('could not read the countdown reward module (RPC error)', { token, module: recipient, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' })
  }
  if (!raw) return fail('this token\'s tax recipient is not a countdown reward module (countdown-v1): the token was not launched with --countdown-reward', { token, recipient: recipient === zeroAddress ? null : recipient })
  if (raw.verified === null) return fail(UNCHECKED_NOTE, { token, module: raw.module, retry: 'same command again' })
  const shown = countdownShown(raw, token)
  if (shown) return sub === 'status' ? out({ success: true, chainId, token, ...shown }) : fail(shown.warning, { token, module: raw.module })
  const [symbol, decimals] = await Promise.all([
    ctx.read(raw.rewardQuote, ERC20_ABI, 'symbol').catch(() => null), ctx.read(raw.rewardQuote, ERC20_ABI, 'decimals').then(Number).catch(() => 18),
  ])
  const q = { symbol, decimals }
  const ref = `--token ${token}${tn}`
  const view = formatCountdown(raw, q, ref)
  if (sub === 'status') return out({ success: true, chainId, token, graduated: curve[6], ...(!curve[6] && { beforeGraduation: 'the token has not graduated: the countdown starts with the first counted buy through the module in its PancakeSwap pool' }), ...view })

  if (!me) return fail('no wallet: sign in to baw, or pass --from <addr> with --calldata')
  if (!raw.token) return fail(HINTS.NotBound, { token, module: raw.module })
  const f = (x) => formatUnits(BigInt(x), decimals)
  const sym = symbol ?? 'of the quote'
  const due = dueOf(raw)
  const send = async (functionName, args, extra) => {
    const sim = await simulateCountdown(ctx.client, me, raw.module, COUNTDOWN_ABI, functionName, args)
    if (sim.failed) return out({ success: false, step: extra.step, token, module: raw.module, ...sim.failed })
    const data = encodeFunctionData({ abi: COUNTDOWN_ABI, functionName, args })
    return out(step(ctx, { from: me, to: raw.module, data }, { chainId, token, module: raw.module, ...extra }, flag('calldata'), summarize))
  }

  if (sub === 'claim') {
    if (BigInt(raw.claimable) === 0n) {
      return fail('nothing to claim for this wallet: no round it had slots in has been paid to it', {
        token, wallet: me, ...(due.settle && { hint: `a round passed its deadline and is not credited yet: gang countdown settle ${ref} first (anyone), then claim` }),
      })
    }
    let to = me
    if (flag('to')) {
      to = opt('to')
      if (!isAddress(to ?? '') || to === zeroAddress) return fail('--to must be a 0x address (checksummed or all lowercase): where the reward is paid (left out: this wallet)', { got: to ?? null })
      to = getAddress(to)
    }
    return send('claim', [to], {
      step: 'countdown-claim', amount: f(raw.claimable), quote: sym, to,
      note: `pays everything credited to this wallet (${f(raw.claimable)} ${sym}) to ${to.toLowerCase() === String(me).toLowerCase() ? 'this wallet' : to}`,
    })
  }
  // the local reading of what is due must agree with the module's own previewWork, or nothing is built
  if ((sub === 'settle' || sub === 'finalize') && (due.settle || due.finalize) !== !!raw.due) {
    return fail(`the module's previewWork says ${raw.due ? 'something is due' : 'nothing is due'}, but this CLI reads the round as ${due.settle ? 'due to settle' : due.finalize ? 'due to finalize' : 'not due'}: nothing is built. Run the command again (a block may have landed in between); if it persists, report it`, { token, module: raw.module, previewWork: !!raw.due, local: due, retry: 'same command again' })
  }
  if (sub === 'settle') {
    if (!due.settle) {
      const dl = BigInt(raw.deadline)
      return fail(dl !== 0n ? `nothing to settle yet: the round runs until ${iso(raw.deadline)} (each counted buy can put it later, up to ${iso(raw.roundEndsBy)})` : 'nothing to settle: no round has passed its deadline unpaid', { token, ...(due.finalize && { hint: `a finalize is due: gang countdown finalize ${ref}` }) })
    }
    return send('settle', [], {
      step: 'countdown-settle', pool: f(raw.potAvailable), quote: sym,
      note: 'anyone may: books the tax that arrived, ends the round whose deadline passed (its payout is fixed now) and credits every ended round\'s slots; the buyers then claim with gang countdown claim',
    })
  }
  if (sub === 'finalize') {
    if (due.settle) return fail(`a round is still to be settled first: gang countdown settle ${ref}`, { token })
    if (!due.finalize) {
      return fail(raw.lastCountedAt === 0n ? 'nothing to finalize: no buy has been counted yet'
        : BigInt(raw.deadline) !== 0n ? `nothing to finalize: a round is running (until ${iso(raw.deadline)}); finalize is for a countdown with no counted buy for ${human(Number(raw.cfg.idle))}`
        : BigInt(raw.potAvailable) < BigInt(raw.cfg.minPot) ? `nothing to finalize: the pool (${f(raw.potAvailable)} ${sym}) is under its ${f(raw.cfg.minPot)} minimum` : `not due yet: finalize opens ${iso(due.finalizeFrom)} (no counted buy for ${human(Number(raw.cfg.idle))})`, { token, hint: HINTS.NotDue })
    }
    const payout = payoutOf(raw.potAvailable, raw.cfg)
    return send('finalize', [], {
      step: 'countdown-finalize', pays: f(payout), quote: sym,
      note: `anyone may: after ${human(Number(raw.cfg.idle))} with no counted buy, pays the last round's slots once more (${Number(raw.cfg.payoutBps) / 100}% of the pool, at most ${f(raw.cfg.maxPayout)}); again only after another ${human(Number(raw.cfg.idle))}. A later counted buy starts the countdown again`,
    })
  }
  // claim-dev: the dev's booked part of the tax (devBps), always paid to the dev; anyone may push it
  if (Number(raw.cfg.devBps) === 0) return fail('this module keeps no part of the tax for the dev (dev 0%): all of it is the buyers\' pool', { token })
  const sim = await simulateCountdown(ctx.client, me, raw.module, COUNTDOWN_ABI, 'claimDev', [])
  if (sim.failed) return out({ success: false, step: 'countdown-claim-dev', token, module: raw.module, ...sim.failed, ...(sim.failed.error === 'NothingToClaim' && { hint: 'nothing is owed to the dev yet: its part comes from the tax as it is sold' }) })
  const data = encodeFunctionData({ abi: COUNTDOWN_ABI, functionName: 'claimDev', args: [] })
  return out(step(ctx, { from: me, to: raw.module, data }, {
    chainId, token, module: raw.module, step: 'countdown-claim-dev', amount: f(sim.result), quote: sym, to: raw.dev,
    note: `sends the dev its ${Number(raw.cfg.devBps) / 100}% part of the tax booked so far (always to the dev ${raw.dev}; anyone may push it)`,
  }, flag('calldata'), summarize))
}
