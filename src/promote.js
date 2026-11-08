import { createPublicClient, concat, encodeAbiParameters, encodeFunctionData, getAddress, isAddress, isHash, keccak256, parseAbi, zeroAddress } from 'viem'
import { API, get as apiGet } from './discover.js'
import { atTokenPad, gangGens, KIND_UNREAD, NOT_ON_MAINNET, padNets, PAD3_GEN, rpcTransport } from './gangpad.js'
import { walletFor } from './fair.js'
import { revertOf as revertIn, step, units } from './steps.js'

/**
 * `gang promote …`, `gang create … --promote <pct>` and `gang buy … --promoter <addr>`: the promoter share on GangLaunchpad 3.0
 * (docs/SPEC-PROMOTER-SHARE-2026-11-04.md, docs/SPEC-PROMOTER-POOL-SHARE-2026-11-05.md).
 * A dev sets a share of its creator fee and a window at create, fixed for good. A wallet is bound to a promoter by its
 * first trade of the token, only through `buyWithPromoter`, called directly from the wallet on the curve. On every curve
 * trade of a bound wallet inside the window the promoter accrues that share of the creator's fee on the pad.
 * On a taxed token whose recipient is the dev's GangPromotePoolModule (`promote-pool-v1`), it also earns that share of the
 * recipient's part of the pool tax after graduation: the module escrows it, a settler posts Merkle roots of cumulative
 * amounts (2-day dispute window, the Safe can veto), and each account claims with its proof. The dev gets the rest at once.
 * What this CLI is told by gang.fun about a root is never trusted: each proof is checked against the root read on chain.
 * Env: GANG_PROMOTE_POOL_FACTORY / GANG_TESTNET_PROMOTE_POOL_FACTORY override the factory (gangpad.js).
 */
export const PROMOTE_POOL_TYPE = 'promote-pool-v1'
export const MIN_WINDOW_DAYS = 7
export const MAX_WINDOW_DAYS = 90
export const DEFAULT_WINDOW_DAYS = 30
const MAX_SHARE_BPS = 5_000
const BPS = 10_000
const DAY = 86_400
const BATCH = 200
const MAX_SCAN = 2_000

export const PROMOTE_PAD_ABI = parseAbi([
  'function promoteOf(address token) view returns (uint16 shareBps, uint32 window)',
  'function bindingOf(address token, address wallet) view returns (address promoter, uint40 boundAt, bool traded)',
  'function promoterFeeOf(address token, address promoter) view returns (uint256)',
  'function canBind(address token, address wallet, address promoter) view returns (bool)',
  'function buyWithPromoter(address token, uint256 funds, uint256 minAmount, address promoter) payable returns (uint256 amountOut, uint256 fundsUsed)',
  'function claimPromoterFee(address token, address to) returns (uint256 amount)',
  'error BadPromoteTerms()', 'error TraderNotOrigin()', 'error NotCurveToken()', 'error BadMsgValue()', 'error ZeroAmount()',
  'event PromoteSet(address indexed token, uint16 shareBps, uint32 window)',
  'event PromoterBound(address indexed token, address indexed wallet, address indexed promoter)',
  'event PromoterFeeAccrued(address indexed token, address indexed promoter, address indexed wallet, uint256 amount)',
  'event PromoterFeeClaimed(address indexed token, address indexed promoter, address indexed to, uint256 amount)',
])

const ERRORS = [
  'error ZeroAddress()', 'error NotClone()', 'error NotFactory()', 'error AlreadyInitialized()', 'error AlreadyBound()', 'error NotBound()',
  'error NotCurve()', 'error NotCreator()', 'error NotRecipient()', 'error NotPromoted()', 'error AllDividends()', 'error AlreadyGraduated()',
  'error NotSettler()', 'error NotVetoer()', 'error NotDev()', 'error BadRoot()', 'error BadAllocated()', 'error BadThroughBlock()',
  'error PostPending()', 'error NothingPending()', 'error TooEarly()', 'error TooLate()', 'error BadProof()', 'error NothingToClaim()',
  'error OverAllocated()', 'error BadReceiver()', 'error StillActive()', 'error Closed()', 'error NothingOwed()', 'error BoundQuote()',
  'error PushStarved()',
]

export const POOL_FACTORY_ABI = parseAbi([
  'function create(bytes32 salt) returns (address module)',
  'function predict(address dev, bytes32 salt) view returns (address)',
  'function pad() view returns (address)',
  'function implementation() view returns (address)',
  'error NotAgent()', 'error WrongHandler()',
  'event Created(address indexed dev, address indexed module)',
  ...ERRORS,
])

export const POOL_ABI = parseAbi([
  'function moduleType() view returns (bytes32)',
  'function factory() view returns (address)',
  'function dev() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function shareBps() view returns (uint16)',
  'function window() view returns (uint32)',
  'function closed() view returns (bool)',
  'function escrowOpen() view returns (bool)',
  'function firstGradSeenAt() view returns (uint64)',
  'function lastPostAt() view returns (uint64)',
  'function escrowIn() view returns (uint256)',
  'function reclaimed() view returns (uint256)',
  'function claimedTotal() view returns (uint256)',
  'function devOwed() view returns (uint256)',
  'function undistributed() view returns (uint256)',
  'function root() view returns (bytes32)',
  'function allocatedTotal() view returns (uint256)',
  'function throughBlock() view returns (uint64)',
  'function pendingRoot() view returns (bytes32)',
  'function pendingAllocated() view returns (uint256)',
  'function pendingThroughBlock() view returns (uint64)',
  'function pendingActiveAt() view returns (uint64)',
  'function claimed(address account) view returns (uint256)',
  'function SETTLER_SILENCE() view returns (uint64)',
  'function ESCROW_GRACE() view returns (uint64)',
  'function bind(address token)',
  'function work(uint256 minOut)',
  'function activate()',
  'function sweep(address asset) returns (uint256 amount)',
  'function claim(uint256 cumulative, bytes32[] proof, address to) returns (uint256 amount)',
  'function reclaim(address to) returns (uint256 amount)',
  'function releaseDev(address to) returns (uint256 amount)',
  'event Bound(address indexed token, address indexed quote, uint16 shareBps, uint32 window)',
  'event Split(uint256 incoming, uint256 toEscrow, uint256 toDev)',
  'event DevOwed(uint256 amount)',
  'event DevReleased(address indexed to, uint256 amount)',
  'event RootPosted(bytes32 indexed root, uint256 allocatedTotal, uint64 throughBlock, uint64 activeAt, string uri)',
  'event RootActivated(bytes32 indexed root, uint256 allocatedTotal, uint64 throughBlock)',
  'event RootVetoed(bytes32 indexed root)',
  'event Claimed(address indexed account, address indexed to, uint256 amount)',
  'event Reclaimed(address indexed to, uint256 amount)',
  'event Swept(address indexed asset, uint256 amount)',
  ...ERRORS,
])
/** gang tx decodes these. */
export const PROMOTE_EVENT_ABIS = [PROMOTE_PAD_ABI, POOL_FACTORY_ABI, POOL_ABI]

const PAD_READS = parseAbi([
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)',
  'function tokenCount() view returns (uint256)',
  'function allTokens(uint256) view returns (address)',
  'function isAgent(address) view returns (bool)',
])
const SYMBOL_ABI = parseAbi(['function symbol() view returns (string)'])

const GAS_NOTE = 'let the wallet estimate the gas limit (eth_estimateGas) and do not lower it: a push to the dev needs about 365k gas left before it, far more than the call uses'

export const HINTS = {
  NotAgent: 'only an Agent can create a V3 token, so only an Agent gets a promoter pool module',
  NotFactory: 'this factory is not allowed on the platform\'s GangHandlerAdmin yet, so it cannot list a module as a tax recipient. If GANG_PROMOTE_POOL_FACTORY / GANG_TESTNET_PROMOTE_POOL_FACTORY is set, check it',
  AlreadyBound: 'the module is bound to a token already',
  NotCurve: 'not a V3 (curve) token on this pad',
  NotCreator: 'the token was not created by this module\'s dev',
  NotRecipient: 'the token does not pay its tax to this module',
  NotPromoted: 'the token was not made with promoter terms (gang create … --promote)',
  AllDividends: 'all of the token\'s tax goes to holders, so the module would never receive anything',
  AlreadyGraduated: 'a module binds before graduation only: this token has no pool share, and gang promote sweep sends its income to the dev',
  NotBound: 'the module is not bound to a token yet',
  NotDev: 'only the dev this module was made for',
  NothingPending: 'no root is waiting',
  TooEarly: 'the root\'s 2-day dispute window is not over',
  BadProof: 'that amount and proof do not match the root in effect: fetch them again',
  NothingToClaim: 'this account has already claimed all the root gives it',
  OverAllocated: 'the root\'s total is used up: the leaves add up to more than it allows, so this claim reverts (report it to the platform)',
  BadReceiver: '--to cannot be zero or the module itself',
  StillActive: 'the settler has posted within the last 30 days, or the token has not graduated: reclaim opens after 30 days of silence once graduation was seen (a first gang promote work records it)',
  Closed: 'the dev reclaimed: the module is closed for good, and every arrival goes to the dev',
  NothingOwed: 'nothing of that asset here',
  BoundQuote: 'the module\'s own quote is split, not swept',
  PostPending: 'a root waits for its dispute window: reclaim opens after it took effect',
  PushStarved: `the tx's gas limit was too low: ${GAS_NOTE}`,
  BadPromoteTerms: `--promote takes 0.01–${MAX_SHARE_BPS / 100}%, --promote-days ${MIN_WINDOW_DAYS}–${MAX_WINDOW_DAYS}`,
  TraderNotOrigin: 'a promoter binds only on a buy sent directly from the wallet: no contract, router or aggregator',
  NotCurveToken: 'a promoter binds on the curve only: this token has graduated or isn\'t a V3 curve token',
}
export const revertOf = (e) => revertIn(e, [POOL_ABI, POOL_FACTORY_ABI, PROMOTE_PAD_ABI], HINTS)

export async function simulatePool(client, from, address, abi, functionName, args = []) {
  try {
    const { result } = await client.simulateContract({ account: from, address, abi, functionName, args })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

export function poolFactoryAddress(testnet) {
  return gangGens(testnet)[0].promotePoolFactory || null
}

export const poolNotDeployed = (testnet) =>
  `GangPromotePoolModuleFactory is not deployed on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} in this CLI version, so the promoter share can't reach the pool yet. Set ${testnet ? 'GANG_TESTNET_PROMOTE_POOL_FACTORY' : 'GANG_PROMOTE_POOL_FACTORY'} to its address, or name a recipient with --recipient (the share then stays on the curve)`

const PCT_RE = /^(\d{1,3})(?:\.(\d{1,2}))?$/

/** --promote <pct> and --promote-days <n> → { shareBps, windowDays, window } or { error }. Pure. */
export function parsePromote(raw, daysRaw) {
  const usage = `--promote takes the promoter's share of your creator fee in %, 0.01–${MAX_SHARE_BPS / 100}, up to 2 decimals (e.g. --promote 20)`
  const m = PCT_RE.exec(String(raw ?? '').trim())
  if (!m) return { error: usage, got: raw ?? null }
  const shareBps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  if (shareBps < 1 || shareBps > MAX_SHARE_BPS) return { error: usage, got: raw }
  const d = daysRaw === undefined ? DEFAULT_WINDOW_DAYS : Number(daysRaw)
  if (!Number.isInteger(d) || d < MIN_WINDOW_DAYS || d > MAX_WINDOW_DAYS) {
    return { error: `--promote-days takes whole days, ${MIN_WINDOW_DAYS}–${MAX_WINDOW_DAYS}`, got: daysRaw }
  }
  return { shareBps, windowDays: d, window: d * DAY }
}

/** Does this create's flags ask for the pool module? --promote on a taxed V3 token with no recipient or other module named. Pure. */
export function wantsPoolModule(kind, flag, opt) {
  if (kind !== 'v3' || !flag('promote') || flag('recipient') || flag('vault')) return false
  if (flag('buyback') || flag('split') || flag('lp') || flag('tax-cap')) return false
  const zero = (f) => !flag(f) || /^0*(\.0*)?$/.test(opt(f) ?? '')
  if (zero('buy-tax') && zero('sell-tax')) return false
  return !/^0*100(\.0+)?$/.test(opt('dividend', '0'))
}

/** What a --promote create says it does. `pool`: the token's recipient is a promoter pool module. Pure. */
export function promoteLine({ shareBps, windowDays, pool, taxed, dividendPct = 0 }) {
  const pct = shareBps / 100
  const curve = `${pct}% of your creator fee goes to the promoter of each bound wallet, on that wallet's curve trades for ${windowDays} days after it binds; you keep the rest. Fixed for good. A wallet binds only by its first buy, sent directly with gang promote buy --promoter (never through a router or aggregator)`
  if (pool) {
    const onTax = (pct * (100 - dividendPct)) / 100
    return `${curve}. After graduation the promoter also earns ${pct}% of the recipient's part of those wallets' pool tax (about ${onTax}% of the tax left after the platform's part): the module escrows ${pct}% of each arrival and pushes the rest to you, and a settler posts who gets what, with a 2-day dispute window. What the escrow holds for trades with no promoter is yours too, but only once you claim it: gang promote claim-pool. A trade counts for the promoter only if the bound wallet itself moves the tokens, or calls a listed router directly: tokens moved to another address first, or sold through an unlisted contract, don't count; nor does tax still unsold when escrow ends. Escrow ends about ${windowDays + 7} days after graduation (counted from the first split that sees it). If the settler is silent for 30 days after graduation you can reclaim what no root allocated, which closes the module. The module can't be combined with --buyback / --lp / --split / --tax-cap`
  }
  if (taxed && dividendPct === 100) return `${curve}. Curve only: all of this token's tax goes to holders, so there is no recipient's part to share`
  return `${curve}. Curve only: ${taxed ? 'this token\'s tax goes to another recipient, so promoters earn nothing from its pool tax (a token has one recipient: to share it, launch with no --recipient, --buyback, --lp, --split or --tax-cap)' : 'an untaxed token has no pool tax to share'}`
}

// --- the Merkle tree the settler posts: OpenZeppelin StandardMerkleTree leaves and sorted pairs

export function leafOf(account, cumulative) {
  return keccak256(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(account), BigInt(cumulative)])))
}

export function verifyProof(root, leaf, proof) {
  let h = leaf
  for (const p of proof) h = BigInt(h) < BigInt(p) ? keccak256(concat([h, p])) : keccak256(concat([p, h]))
  return h.toLowerCase() === String(root).toLowerCase()
}

/** The amount gang.fun's `active` gives `account`, or null when it doesn't prove out against `root`, a malformed answer included. */
export function provenAmount(root, account, active) {
  try {
    const c = BigInt(active.cumulative)
    return verifyProof(root, leafOf(account, c), active.proof) ? c : null
  } catch { return null }
}

const NO_ROOT = `0x${'00'.repeat(32)}`
const iso = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null)

/** The runtime code of an EIP-1167 clone of `impl`. */
export const cloneCode = (impl) => `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`.toLowerCase()

/**
 * A module of a known factory, for printing. null: not a clone of that factory's implementation, so nothing it says
 * counts: moduleType() and factory() are only what a contract says about itself. `getCode(addr)` reads the code.
 * The whole check for "this token has a pool share" (spec §2): the recipient is such a module and its token() is the token.
 */
export async function poolOf(read, getCode, module, factory) {
  if (!module || module === zeroAddress || !factory) return null
  // an RPC error throws: "not a module" would be an answer
  const [impl, code] = await Promise.all([read(factory, POOL_FACTORY_ABI, 'implementation'), getCode(module)])
  if (String(code ?? '').toLowerCase() !== cloneCode(impl)) return null
  const names = ['dev', 'token', 'quote', 'shareBps', 'window', 'closed', 'escrowOpen', 'firstGradSeenAt', 'lastPostAt', 'escrowIn', 'reclaimed',
    'claimedTotal', 'devOwed', 'undistributed', 'root', 'allocatedTotal', 'throughBlock', 'pendingRoot', 'pendingAllocated', 'pendingThroughBlock', 'pendingActiveAt']
  const vals = await Promise.all(names.map((n) => read(module, POOL_ABI, n)))
  const s = Object.fromEntries(names.map((n, i) => [n, vals[i]]))
  return { module, ...s, token: s.token === zeroAddress ? null : s.token, quote: s.quote === zeroAddress ? null : s.quote }
}

/** The module's state in units (pure apart from `f`). `f(x)`: amount to string in its quote. `now`: seconds. */
export function formatPool(s, f, now, ref = '') {
  const pending = s.pendingRoot !== NO_ROOT
  const due = pending && Number(s.pendingActiveAt) <= now
  const next = []
  if (due) next.push(`gang promote activate ${ref} (anyone: the root's dispute window is over)`)
  if (s.undistributed > 0n) next.push(`gang promote work ${ref} (anyone: split what arrived)`)
  if (s.devOwed > 0n) next.push(`gang promote release-dev ${ref} (the dev)`)
  return {
    module: s.module, moduleType: PROMOTE_POOL_TYPE, dev: s.dev, boundToken: s.token, quote: s.quote, sharePct: Number(s.shareBps) / 100,
    windowDays: Number(s.window) / DAY, closed: s.closed, escrowOpen: s.escrowOpen,
    graduationSeenAt: iso(s.firstGradSeenAt), lastPostAt: iso(s.lastPostAt),
    escrowed: f(s.escrowIn), reclaimed: f(s.reclaimed), claimedTotal: f(s.claimedTotal), devOwed: f(s.devOwed), waitingToSplit: f(s.undistributed),
    root: s.root === NO_ROOT ? null : { root: s.root, allocated: f(s.allocatedTotal), throughBlock: Number(s.throughBlock) },
    pending: pending ? { root: s.pendingRoot, allocated: f(s.pendingAllocated), throughBlock: Number(s.pendingThroughBlock), activeAt: iso(s.pendingActiveAt), due } : null,
    ...(next.length && { next }),
  }
}

/** The wallet's binding as printed: what is left of its window (`window`, `now`: seconds). Pure. */
export function formatBinding(promoter, boundAt, traded, window, now, graduated = false) {
  if (!traded) {
    return { promoter: null, traded: false, note: graduated ? 'this wallet never traded the token on the curve, and it has graduated: it can\'t bind now' : 'this wallet has not traded the token: its first buy can name a promoter' }
  }
  if (promoter === zeroAddress) return { promoter: null, traded: true, note: 'this wallet traded the token with no promoter: it can never bind now' }
  const ends = Number(boundAt) + Number(window)
  return { promoter, boundAt: iso(boundAt), windowEnds: iso(ends), inWindow: now < ends, traded: true }
}

/**
 * --promoter on a buy: the reason it can't bind (the pad would drop it without a word, and the buy would go on), else null.
 * Pure over the reads. `b`: bindingOf; `terms`: promoteOf.
 */
export function whyNoBind({ me, promoter, creator, shareBps, boundPromoter, traded, promoterIsAgent, canBind }) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
  if (Number(shareBps) === 0) return 'this token was made without promoter terms: nobody earns from a --promoter here'
  if (same(promoter, me)) return '--promoter is this wallet itself: a wallet cannot be its own promoter'
  if (same(promoter, creator)) return '--promoter is the token\'s creator, who cannot be a promoter of its own token'
  if (traded) {
    return boundPromoter && boundPromoter !== zeroAddress
      ? `this wallet is already bound to ${boundPromoter} for good: its trades pay that promoter. Drop --promoter`
      : 'this wallet already traded this token: a wallet binds only by its first trade. Drop --promoter'
  }
  if (promoterIsAgent === false) return '--promoter holds no Agent ID: the pad would ignore it'
  if (canBind === false) return 'the pad would not bind this promoter (canBind is false): drop --promoter'
  return null
}

// a timeout or a 429 says nothing about the token: reading it as "no terms" would send a buyer to a plain buy, which can never bind
const UNREAD_TERMS = 'could not read the promoter terms (RPC error). Nothing was built. Run the same command again; don\'t switch to a plain gang buy: a first buy without a promoter can never bind later'
// only a revert: a node that is behind can answer an eth_call with empty data for a pad that has the function
export const isMissingRead = (e) => !!revertOf(e)

/** Reads what --promoter needs; { promoter, refuse?, retry? } with the promoter checksummed. `ctx` is on the token's pad. */
export async function checkPromoter(ctx, { token, me, raw, creator }) {
  const promoter = getAddress(raw)
  let shareBps, b, can, agent
  try {
    [[shareBps], b, can, agent] = await Promise.all([
      ctx.read(ctx.pad, PROMOTE_PAD_ABI, 'promoteOf', [token]),
      ctx.read(ctx.pad, PROMOTE_PAD_ABI, 'bindingOf', [token, me]),
      ctx.read(ctx.pad, PROMOTE_PAD_ABI, 'canBind', [token, me, promoter]),
      ctx.read(ctx.pad, PAD_READS, 'isAgent', [promoter]),
    ])
  } catch (e) {
    if (!isMissingRead(e)) return { promoter, refuse: UNREAD_TERMS, retry: 'same command again' }
    return { promoter, refuse: `GangLaunchpad ${ctx.gen ?? ctx.pad} has no promoter share (only a 3.0 pad upgraded for it does)` }
  }
  const refuse = whyNoBind({ me, promoter, creator, shareBps, boundPromoter: b[0], traded: b[2], promoterIsAgent: agent, canBind: can })
  return { promoter, ...(refuse && { refuse }) }
}

/** { sharePct, windowDays } of a token (0 share: none), null when the pad has no promoter share. Throws on an RPC error. */
export async function promoteTermsOf(ctx, token) {
  try {
    const [shareBps, window] = await ctx.read(ctx.pad, PROMOTE_PAD_ABI, 'promoteOf', [token])
    return { shareBps: Number(shareBps), sharePct: Number(shareBps) / 100, windowDays: Number(window) / DAY }
  } catch (e) {
    if (isMissingRead(e)) return null
    throw e
  }
}

/**
 * For a plain curve buy: the wallet's first trade of a token with promoter terms is its only chance to bind. Advice on a
 * preview, so an unread answer just says nothing.
 */
export async function firstBuyWarning(ctx, token, me) {
  try {
    const [[shareBps], b] = await Promise.all([
      ctx.read(ctx.pad, PROMOTE_PAD_ABI, 'promoteOf', [token]),
      ctx.read(ctx.pad, PROMOTE_PAD_ABI, 'bindingOf', [token, me]),
    ])
    if (Number(shareBps) === 0 || b[2]) return null
    return `this token has a promoter share and this is this wallet's first trade of it: without a promoter it can never bind later. If the user came from an invite link (…?promoter=0x…), build this buy with gang promote buy --promoter <that address> instead`
  } catch { return null }
}

/** For gang info / status: the token's promoter terms and whether they reach the pool. null without terms. */
export async function promoteField(ctx, token, { recipient, dividendPct = 0, testnet } = {}) {
  let t
  try { t = await promoteTermsOf(ctx, token) } catch { return { error: 'could not read the promoter terms (RPC error): this doesn\'t mean there are none', retry: 'same command again' } }
  if (!t || t.shareBps === 0) return null
  const pool = await poolOf(ctx.read, (a) => ctx.client.getCode({ address: a }), recipient, poolFactoryAddress(testnet)).catch(() => null)
  const live = !!pool && pool.token?.toLowerCase() === token.toLowerCase() && !pool.closed
  return {
    sharePct: t.sharePct, windowDays: t.windowDays, poolShare: live,
    ...(live && { module: pool.module, escrowOpen: pool.escrowOpen, poolPct: (t.sharePct * (100 - dividendPct)) / 100 }),
    next: `gang promote status --token ${token}${testnet ? ' --testnet' : ''}`,
  }
}

const SUBS = ['buy', 'status', 'earnings', 'claim', 'claim-pool', 'activate', 'work', 'bind', 'reclaim', 'release-dev', 'sweep']
const USAGE = `usage: gang promote ${SUBS.join('|')} [--token <addr> | --module <addr>] [--to <addr>] [--from <wallet>] [--testnet] — see gang help`

function promoteCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

/** gang.fun's answers, or { error } (a claim can still go on with --cumulative and --proof). */
async function apiOr(path) {
  try {
    const r = await apiGet(path, undefined, '')
    return r ?? { error: `gang.fun has no answer at ${API}${path.split('?')[0]}` }
  } catch (e) { return { error: e.message } }
}

/** Every 3.0 token where `who` has a curve share to claim; read on chain, as gang creator-fee does. */
async function curveEarnings(ctx, who) {
  const pads = ctx.gens.filter((g) => g.gen === PAD3_GEN)
  const tokens = []
  let unread = 0
  for (const g of pads) {
    const n = Number(await ctx.read(g.pad, PAD_READS, 'tokenCount'))
    const take = Math.min(n, MAX_SCAN)
    const multi = (contracts, allowFailure = true) => ctx.client.multicall({ contracts, allowFailure, batchSize: 0 })
    for (let from = 0; from < take; from += BATCH) {
      const idx = Array.from({ length: Math.min(BATCH, take - from) }, (_, i) => BigInt(n - 1 - from - i))
      const addrs = await multi(idx.map((i) => ({ address: g.pad, abi: PAD_READS, functionName: 'allTokens', args: [i] })), false)
      const fees = await multi(addrs.map((t) => ({ address: g.pad, abi: PROMOTE_PAD_ABI, functionName: 'promoterFeeOf', args: [t, who] })))
      const due = addrs.map((t, i) => ({ t, owed: fees[i].result, ok: fees[i].status === 'success' }))
      // a pad before the upgrade answers none of them: no share to report there
      if (!due.some((x) => x.ok)) break
      unread += due.filter((x) => !x.ok).length
      for (const { t, owed } of due.filter((x) => x.owed > 0n)) {
        const [, quote] = await ctx.read(g.pad, PAD_READS, 'curves', [t])
        const symbol = await ctx.read(t, SYMBOL_ABI, 'symbol').catch(() => null)
        tokens.push({ token: t, symbol, quote: await ctx.read(quote, SYMBOL_ABI, 'symbol').catch(() => quote), claimable: await units(ctx, quote, owed) })
      }
    }
  }
  return { tokens, ...(unread && { unreadNote: `${unread} token(s) could not be read (RPC); run it again to include them` }) }
}

/** Entry for `gang promote <sub>`. io: { opt, flag, out, fail, summarize } from index.js. */
export async function runPromote(sub, { opt, flag, out, fail, summarize }) {
  // buy runs in index.js, on the path of gang buy
  if (!SUBS.includes(sub) || sub === 'buy') return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const rawOnly = flag('calldata')
  const tn = testnet ? ' --testnet' : ''
  let ctx
  try { ctx = promoteCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)
  const me = () => walletFor(ctx, opt('from'))
  const getCode = (a) => ctx.client.getCode({ address: a })
  const toArg = () => {
    if (!flag('to')) return me()
    const to = opt('to')
    if (!isAddress(to ?? '') || to === zeroAddress) fail('--to must be a 0x address', { got: to ?? null })
    return getAddress(to)
  }

  if (sub === 'earnings') {
    const who = getAddress(me())
    const curve = await curveEarnings(ctx, who).catch((e) => ({ error: e.shortMessage || e.message.split('\n')[0] }))
    const pool = await apiOr(`/promote-pool/earnings?${new URLSearchParams({ account: who })}`)
    const modules = []
    for (const m of (pool.modules ?? [])) {
      if (!isAddress(m.module ?? '')) continue
      const c = await poolOf(ctx.read, getCode, m.module, poolFactoryAddress(testnet)).catch(() => null)
      if (!c?.quote) continue
      const done = await ctx.read(m.module, POOL_ABI, 'claimed', [who]).catch(() => null)
      if (done === null) continue
      let total
      try { total = BigInt(m.cumulative ?? 0) } catch { continue }
      modules.push({
        module: m.module, token: c.token, quote: await ctx.read(c.quote, SYMBOL_ABI, 'symbol').catch(() => c.quote),
        allocated: await units(ctx, c.quote, total), claimed: await units(ctx, c.quote, done),
        claimable: await units(ctx, c.quote, total > done ? total - done : 0n),
        ...(/^\d+$/.test(String(m.pendingCumulative ?? '')) && { totalOnceInEffect: await units(ctx, c.quote, BigInt(m.pendingCumulative)) }),
        next: `gang promote claim-pool --module ${m.module}${tn}`,
      })
    }
    return out({
      success: true, chainId, wallet: who,
      curve: curve.error ? { error: curve.error, retry: `gang promote earnings${tn}` } : { ...curve, ...(curve.tokens.length && { next: `gang promote claim --token <addr>${tn}` }) },
      pool: pool.error ? { error: `gang.fun pool data unavailable (${pool.error})`, hint: `gang promote status --token <addr>${tn} still reads the chain` } : { modules },
      note: 'pool amounts come from gang.fun and are not checked here; a claim checks them against the root on chain',
    })
  }

  // --- one token or one module
  if (flag('token') && flag('module')) fail('give --token (its tax recipient is the module) or --module, not both')
  let token = null, module = null, creator = null, quote = null, dividendPct = 0, gradDone = false
  if (flag('module')) {
    if (sub === 'bind' || sub === 'claim') fail(`gang promote ${sub} needs --token <the token>`)
    module = opt('module')
    if (!isAddress(module ?? '')) fail('--module must be a promoter pool module address (0x…)', { got: module ?? null })
    module = getAddress(module)
  } else {
    token = opt('token')
    if (!isAddress(token ?? '')) fail('--token must be a V3 token address (0x…), or name the module with --module <addr>', { got: token ?? null })
    token = getAddress(token)
    if ((await atTokenPad(ctx, token)) === null) return fail(KIND_UNREAD.error, { token, retry: KIND_UNREAD.retry })
    try {
      const c = await ctx.read(ctx.pad, PAD_READS, 'curves', [token])
      if (c[0] === zeroAddress) throw new Error('not a curve')
      ;[creator, quote] = c
      gradDone = c[6]
      dividendPct = Number(c[9]) / 100
      module = (await ctx.read(ctx.pad, PAD_READS, 'taxConfigOf', [token]))[3]
    } catch {
      return fail(`not a V3 token on this pad (${testnet ? 'BSC testnet' : 'BSC mainnet'}${testnet ? '' : '; add --testnet for a testnet token'})`, { token, chainId })
    }
  }
  const ref = `${token ? `--token ${token}` : `--module ${module}`}${tn}`

  // the curve side needs only the pad
  if (sub === 'claim') {
    const who = me()
    const to = toArg()
    const owed = await ctx.read(ctx.pad, PROMOTE_PAD_ABI, 'promoterFeeOf', [token, who]).catch((e) => {
      if (isMissingRead(e)) return null
      return fail('could not read the promoter share (RPC error)', { token, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' })
    })
    if (owed === null) return fail(`GangLaunchpad ${ctx.gen ?? ctx.pad} has no promoter share (only a 3.0 pad upgraded for it does)`, { token })
    if (owed === 0n) return fail('this wallet has no curve share to claim on this token', { token, wallet: who, hint: `pool income is claimed with gang promote claim-pool ${ref}` })
    const sim = await simulatePool(ctx.client, who, ctx.pad, PROMOTE_PAD_ABI, 'claimPromoterFee', [token, to])
    if (sim.failed) return out({ success: false, step: 'claim-promoter-fee', ...sim.failed })
    const data = encodeFunctionData({ abi: PROMOTE_PAD_ABI, functionName: 'claimPromoterFee', args: [token, to] })
    return out(step(ctx, { from: who, to: ctx.pad, data }, {
      step: 'claim-promoter-fee', chainId, token, amount: await units(ctx, quote, owed), to,
      note: 'claims all of it, in the token\'s quote; it keeps growing with later curve trades of wallets you brought',
    }, rawOnly, summarize))
  }

  const factory = poolFactoryAddress(testnet)
  const s = await poolOf(ctx.read, getCode, module, factory).catch((e) => fail('could not read the module (RPC error)', { module, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' }))
  // the pool side: only a module of the factory this CLI knows, and bound to this very token
  const decoy = token && s?.token && s.token.toLowerCase() !== token.toLowerCase()
  const poolLive = !!s && !decoy && !s.closed
  const q = s?.quote ?? quote
  const f = async (x) => (q ? units(ctx, q, x) : x.toString())
  const now = Number((await ctx.client.getBlock({ blockTag: 'latest' })).timestamp)

  if (sub === 'status') {
    if (!token && !s) return fail('not a promoter pool module of this CLI\'s factory', { module, factory })
    let t = null
    if (token) {
      try { t = await promoteTermsOf(ctx, token) } catch (e) { return fail('could not read the promoter terms (RPC error)', { token, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' }) }
    }
    if (token && !t) return fail(`GangLaunchpad ${ctx.gen ?? ctx.pad} has no promoter share (only a 3.0 pad upgraded for it does)`, { token })
    const who = flag('from') || flag('wallet') ? (opt('wallet') ?? opt('from')) : (() => { try { return me() } catch { return null } })()
    const wallet = isAddress(who ?? '') ? getAddress(who) : null
    const res = {
      success: true, chainId, ...(token && { token, sharePct: t.sharePct, windowDays: t.windowDays, graduated: gradDone }),
      ...(token && t.shareBps === 0 && { note: 'this token was made without promoter terms' }),
    }
    if (token && t.shareBps > 0 && wallet) {
      const [b, fee] = await Promise.all([ctx.read(ctx.pad, PROMOTE_PAD_ABI, 'bindingOf', [token, wallet]), ctx.read(ctx.pad, PROMOTE_PAD_ABI, 'promoterFeeOf', [token, wallet])])
      res.wallet = wallet
      res.binding = formatBinding(b[0], b[1], b[2], t.windowDays * DAY, now, gradDone)
      res.curve = { claimable: await units(ctx, quote, fee), ...(fee > 0n && { next: `gang promote claim ${ref}` }) }
    }
    if (s) {
      const pool = formatPool({ ...s, escrowIn: s.escrowIn }, (x) => x, now, ref)
      const conv = async (k) => { pool[k] = await f(pool[k]) }
      await Promise.all(['escrowed', 'reclaimed', 'claimedTotal', 'devOwed', 'waitingToSplit'].map(conv))
      if (pool.root) pool.root.allocated = await f(pool.root.allocated)
      if (pool.pending) pool.pending.allocated = await f(pool.pending.allocated)
      res.pool = pool
      if (decoy) res.pool.warning = `this token pays its tax to the module, but the module is bound to another token (${s.token}): this token's promoters earn nothing from the pool`
    } else if (token) {
      res.pool = { poolShare: false, note: 'this token\'s tax recipient is not a promoter pool module of this CLI\'s factory: the share stays on the curve' }
    }
    if (s && wallet) {
      const done = await ctx.read(s.module, POOL_ABI, 'claimed', [wallet])
      const a = await apiOr(`/promote-pool/proof?${new URLSearchParams({ module: s.module, account: wallet })}`)
      // gang.fun's amount counts only with a proof of the root on chain; a bad answer costs this part, not the chain's data
      // a root past its dispute window that nobody activated yet is in effect for gang.fun, and claim-pool activates it first
      const due = s.pendingRoot !== NO_ROOT && Number(s.pendingActiveAt) <= now
      const active = a.active && (provenAmount(s.root, wallet, a.active) ?? (due ? provenAmount(s.pendingRoot, wallet, a.active) : null))
      const pendingAmount = /^\d+$/.test(String(a.pending?.cumulative ?? '')) ? BigInt(a.pending.cumulative) : null
      res.poolClaim = a.error
        ? { claimed: await f(done), error: `gang.fun pool data unavailable (${a.error})` }
        : {
          claimed: await f(done),
          ...(active !== null && active !== undefined && { allocated: await f(active), ...(active > done && { next: `gang promote claim-pool ${ref}` }) }),
          ...(a.active && active === null && { warning: 'gang.fun\'s amount does not match the root on chain: not shown. Try again shortly' }),
          ...(pendingAmount !== null && { totalOnceInEffect: await f(pendingAmount), totalOnceInEffectNote: 'this account\'s whole total under the root in its dispute window, not an addition; from gang.fun, unchecked', activeAt: iso(a.pending.activeAt) }),
        }
    }
    return out(res)
  }

  if (!s) {
    return fail(token ? 'this token\'s tax recipient is not a promoter pool module of this CLI\'s factory' : 'not a promoter pool module of this CLI\'s factory',
      { ...(token && { token }), recipient: module === zeroAddress ? null : module, factory })
  }
  if (decoy) return fail(`the module is bound to another token (${s.token}), not this one: nothing here is owed to this token's promoters`, { token, module })

  const who = me()
  const send = async (functionName, args, extra) => {
    const sim = await simulatePool(ctx.client, who, s.module, POOL_ABI, functionName, args)
    if (sim.failed) return out({ success: false, step: extra.step, ...sim.failed })
    const data = encodeFunctionData({ abi: POOL_ABI, functionName, args })
    // no gas field: the wallet / node estimates it (GAS_NOTE)
    return out(step(ctx, { from: who, to: s.module, data }, { chainId, ...(token && { token }), module: s.module, ...extra }, rawOnly, summarize))
  }

  if (sub === 'bind') {
    if (s.token) return fail('already bound', { boundTo: s.token })
    return send('bind', [token], { step: 'bind', note: 'anyone may bind (once), before graduation only. A token bound later has no pool share' })
  }

  if (sub === 'activate') {
    if (s.pendingRoot === NO_ROOT) return fail(HINTS.NothingPending, { module: s.module })
    if (Number(s.pendingActiveAt) > now) return fail(HINTS.TooEarly, { module: s.module, activeAt: iso(s.pendingActiveAt) })
    return send('activate', [], { step: 'activate', root: s.pendingRoot, note: 'anyone may: puts the root in effect now its dispute window is over' })
  }

  if (sub === 'work') {
    if (s.undistributed === 0n && !(gradDone && Number(s.firstGradSeenAt) === 0)) return fail('nothing has arrived since the last split', { module: s.module, ...(token && { token }) })
    return send('work', [0n], {
      step: 'work', amount: await f(s.undistributed),
      note: `anyone may: ${s.escrowOpen ? `escrows ${Number(s.shareBps) / 100}% of what arrived and pushes the rest to the dev` : 'escrow is over: all of it goes to the dev'}. Gas: ${GAS_NOTE}`,
    })
  }

  if (sub === 'sweep') {
    const a = opt('asset')
    if (!isAddress(a ?? '') || a === zeroAddress) fail('--asset must be a token address (0x…)', { got: a ?? null })
    return send('sweep', [getAddress(a)], { step: 'sweep', asset: getAddress(a), note: 'anyone may: sends the module\'s whole balance of that asset to the dev. Never the bound quote' })
  }

  if (sub === 'release-dev') {
    if (s.devOwed === 0n) return fail(HINTS.NothingOwed, { module: s.module })
    const to = toArg()
    return send('releaseDev', [to], { step: 'release-dev', amount: await f(s.devOwed), to, note: 'the dev only: sends what failed pushes left here' })
  }

  if (sub === 'reclaim') {
    if (s.dev.toLowerCase() !== String(who).toLowerCase()) return fail(HINTS.NotDev, { dev: s.dev, wallet: who })
    if (s.closed) return fail(HINTS.Closed, { module: s.module })
    const to = toArg()
    // the simulation's answer: reclaim first activates a due root and splits what arrived
    const preview = await simulatePool(ctx.client, who, s.module, POOL_ABI, 'reclaim', [to])
    return send('reclaim', [to], {
      step: 'reclaim', to, ...(preview.result !== undefined && { amount: await f(preview.result) }),
      warning: 'PERMANENT: this closes the module for good. No more roots can be posted, promoters lose what no root allocated, and every later arrival goes to you. Roots in effect keep paying',
      note: `the dev only, once graduation was seen and the settler has been silent for 30 days. Gas: ${GAS_NOTE}`,
    })
  }

  // claim-pool
  const account = getAddress(who)
  const done = await ctx.read(s.module, POOL_ABI, 'claimed', [account])
  // a root whose window is over isn't in effect until something activates it: a claim would do it, but its proof must be for that root
  if (s.pendingRoot !== NO_ROOT && Number(s.pendingActiveAt) <= now) {
    return send('activate', [], {
      step: 'activate', root: s.pendingRoot, next: `re-run this same command after executing it: gang promote claim-pool ${ref}`,
      note: 'a newer root\'s dispute window is over: this puts it in effect first (anyone may), then the claim can use it',
    })
  }
  let cumulative, proof
  if (flag('cumulative')) {
    const raw = opt('cumulative')
    if (!/^\d+$/.test(raw ?? '')) fail('--cumulative takes the account\'s total in the root, in wei', { got: raw ?? null })
    cumulative = BigInt(raw)
    proof = String(opt('proof', '')).split(',').map((x) => x.trim()).filter(Boolean)
    if (proof.some((p) => !isHash(p))) fail('--proof takes comma-separated 32-byte hashes', { got: opt('proof') ?? null })
  } else {
    const a = await apiOr(`/promote-pool/proof?${new URLSearchParams({ module: s.module, account })}`)
    if (a.error) {
      return fail(`gang.fun pool data unavailable (${a.error})`, {
        hint: `anyone can recompute the root from chain logs (scripts/promote-settle in gang-launchpad), then gang promote claim-pool ${ref} --cumulative <wei> --proof <hash,hash>`,
      })
    }
    if (!a.active) {
      return fail('no root in effect names this account yet', {
        module: s.module, account,
        ...(s.root !== NO_ROOT && { hint: `if a root should name this account, gang.fun may be behind: try again, or recompute it from chain logs and give --cumulative and --proof` }),
        ...(/^\d+$/.test(String(a.pending?.cumulative ?? '')) && { totalOnceInEffect: await f(BigInt(a.pending.cumulative)), activeAt: iso(a.pending.activeAt), hint: 'claim after the dispute window' }),
      })
    }
    if (provenAmount(s.root, account, a.active) === null) {
      return fail('that amount and proof do not match the root on chain: nothing was built', {
        module: s.module, account, rootOnChain: s.root, hint: 'gang.fun may be behind the chain: try again shortly',
      })
    }
    cumulative = BigInt(a.active.cumulative)
    proof = a.active.proof
  }
  // the root on chain decides, not what gang.fun said
  if (s.root === NO_ROOT) return fail('no root is in effect on chain yet', { module: s.module })
  if (!verifyProof(s.root, leafOf(account, cumulative), proof)) {
    return fail('that amount and proof do not match the root on chain: nothing was built', {
      module: s.module, account, rootOnChain: s.root, hint: 'gang.fun may be behind the chain: try again shortly',
    })
  }
  if (cumulative <= done) return fail(HINTS.NothingToClaim, { module: s.module, account, claimed: await f(done) })
  const to = toArg()
  return send('claim', [cumulative, proof, to], {
    step: 'claim-pool', account, to, amount: await f(cumulative - done), cumulative: await f(cumulative), claimedBefore: await f(done), throughBlock: Number(s.throughBlock),
    note: 'claims what the root in effect gives this account beyond what it already claimed',
  })
}
