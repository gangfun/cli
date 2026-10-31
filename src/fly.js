import { createPublicClient, parseAbi, encodeFunctionData, decodeEventLog, formatUnits, parseEther, parseUnits, isAddress, zeroAddress } from 'viem'
import { defaultRefPool, dividendOf, VAULT_ABI, fundingStep as fund, parseAmount, parseIntIn, parseNum, poolSellQuote, POOL_SELL_HINT, revertOf as revertIn, roomyGas, ROUTER_ABI, ROUTER_HINTS, step, swapBackState, units, GAS_RESERVE } from './steps.js'
import { API, get as apiGet } from './discover.js'
import { walletFor } from './fair.js'
import { MERGED_ERRORS_ABI, MERGED_HINTS, padNets, rpcTransport } from './gangpad.js'
import { poolPayBnb, poolTrade } from './pool.js'

/**
 * `gang fly …` — 铸币飞轮 (Mint Flywheel, track `fly`): GangFlywheelPad, its own pad (kind 3) beside GangLaunchpad.
 * Before launch: 10,000 shares at one price (sale.basePrice), a quota per wallet (baseQuota + invite bonus), sell-back
 * at the mint price less an exit fee. The sale fills (or the creator opens it early at ≥ 30%), then anyone launches it
 * `launchDelay` later: a PancakeSwap pool at the mint price, with a protection window (Agent ID + a per-wallet buy cap).
 * After launch (sale.postMint) minting goes on at the tier price: the money goes into the pool (part of it buys), the
 * tokens are minted. Pool tax: buy 1%, sell 1–2%; holders who minted share part of it (the hold line, `holdBps`).
 * No GangBond and no buy-back splitter on these tokens (phase 1).
 * Contracts: gang-launchpad src/flywheel (GangFlywheelPad, FlywheelTaxHandler, GangMintToken; issue #75).
 * Two pad versions: V1 (the first pad) and V2 (FlyConfig adds guardBps / twapWindow; post-launch mints check only the
 * TWAP guard and the price above the pool). New tokens go to V2 once it is listed here; every other command uses the
 * token's own pad (token.launchpad()). The tax handler, token and token deployer are the same code on both.
 * Env: GANG_FLY_PAD / GANG_TESTNET_FLY_PAD override V1, GANG_FLY_PAD_V2 / GANG_TESTNET_FLY_PAD_V2 V2; the RPCs and the
 * GangRouter (pool trades) are GangLaunchpad's.
 */
export const FLY_PADS = {
  // V2 deployed 2026-10-31; creates go there (it says so while its migrator is unset: no fallback to V1)
  mainnet: { v1: '0x631e66560F4FAE4e486B65349edE48189E48B029', v2: '0x281889ad915c1A95ffc4922235c6314b3Cbd8a5a', startBlock: 130634782n },
  // V1: testnet set 2 (2026-10-30, after the pre-mainnet audit fixes); V2 from block 139842621 (2026-10-31)
  testnet: { v1: '0xD6482850aCAC74BA889804931Fc797294777951c', v2: '0x706973e4F08dBf1604Cf540d0168428521e0E3d6', startBlock: 139749672n },
}

// V1's FlyConfig; V2 appends guardBps and twapWindow (CFG_V2): a new create / checkConfig selector and Created topic
const CFG = '(uint256 raiseBnb, uint16 baseQuota, uint8 inviteBonus, uint8 maxPerTx, uint16 holdBps, uint16 mintFeeBps, uint16 exitFeeBps, uint16 devCutBps, uint16 buyBps, uint16 sellTaxBps, uint32 launchDelay, uint32 window, uint8 windowCapMul, bool postMint, uint8 tierMode, uint16 stepBps, uint32 stepShares, uint16 maxMulX100, uint16 supplyCapMul)'
const SALE = '(address creator, address quote, address gate, address pair, uint128 basePrice, uint64 totalShares, uint64 filledAt, uint64 progressAt, uint16 sold, uint16 creatorShares, uint16 markSold, uint16 baseQuota, uint16 holdBps, uint16 mintFeeBps, uint16 exitFeeBps, uint16 devCutBps, uint16 buyBps, uint32 launchDelay, uint32 window, uint8 inviteBonus, uint8 maxPerTx, uint8 windowCapMul, uint8 tierMode, uint16 stepBps, uint32 stepShares, uint16 maxMulX100, bool postMint, bool launched)'
export const FLY_PAD_ABI = parseAbi([
  `function create(string[4] text, address quote, address refPool, ${CFG} cfg, uint256 devShares) returns (address token)`,
  `function checkConfig(${CFG} cfg, uint256 devShares) view returns (bool ok, string reason)`,
  'function mint(address token, uint256 shares, uint256 minShares, address referrer) returns (uint256 spent)',
  'function mintWithBnb(address token, uint256 shares, uint256 minShares, address referrer) payable returns (uint256 spent)',
  'function withdraw(address token, uint256 shares, uint256 minPayout) returns (uint256 payout)',
  'function openEarly(address token)',
  'function launch(address token)',
  'function mintPost(address token, uint256 shares, uint256 minTokensOut, uint256 maxSpent, address referrer) returns (uint256 tokensOut, uint256 spent)',
  'function mintPostWithBnb(address token, uint256 shares, uint256 minTokensOut, address referrer) payable returns (uint256 tokensOut, uint256 spent)',
  'function claimDev(address token) returns (uint256 amount)',
  `function sales(address token) view returns (${SALE})`,
  'function accounts(address token, address user) view returns (uint32 preShares, uint32 used, uint32 bonus, bool minted, uint64 windowStart, uint128 windowSpent, uint256 baseline)',
  'function quotaLeft(address token, address user) view returns (uint256)',
  'function sharePrice(address token, uint256 shares) view returns (uint256)',
  'function previewMint(address token, address user, uint256 shares) view returns (uint256 accepted, uint256 cost, uint256 fee)',
  'function previewMintPost(address token, address user, uint256 shares) view returns (uint256 accepted, uint256 paid, uint256 fee, uint256 tokensOut, bool ok)',
  'function previewWithdraw(address token, address user, uint256 shares) view returns (uint256 payout, uint256 fee)',
  'function prices(address token) view returns (uint256 spot, uint256 blockStart, uint256 high, uint256 average)',
  'function exitFeeBpsOf(address token) view returns (uint256)',
  'function owedDev(address token) view returns (uint256)',
  'function kindOf(address token) view returns (uint8)',
  'function isAgent(address account) view returns (bool)',
  'function migrator() view returns (address)',
  'function taxHandler() view returns (address)',
  'function dividendVault() view returns (address)',
  'function agentGateEnabled() view returns (bool)',
  'function tokenCount() view returns (uint256)',
  'function allTokens(uint256) view returns (address)',
  'function logoURIOf(address token) view returns (string)',
  'error ZeroAddress()', 'error ZeroAmount()', 'error BadAmount()', 'error BadConfig(string reason)', 'error UnknownToken()',
  'error NotAgent()', 'error NotMinting()', 'error NotLaunched()', 'error NotFilled()', 'error TooEarly()', 'error OnlyCreator()',
  'error Slippage()', 'error PriceBelowAverage()', 'error PriceBelowRecentHigh()', 'error PriceAbovePool()', 'error PaceExceeded()',
  'error PostMintOff()', 'error MigratorNotSet()', 'error VaultFloorTooHigh()', 'error PriceTooSmall()', 'error NothingOwed()',
  'error BnbNotQuote()', 'error BnbShort()', 'error OnlyRouter()', 'error TraderNotOrigin()', 'error RouterNeedsGate()',
  'error TooFewShares()', 'error QuoteNotAllowed()', 'error RefPoolRequired()', 'error NoBridgePool()', 'error BridgeNotWbnb()',
  'error PoolNotFactory()', 'error QuoteNotInPool()', 'error PoolNoLiquidity()', 'error ThinReferencePool()', 'error NotContract()',
  'error UnknownPoolType()', 'error V3FactoryNotSet()', 'error FeeOnTransferQuote()', 'error CapExceeded()',
  `event Created(address indexed token, address indexed creator, string name, string symbol, string logoURI, address quote, uint256 basePrice, ${CFG} cfg)`,
  'event Minted(address indexed token, address indexed trader, uint256 shares, uint256 cost, uint256 fee, uint256 sold)',
  'event Withdrawn(address indexed token, address indexed trader, uint256 shares, uint256 payout, uint256 fee)',
  'event Referred(address indexed token, address indexed referrer, address indexed invitee, uint256 bonus)',
  'event Filled(address indexed token, uint256 sold, bool early)',
  'event Launched(address indexed token, address pair, uint256 poolTokens, uint256 poolQuote, uint256 devCut)',
  'event PostMinted(address indexed token, address indexed trader, uint256 shares, uint256 paid, uint256 fee, uint256 devCut, uint256 tokensOut, uint256 boughtQuote)',
  'event DevPaid(address indexed token, address indexed creator, uint256 amount)',
  'event DevOwed(address indexed token, address indexed creator, uint256 amount)',
  'event FeeOwed(address indexed quote, uint256 amount)',
  'event FeesFlushed(address indexed quote, uint256 amount)',
  'event ShareWriteFailed(address indexed token, address indexed user, uint256 share)',
])
const CFG_V2 = CFG.replace(/\)$/, ', uint16 guardBps, uint32 twapWindow)')
/** What only the V2 pad has (everything else in FLY_PAD_ABI is the same on both). */
export const FLY_PAD_V2_ABI = parseAbi([
  `function create(string[4] text, address quote, address refPool, ${CFG_V2} cfg, uint256 devShares) returns (address token)`,
  `function checkConfig(${CFG_V2} cfg, uint256 devShares) view returns (bool ok, string reason)`,
  'function postRulesOf(address token) view returns (uint16 guardBps, uint32 twapWindow)',
  `event Created(address indexed token, address indexed creator, string name, string symbol, string logoURI, address quote, uint256 basePrice, ${CFG_V2} cfg)`,
])
export const FLY_HANDLER_ABI = parseAbi([
  'function protectionOf(address token) view returns (uint64 until, address gate, uint256 cap)',
  'function boughtInWindow(address token, address user) view returns (uint256)',
  'function isOut(address token, address user) view returns (bool)',
  'function eligibleShare(address token, address user) view returns (uint256)',
  'function owedOf(address token) view returns (uint256)',
  'function release(address token) returns (uint256 amount)',
  'function blockRefOf(address token) view returns (uint32 blockNumber, uint224 price)',
  'function prevBlockStartOf(address token) view returns (uint256)',
  'error ProtectionNotAgent()', 'error ProtectionCapExceeded()', 'error PriceBelowReference()', 'error NothingOwed()',
  'error SellDuringFlashSwap()', 'error OutOfGas()',
  'event Launched(address indexed token, uint256 protectedUntil, address gate, uint256 cap, uint256 launchPrice)',
  'event Disqualified(address indexed token, address indexed user, uint256 balance, uint256 baseline)',
  'event Requalified(address indexed token, address indexed user)',
  'event TaxAccrued(address indexed token, address indexed from, address indexed to, uint256 taxAmount, uint256 accrued)',
  'event TaxChunkSold(address indexed token, uint256 taxTokens, uint256 quoteOut, uint256 holderUnits, bool swapBack)',
  'event TaxDistributed(address indexed token, uint256 taxTokens, uint256 quoteOut, uint256 toHolders, uint256 toPlatform, uint256 toDev)',
  'event TaxPaid(address indexed token, address indexed recipient, address indexed quote, uint256 amount)',
  'event TaxOwed(address indexed token, address indexed recipient, address indexed quote, uint256 amount)',
  'event PlatformOwed(address indexed quote, uint256 amount)',
  'event PlatformFlushed(address indexed quote, uint256 amount)',
  'event HolderConversionDeferred(address indexed token, uint256 units, uint256 quote)',
  'event ShareWriteFailed(address indexed token, address indexed user, uint256 share)',
])
const TOKEN_ABI = parseAbi([
  'function launchpad() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function mintRoom() view returns (uint256)',
  'function buyTaxBps() view returns (uint16)',
  'function sellTaxBps() view returns (uint16)',
  'error CapExceeded()', 'error TransfersLocked()',
])
const ERC721_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])
const PAIR_ABI = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)'])
const DEX_ABI = parseAbi(['function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)'])
const GANG_ROUTER_VIEW = parseAbi(['function pancakeRouter() view returns (address)'])

/** What `gang tx` decodes a 铸币飞轮 tx's logs with (the pad, the tax handler, the holder-reward vault). */
export const FLY_EVENT_ABIS = [FLY_PAD_ABI, FLY_PAD_V2_ABI, FLY_HANDLER_ABI, VAULT_ABI]

// platform constants (FlywheelLogic): the pad's own numbers, fixed in the contract
const TOTAL_SHARES = 10_000
const TOKENS_PER_SHARE = 100_000n * 10n ** 18n
const EARLY_OPEN_SHARES = 3_000
const LAUNCH_GRACE = 7 * 86_400
const STALE_AFTER = 7 * 86_400
const BUY_TAX_PCT = 1
const Q112 = 1n << 112n
const TIERS = ['flat', 'standard', 'linear']
// gas-limit floors (roomyGas; alone when a pending approve leaves nothing to estimate): a pool trade or post-launch mint
// can be the token's first pool touch in its block, which costs more than an estimate made against the block before.
// Chapel fork: a pool buy at its bare estimate (431k) ran out of gas inside the holder-share sync and used 428k with
// room; a sell that also sold a tax chunk ran out at 750k and used 661k with room (estimate 755k)
const GAS_FLOOR = { buy: 750_000n, sell: 1_200_000n, mintPost: 900_000n, launch: 3_500_000n }
const GAS_NOTE = 'gas limit set with room: a hot token\'s first trade in a block costs more than the estimate shows'

const HINTS = {
  BadConfig: 'a setting is out of bounds: see reason',
  NotAgent: 'this wallet holds no Agent ID; 铸币飞轮 is Agent-only',
  NotMinting: 'the sale no longer takes pre-launch mints / sell-backs (filled, opened early or launched): gang info shows its state',
  NotLaunched: 'the token has not launched yet',
  NotFilled: 'the sale has not filled (or been opened early) yet: nothing to launch',
  TooEarly: 'too early: launch waits launchDelay after the fill; open-early needs at least 30% (3,000 shares) sold',
  OnlyCreator: 'only the creator can open the sale early',
  Slippage: 'fewer shares / tokens than the minimum: the sale or the price moved; re-run to re-quote',
  PriceBelowAverage: 'the pool price is too far below its average (V1: 10% under 30 minutes; V2: the sale\'s guard under its TWAP window): post-launch mints pause until it recovers (gang info: postMint)',
  PriceBelowRecentHigh: 'the pool price is more than 10% below its recent high: post-launch mints pause until it recovers (the high decays 0.5% a minute)',
  PriceAbovePool: 'the mint price is more than 10% above the pool price right now (the pool just dropped): try again shortly',
  PaceExceeded: 'this wallet minted too much too fast: recent post-launch mints (decaying over 30 minutes) plus this one may be at most 2% of the pool\'s quote side; mint fewer shares or wait',
  PostMintOff: 'this sale has no post-launch minting: trade the token in the pool (gang buy / gang sell)',
  MigratorNotSet: 'the 铸币飞轮 pad is not open on this network yet',
  BnbShort: 'the BNB sent does not cover the mint (the tier price moved up): re-run to re-quote',
  BnbNotQuote: 'this sale is not WBNB-quoted: pay in its quote (leave out BNB payment)',
  TooFewShares: 'fewer than 3,000 shares are still held 7 days after the fill: the sale can no longer launch, only refund (gang withdraw)',
  NothingOwed: 'nothing is owed',
  CapExceeded: 'the token\'s supply cap is reached: post-launch minting is over, trade in the pool',
  ProtectionNotAgent: 'launch protection: only Agent ID holders can buy from the pool until it ends (gang info: protection.until)',
  ProtectionCapExceeded: 'launch protection: this buy goes past the wallet\'s protected buy cap (gang status: protection.capLeftTokens)',
  VaultFloorTooHigh: 'the platform\'s dividend vault requires a larger holding than this pad allows, so no sale can be created right now; ask gang to fix the vault setting',
  QuoteNotAllowed: '--quote must be WBNB or a listed 18-decimal ERC-20 (leave it out to use WBNB)',
  RefPoolRequired: 'this quote needs --ref-pool (a Pancake pool pricing it)',
  PriceTooSmall: 'the raise in this quote is too small to split into 10,000 shares',
  FeeOnTransferQuote: 'the quote token takes a fee on transfer; it cannot be used',
  RouterNeedsGate: 'this sale has no Agent gate, so router entries are off',
}
const revertOf = (e) => revertIn(e, [FLY_PAD_ABI, FLY_HANDLER_ABI, TOKEN_ABI, ROUTER_ABI, MERGED_ERRORS_ABI], { ...MERGED_HINTS, ...ROUTER_HINTS, ...HINTS })

/**
 * Network settings: GangLaunchpad's chain, RPCs, WBNB and GangRouter (pool trades), with the fly pads. ctx.pad /
 * ctx.version start as the create target (V2 when known, else V1); bindPad switches them to a token's own pad.
 */
export function flyCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  const fly = FLY_PADS[testnet ? 'testnet' : 'mainnet']
  const env = (n) => process.env[testnet ? `GANG_TESTNET_${n}` : `GANG_${n}`]
  const pads = [
    { address: env('FLY_PAD_V2') || fly.v2, version: 2 },
    { address: env('FLY_PAD') || fly.v1, version: 1 },
  ].filter((p) => p.address)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  // pool trades go through the GangRouter they were accepted with (1.0's), whatever generation GangLaunchpad creates on
  const router = (net.gens.find((g) => g.gen === '1.0') ?? net).router
  return {
    ...net, router, pads, pad: pads[0].address, version: pads[0].version, startBlock: fly.startBlock, client,
    read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }),
  }
}

/**
 * The fly pad `token` belongs to, or null (not a fly token on these pads). A GangMintToken names its pad
 * (launchpad()); other tokens are asked of each pad's kindOf. Throws on an RPC error.
 */
async function padOf(ctx, token) {
  const named = await ctx.read(token, TOKEN_ABI, 'launchpad').catch(() => null)
  const known = named && ctx.pads.find((p) => same(p.address, named))
  if (known) return known
  for (const p of ctx.pads) {
    if (Number(await ctx.read(p.address, FLY_PAD_ABI, 'kindOf', [token])) === 3) return p
  }
  return null
}

/** true when `token` is a 铸币飞轮 token on one of the pads; null on an RPC error. */
export async function isFlyToken(ctx, token) {
  try {
    return !!(await padOf(ctx, token))
  } catch {
    return null
  }
}

/** Point ctx at `token`'s own pad (V1 or V2); false when it is on neither. */
async function bindPad(ctx, token) {
  const p = await padOf(ctx, token)
  if (!p) return false
  ctx.pad = p.address
  ctx.version = p.version
  return true
}

/** The pad takes creates only once its migrator is set (mainnet: when the Safe opens it). */
export async function padOpen(ctx) {
  return (await ctx.read(ctx.pad, FLY_PAD_ABI, 'migrator')) !== zeroAddress
}
/** The create target has no migrator yet: say which pad, and that existing tokens are not affected. */
const closed = (ctx, testnet) => `the ${ctx.version === 2 ? 'V2 ' : ''}铸币飞轮 (Mint Flywheel) pad on BSC ${testnet ? 'testnet' : 'mainnet'} is not open yet (no migrator set), so it takes no creates right now; existing 铸币飞轮 tokens keep working${testnet ? '' : '. Use --testnet to try it there'}`

const symbolOf = async (ctx, token) => { try { return await ctx.read(token, TOKEN_ABI, 'symbol') } catch { return null } }
const pct = (bps) => Number(bps) / 100
/** The fewest tokens that keep a wallet in: the handler puts it out when balance × 10,000 < baseline × holdBps, so round up. */
const holdLine = (baseline, holdPct) => (baseline * BigInt(Math.round(holdPct * 100)) + 9_999n) / 10_000n
const minOf = (x, slippagePct) => (x * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n
/** The chain's time (the latest block's timestamp, read once per command): the rules are judged by it, not this machine's clock. */
const chainNow = (ctx) => (ctx.nowP ??= ctx.client.getBlock().then((b) => Number(b.timestamp), () => Math.floor(Date.now() / 1000)))
const iso = (t) => (t ? new Date(Number(t) * 1000).toISOString() : null)
/** A Q112 price (quote wei per token wei × 2^112) → quote per token, as a decimal string. */
const q112 = (p) => formatUnits((p * 10n ** 18n) / Q112, 18)
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const short = (e) => e?.shortMessage || String(e?.message || e).split('\n')[0]

/** The site's invite link for `token` (the site reads ?ref= and passes it to the wallet's first mint). */
export const inviteLink = (token, referrer) => `https://gang.fun/token/${token}?ref=${referrer}`

/** A sale as the pad stores it, with what it means now. null when the token is not on this pad. */
export async function saleOf(ctx, token) {
  const s = await ctx.read(ctx.pad, FLY_PAD_ABI, 'sales', [token])
  if (s.creator === zeroAddress) return null
  const [exitNowBps, quoteSymbol, t] = await Promise.all([ctx.read(ctx.pad, FLY_PAD_ABI, 'exitFeeBpsOf', [token]), symbolOf(ctx, s.quote), chainNow(ctx)])
  const filledAt = Number(s.filledAt)
  const launchAt = filledAt ? filledAt + Number(s.launchDelay) : null
  const graceEnds = filledAt ? launchAt + LAUNCH_GRACE : null
  const sold = Number(s.sold)
  // minting → filled (waiting for launch) → launched; a filled sale not launched within 7 days reopens sell-backs and
  // launches only while ≥ 3,000 shares are held (refund: below that it only refunds)
  const status = s.launched ? 'launched'
    : !filledAt ? 'minting'
      : t >= graceEnds ? (sold >= EARLY_OPEN_SHARES ? 'stalled' : 'refund')
        : 'filled'
  return {
    token, status, padVersion: ctx.version, pad: ctx.pad, creator: s.creator, quote: s.quote, quoteSymbol, gate: s.gate === zeroAddress ? null : s.gate,
    pair: s.pair === zeroAddress ? null : s.pair, launched: s.launched,
    sharePriceRaw: s.basePrice, sharePrice: await units(ctx, s.quote, s.basePrice),
    raise: await units(ctx, s.quote, s.basePrice * BigInt(TOTAL_SHARES)),
    tokensPerShare: formatUnits(TOKENS_PER_SHARE, 18),
    sold, totalShares: TOTAL_SHARES, sharesLeft: s.launched || filledAt ? 0 : TOTAL_SHARES - sold,
    mintedShares: Number(s.totalShares), creatorShares: Number(s.creatorShares),
    minWalletsLeft: s.launched || filledAt ? 0 : Math.ceil((TOTAL_SHARES - sold) / Number(s.baseQuota)),
    canOpenEarly: !s.launched && !filledAt && sold >= EARLY_OPEN_SHARES,
    filledAt: iso(filledAt), launchAt: iso(launchAt),
    ...(filledAt && !s.launched && {
      launchableNow: t >= launchAt && sold >= EARLY_OPEN_SHARES, launchIn: Math.max(0, launchAt - t),
      sellBackReopensAt: iso(graceEnds),
    }),
    sellBackOpen: !s.launched && (!filledAt || t >= graceEnds),
    progressAt: iso(Number(s.progressAt)),
    stale: !s.launched && Number(exitNowBps) === 0,
    exitFeeFreeIn: s.launched ? 0 : Math.max(0, Number(s.progressAt) + STALE_AFTER - t),
    rules: {
      baseQuota: Number(s.baseQuota), inviteBonus: Number(s.inviteBonus), maxPerTx: Number(s.maxPerTx),
      holdPct: pct(s.holdBps), mintFeePct: pct(s.mintFeeBps), exitFeePct: pct(s.exitFeeBps), exitFeeNowPct: pct(exitNowBps),
      devCutPct: pct(s.devCutBps), buyPct: pct(s.buyBps), buyTaxPct: BUY_TAX_PCT, launchDelaySec: Number(s.launchDelay),
      protectionSec: Number(s.window), protectionCapTokens: formatUnits(BigInt(s.baseQuota) * BigInt(s.windowCapMul) * TOKENS_PER_SHARE, 18),
      postMint: s.postMint, tier: TIERS[Number(s.tierMode)] ?? Number(s.tierMode),
      ...(Number(s.tierMode) === 2 && { stepPct: pct(s.stepBps), stepShares: Number(s.stepShares), maxMul: Number(s.maxMulX100) / 100 }),
    },
    raw: s,
  }
}
const pub = ({ raw: _raw, sharePriceRaw: _p, ...s }) => s

/** The pool side of a launched sale: prices (Q112), protection, the token's supply room, and the tax rates. */
async function poolSide(ctx, token, sale, handler) {
  const [[spot, blockStart, high, average], [until, gate, cap], sellTaxBps, supply, maxSupply, room] = await Promise.all([
    ctx.read(ctx.pad, FLY_PAD_ABI, 'prices', [token]),
    ctx.read(handler, FLY_HANDLER_ABI, 'protectionOf', [token]),
    ctx.read(token, TOKEN_ABI, 'sellTaxBps'),
    ctx.read(token, TOKEN_ABI, 'totalSupply'), ctx.read(token, TOKEN_ABI, 'maxSupply'), ctx.read(token, TOKEN_ABI, 'mintRoom'),
  ])
  const t = await chainNow(ctx)
  return {
    prices: {
      unit: `${sale.quoteSymbol || 'quote'} per token`,
      pool: q112(spot), blockStart: q112(blockStart), recentHigh: q112(high), average30m: q112(average),
      launchMintPerToken: formatUnits((sale.sharePriceRaw * 10n ** 18n) / TOKENS_PER_SHARE, 18),
      note: ctx.version === 1
        ? 'a post-launch mint never pays less per token than the pool price; mints pause while the pool is more than 10% below its 30-minute average or its recent high'
        : 'a post-launch mint never pays less per token than the pool price; with the guard on, mints pause while the pool is more than the guard below its average (postRules); the recent high is shown for information only',
    },
    protection: {
      active: t < Number(until), until: iso(Number(until)), endsIn: Math.max(0, Number(until) - t),
      agentIdRequired: gate !== zeroAddress, capTokensPerWallet: formatUnits(cap, 18),
      note: 'during protection a pool buy needs an Agent ID and a wallet buys at most the cap (gross tokens from the pool)',
    },
    tax: { buyPct: BUY_TAX_PCT, sellPct: pct(sellTaxBps), split: 'the first 1%: holders 50% / platform 25% / creator 25%; sell tax above 1%: holders' },
    supply: { total: formatUnits(supply, 18), max: formatUnits(maxSupply, 18), mintRoom: formatUnits(room, 18) },
    raw: { spot, blockStart, high, average, until: Number(until), gate, cap, sellTaxBps: Number(sellTaxBps), room },
  }
}

// Post-launch mint rules (FlywheelPostLogic). V1: refused while the pool is more than 10% below its 30-minute average
// or its recent high, or when the buyer price (spot, the block start, or 99% of the highest of the high, the average and
// the previous block start, which counts for 20 blocks) is more than 10% above the pool. V2: refused only while the pool
// is more than the sale's guard below its TWAP (guard on), or when max(spot, block start) is more than 10% above the pool.
// Both: one share must fit under the supply cap. BPS = 10,000; prices are UQ112x112.
const BPS = 10_000n, GAP_BPS = 1_000n, TWAP_FLOOR_BPS = 100n, PREV_START_BLOCKS = 20n

/**
 * The rules a post-launch mint of one share breaks now, in the order mintPost checks them (the wallet's pace aside).
 * v: 1 | 2; guardBps (V2): 0 = off; prev (V1): the previous block start (0n once more than 20 blocks old); one: the
 * price of one share; room: the token's mintRoom.
 */
export function pauseReasons({ v, spot, blockStart, high, average, prev = 0n, guardBps = 0n, one, room }) {
  const reasons = []
  let price = spot > blockStart ? spot : blockStart
  if (v === 1) {
    if (spot * BPS < average * (BPS - GAP_BPS)) reasons.push('below_average')
    if (spot * BPS < high * (BPS - GAP_BPS)) reasons.push('below_recent_high')
    let ref = high > average ? high : average
    if (prev > ref) ref = prev
    const floor = (ref * (BPS - TWAP_FLOOR_BPS)) / BPS
    if (floor > price) price = floor
  } else if (guardBps !== 0n && spot * BPS < average * (BPS - guardBps)) {
    reasons.push('below_guard') // gang.fun's code for V2's guard (V1 keeps below_average)
  }
  if (price * BPS > spot * (BPS + GAP_BPS)) reasons.push('above_pool')
  // one share: the buyer's tokens and the liquidity's (at most its price of quote at spot) must fit under the cap
  if (spot > 0n && price > 0n && (one * Q112) / price + (one * Q112) / spot > room) reasons.push('supply_cap')
  return reasons
}

/** What a rule means and when it lets minting back, for this pad version and its post-launch rules. */
function pauseText(reason, v, rules) {
  const avg = v === 1 ? '30-minute average' : `${rules.twapWindow / 60}-minute average (TWAP)`
  const guard = v === 1 ? 10 : rules.guardBps / 100
  return {
    why: {
      below_average: `the pool price is more than ${guard}% below its ${avg}`,
      below_guard: `the pool price is more than ${guard}% below its ${avg} (the sale's guard)`,
      below_recent_high: 'the pool price is more than 10% below its recent high',
      above_pool: v === 1 ? 'a mint would be priced more than 10% above the pool (it dropped in the last blocks)' : 'a mint would be priced more than 10% above the pool (it dropped earlier in this block)',
      supply_cap: 'the token\'s supply cap leaves no room for a mint',
    }[reason],
    resumes: reason === 'supply_cap' ? 'post-launch minting is over: the supply cap is reached'
      : v === 1 ? 'minting resumes once the pool price is back within 10% of both its 30-minute average and its recent high (the high decays 0.5% a minute; the average follows the price over 30 minutes)'
        : reason === 'above_pool' ? 'minting resumes in the next block (the price is checked against where the block started)'
          : `minting resumes once the pool price is back within ${guard}% of its ${avg}`,
  }
}

/** The post-launch rules of the token's sale: V2 reads its guard and TWAP window; V1's are fixed. */
async function postRules(ctx, token) {
  if (ctx.version === 1) return { guardBps: 1_000, twapWindow: 1_800, recentHigh: true }
  const [guardBps, twapWindow] = await ctx.read(ctx.pad, FLY_PAD_V2_ABI, 'postRulesOf', [token])
  return { guardBps: Number(guardBps), twapWindow: Number(twapWindow), recentHigh: false }
}

/**
 * Whether post-launch mints are refused now, by the rules mintPost checks on this token's pad (the wallet's own pace
 * aside), as of the latest block. → { pausedNow, reason, reasons, why, resumes }; reason is the first rule mintPost hits.
 */
async function mintPause(ctx, token, sale, handler, side) {
  const { spot, blockStart, high, average, room } = side.raw
  const [rules, one] = await Promise.all([postRules(ctx, token), ctx.read(ctx.pad, FLY_PAD_ABI, 'sharePrice', [token, 1n])])
  let prev = 0n
  if (ctx.version === 1) {
    const [bn, [b, bp], packed] = await Promise.all([
      ctx.client.getBlockNumber(), ctx.read(handler, FLY_HANDLER_ABI, 'blockRefOf', [token]), ctx.read(handler, FLY_HANDLER_ABI, 'prevBlockStartOf', [token]),
    ])
    const [pb, pp] = BigInt(b) === bn ? [packed >> 224n, packed & ((1n << 224n) - 1n)] : [BigInt(b), bp]
    prev = bn - pb > PREV_START_BLOCKS ? 0n : pp
  }
  const reasons = pauseReasons({ v: ctx.version, spot, blockStart, high, average, prev, guardBps: BigInt(rules.guardBps), one, room })
  return { pausedNow: reasons.length > 0, ...(reasons.length && { reason: reasons[0], reasons, ...pauseText(reasons[0], ctx.version, rules) }) }
}

async function poolReserves(ctx, token, pair) {
  if (!pair) return [0n, 0n]
  const [[r0, r1], t0] = await Promise.all([ctx.read(pair, PAIR_ABI, 'getReserves'), ctx.read(pair, PAIR_ABI, 'token0')])
  return same(t0, token) ? [r0, r1] : [r1, r0]
}

const hasAgent = async (ctx, gate, who) => !gate || (await ctx.read(gate, ERC721_ABI, 'balanceOf', [who])) > 0n

/** Dry-run `data` from `from`; null when it would pass. `rich`: pretend the wallet holds enough BNB (a diagnosis only). */
async function dryRun(ctx, from, to, data, value = 0n, rich = false) {
  try {
    await ctx.client.call({
      account: from, to, data, value,
      ...(rich && { stateOverride: [{ address: from, balance: value + parseEther('1000') }] }),
    })
    return null
  } catch (e) {
    const r = revertOf(e)
    return r ? { reverted: true, ...r } : { reverted: false, error: short(e) }
  }
}

/** --ref <addr>: the rules the pad applies silently, checked up front so a referrer that would not count is said. */
async function checkReferrer(ctx, token, sale, me, myAccount, raw, fail) {
  if (raw == null) return zeroAddress
  if (!isAddress(raw)) fail('--ref must be the inviter\'s 0x address', { got: raw })
  if (same(raw, me)) fail('--ref is this wallet itself: a wallet cannot invite itself')
  if (myAccount.minted) {
    fail('this wallet already minted in this token: an inviter only counts on a wallet\'s first mint here; leave --ref out', { token, wallet: me })
  }
  if (Number(sale.raw.inviteBonus) === 0) fail('this sale gives no invite bonus (inviteBonus 0): --ref would do nothing; leave it out', { token })
  const ref = await ctx.read(ctx.pad, FLY_PAD_ABI, 'accounts', [token, raw])
  if (!ref[3]) fail('the inviter has not minted in this token yet, so it cannot invite here; leave --ref out or ask it to mint first', { token, ref: raw })
  if (sale.gate && !(await hasAgent(ctx, sale.gate, raw))) fail('the inviter holds no Agent ID, so its invite would not count; leave --ref out', { token, ref: raw })
  return raw
}

/** One wallet in one sale (the pad's account) and its quota. */
async function accountOf(ctx, token, sale, who) {
  const [a, left] = await Promise.all([
    ctx.read(ctx.pad, FLY_PAD_ABI, 'accounts', [token, who]), ctx.read(ctx.pad, FLY_PAD_ABI, 'quotaLeft', [token, who]),
  ])
  const [preShares, used, bonus, minted, , , baseline] = a
  const inviteBonus = sale.rules.inviteBonus
  return {
    raw: { preShares, used, bonus, minted, baseline },
    view: {
      quota: sale.rules.baseQuota + Number(bonus), quotaUsed: Number(used), quotaLeft: Number(left),
      inviteBonusShares: Number(bonus), invited: inviteBonus ? Number(bonus) / inviteBonus : 0,
      preShares: Number(preShares), minted, canRefer: minted, baselineTokens: formatUnits(baseline, 18),
    },
  }
}

/** What a GangRouter pool buy takes out of the pair before the buy tax (the protection cap counts that). */
async function grossBuy(ctx, token, quote, payBnb, amount) {
  const dex = await ctx.read(ctx.router, GANG_ROUTER_VIEW, 'pancakeRouter')
  const path = payBnb && !same(quote, ctx.wbnb) ? [ctx.wbnb, quote, token] : [quote, token]
  const amounts = await ctx.read(dex, DEX_ABI, 'getAmountsOut', [amount, path])
  return amounts[amounts.length - 1]
}

const SUBS = ['list', 'info', 'status', 'create', 'mint', 'withdraw', 'open-early', 'launch', 'buy', 'sell', 'claim', 'release', 'claim-dev', 'invite', 'tx']
const USAGE = 'usage: gang fly <list|info|status|create|mint|withdraw|open-early|launch|buy|sell|claim|release|claim-dev|invite|tx> [--testnet] — see gang help'
/** withdraw reverts below the preview minus this (bps): it catches an exit fee coming back. */
const WITHDRAW_TOLERANCE_BPS = 10n

/** J-template preset (spec §3–4) and the plain one; every field a flag can override. */
export const FLY_PRESETS = {
  j: { raise: 20, quota: 10, invite: 1, maxPerTx: 10, hold: 60, mintFee: 1, exitFee: 1, devCut: 10, buyPct: 30, sellTax: 2, launchDelay: 60, window: 600, capMul: 1, postMint: true, tier: 'standard', supplyCap: 100, guard: 'off', twapWindow: 30 },
  steady: { raise: 20, quota: 100, invite: 0, maxPerTx: 10, hold: 60, mintFee: 1, exitFee: 1, devCut: 0, buyPct: 0, sellTax: 1, launchDelay: 60, window: 600, capMul: 1, postMint: false, tier: 'flat', supplyCap: 100, guard: 'off', twapWindow: 30 },
}
// V2 only: the post-launch TWAP guard (off or 15 / 20 / 30% below the average) and its window (15 or 30 minutes). The
// guard is off by default (the user's choice): minting does not pause on a price drop, and V2's quota cap of 10 shares
// per wallet bounds what a wallet can mint; the window is still set (it only matters once the guard is on)
const GUARDS = { off: 0, 15: 1_500, 20: 2_000, 30: 3_000 }
const TWAP_WINDOWS = { 15: 900, 30: 1_800 }
// V2: with post-launch minting on, a wallet's quota is at most this many shares and an invite adds at most one
const MAX_POST_QUOTA = 10, MAX_POST_INVITE = 1
// flag → [preset key, min, max, kind]
const CREATE_FLAGS = {
  raise: ['raise', 3, 50, 'num'], quota: ['quota', 5, 100, 'int'], 'invite-bonus': ['invite', 0, 3, 'int'],
  'max-per-tx': ['maxPerTx', 1, 10, 'int'], hold: ['hold', 60, 90, 'num'], 'mint-fee': ['mintFee', 1, 3, 'num'],
  'exit-fee': ['exitFee', 1, 2, 'num'], 'dev-cut': ['devCut', 0, 10, 'num'], 'buy-pct': ['buyPct', 0, 50, 'num'],
  'sell-tax': ['sellTax', 1, 2, 'num'], 'launch-delay': ['launchDelay', 0, 300, 'int'], window: ['window', 300, 1800, 'int'],
  'cap-mul': ['capMul', 1, 2, 'int'], 'supply-cap': ['supplyCap', 10, 500, 'int'],
  'step-pct': ['stepPct', 0, 10, 'num'], 'step-shares': ['stepShares', 100, 100_000, 'int'], 'max-mul': ['maxMul', 1, 10, 'num'],
}
export const FLY_CREATE_FLAGS = [...Object.keys(CREATE_FLAGS), 'preset', 'tier', 'post-mint', 'no-post-mint', 'dev-shares', 'guard', 'twap-window']

/**
 * Entry for `gang fly <sub>` (and the routed verbs of a fly token). io: { opt, flag, out, fail, summarize, resolveLogo,
 * checkMeta, resolveMeta } from index.js.
 */
export async function runFly(sub, { opt, flag, out, fail, summarize, resolveLogo, checkMeta, resolveMeta }) {
  if (sub === 'claim-dev') sub = 'release'
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const net = testnet ? ' --testnet' : ''
  const rawOnly = flag('calldata')
  const ctx = flyCtx(testnet)
  const chainId = Number(ctx.chainId)
  const write = (tx, extra) => step(ctx, tx, { chainId, ...extra }, rawOnly, summarize)
  if (flag('note')) fail('--note is not matched to 铸币飞轮 trades yet: leave it out')

  const tokenArg = () => {
    const t = opt('token')
    if (!isAddress(t ?? '')) fail('--token must be the 铸币飞轮 token\'s address (0x…)', { got: t ?? null })
    return t
  }
  const loadSale = async (token) => {
    // the token's own pad: V1 and V2 tokens both keep working
    if (!(await bindPad(ctx, token))) fail(`not a 铸币飞轮 (Mint Flywheel) token${testnet ? ' on BSC testnet' : ''}`, { token, chainId, pads: ctx.pads.map((p) => p.address) })
    const sale = await saleOf(ctx, token)
    if (!sale) fail(`not a 铸币飞轮 (Mint Flywheel) token on this pad${testnet ? ' (BSC testnet)' : ''}`, { token, chainId, pad: ctx.pad })
    return sale
  }
  const handlerOf = () => ctx.read(ctx.pad, FLY_PAD_ABI, 'taxHandler')
  const me = () => walletFor(ctx, opt('from'))

  if (sub === 'list') {
    // on chain, newest first: the pad keeps every token it created
    const limit = parseIntIn(fail, 'limit', opt('limit', '20'), 1, 200)
    const status = opt('status', 'all')
    if (!['all', 'minting', 'filled', 'launched'].includes(status)) fail('--status must be minting, filled, launched or all')
    // newest pad first, each newest first (V2's tokens are the newer ones)
    const create = { pad: ctx.pad, version: ctx.version }
    const items = []
    let total = 0
    for (const p of ctx.pads) {
      ctx.pad = p.address
      ctx.version = p.version
      const count = Number(await ctx.read(ctx.pad, FLY_PAD_ABI, 'tokenCount'))
      total += count
      for (let i = count - 1; i >= 0 && items.length < limit; i--) {
        const token = await ctx.read(ctx.pad, FLY_PAD_ABI, 'allTokens', [BigInt(i)])
        const s = await saleOf(ctx, token)
        if (!s) continue
        const st = s.status === 'stalled' || s.status === 'refund' ? 'filled' : s.status
        if (status !== 'all' && st !== status) continue
        items.push({
          token, symbol: await symbolOf(ctx, token), padVersion: p.version, status: s.status, quote: s.quoteSymbol, sharePrice: s.sharePrice, raise: s.raise,
          sold: s.sold, sharesLeft: s.sharesLeft, mintedShares: s.mintedShares, baseQuota: s.rules.baseQuota, postMint: s.rules.postMint,
          pair: s.pair, link: `https://gang.fun/token/${token}`,
          next: s.status === 'minting' ? `gang mint --token ${token} --shares <n>${net}`
            : s.status === 'launched' ? (s.rules.postMint ? `gang mint --token ${token} --shares <n>${net}` : `gang buy --token ${token} --amount <quote>${net}`)
              : `gang info --token ${token}${net}`,
        })
      }
    }
    ctx.pad = create.pad
    ctx.version = create.version
    return out({
      success: true, chainId, createPad: ctx.pad, createPadVersion: ctx.version, pads: ctx.pads.map((p) => ({ version: p.version, pad: p.address })),
      total, status, count: items.length, items, ...(!(await padOpen(ctx)) && { note: closed(ctx, testnet) }),
    })
  }

  if (sub === 'info') {
    const token = tokenArg()
    const sale = await loadSale(token)
    const extra = {}
    const owed = await ctx.read(ctx.pad, FLY_PAD_ABI, 'owedDev', [token])
    if (sale.launched) {
      const handler = await handlerOf()
      const side = await poolSide(ctx, token, sale, handler)
      const { raw: _r, ...view } = side
      Object.assign(extra, view)
      if (sale.rules.postMint) {
        const [one, pause] = await Promise.all([ctx.read(ctx.pad, FLY_PAD_ABI, 'sharePrice', [token, 1n]), mintPause(ctx, token, sale, handler, side)])
        const rules = await postRules(ctx, token)
        extra.postMint = {
          sharePriceNow: await units(ctx, sale.quote, one), tierMulNow: Number((one * 100n) / sale.sharePriceRaw) / 100,
          rules: ctx.version === 1
            ? { average: '30 minutes', pausesBelowAveragePct: 10, pausesBelowRecentHighPct: 10 }
            : { guardPct: rules.guardBps ? rules.guardBps / 100 : 'off', twapWindowMin: rules.twapWindow / 60 },
          ...pause,
        }
      }
      const [owedTax, swapBack] = await Promise.all([
        ctx.read(handler, FLY_HANDLER_ABI, 'owedOf', [token]),
        swapBackState(ctx, handler, token, (await poolReserves(ctx, token, sale.pair))[0]),
      ])
      if (swapBack) extra.swapBack = swapBack
      if (owedTax > 0n) extra.owedCreatorTax = await units(ctx, sale.quote, owedTax)
    }
    if (owed > 0n) extra.owedDevCut = await units(ctx, sale.quote, owed)
    if (extra.owedDevCut || extra.owedCreatorTax) extra.release = `gang release --token ${token}${net} (anyone; pays the creator)`
    return out({ success: true, chainId, kind: 'fly', ...pub(sale), ...extra, next: nextFor(sale, token, net, undefined, extra.postMint) })
  }

  if (sub === 'status') {
    const token = tokenArg()
    const sale = await loadSale(token)
    const slippage = parseNum(fail, 'slippage', opt('slippage', '1'), 0, 50)
    const who = me()
    const [acct, bal, agent] = await Promise.all([
      accountOf(ctx, token, sale, who), ctx.read(token, TOKEN_ABI, 'balanceOf', [who]), hasAgent(ctx, sale.gate, who),
    ])
    const a = acct.raw
    const pos = { ...acct.view, isAgent: agent, balance: formatUnits(bal, 18), shares: Number(a.preShares) }
    if (a.minted) pos.inviteLink = inviteLink(token, who)
    if (sale.sellBackOpen && a.preShares) {
      const [payout, fee] = await ctx.read(ctx.pad, FLY_PAD_ABI, 'previewWithdraw', [token, who, BigInt(a.preShares)])
      pos.sellBackAll = await units(ctx, sale.quote, payout)
      pos.sellBackFee = await units(ctx, sale.quote, fee)
    }
    if (sale.launched) {
      const handler = await handlerOf()
      const vault = await ctx.read(ctx.pad, FLY_PAD_ABI, 'dividendVault')
      const [out_, weight, side, bought] = await Promise.all([
        ctx.read(handler, FLY_HANDLER_ABI, 'isOut', [token, who]),
        ctx.read(handler, FLY_HANDLER_ABI, 'eligibleShare', [token, who]),
        poolSide(ctx, token, sale, handler),
        ctx.read(handler, FLY_HANDLER_ABI, 'boughtInWindow', [token, who]),
      ])
      const reward = await dividendOf(ctx, vault, token, who, sale.quote, (side.raw.spot * 10n ** 18n) / Q112)
      const q = bal > 0n ? await poolSellQuote(ctx, handler, token, bal) : null
      if (q) {
        pos.poolSellAll = {
          expectOut: await units(ctx, sale.quote, q.out), minOut: await units(ctx, sale.quote, minOf(q.out, slippage)), slippagePct: slippage,
          quotedWith: q.quotedWith, hint: POOL_SELL_HINT,
        }
      }
      if (side.protection.active) {
        const left = side.raw.cap > bought ? side.raw.cap - bought : 0n
        pos.protection = { until: side.protection.until, boughtTokens: formatUnits(bought, 18), capLeftTokens: formatUnits(left, 18), agentOk: agent }
      }
      if (a.baseline > 0n) {
        const line = holdLine(a.baseline, sale.rules.holdPct)
        Object.assign(pos, {
          reward: out_ ? 'out' : weight > 0n ? 'earning' : 'below-line',
          holdLineTokens: formatUnits(line, 18),
          sellableBeforeOut: !out_ && bal > line ? formatUnits(bal - line, 18) : '0',
          pendingReward: reward.claimable, creditedUnsoldTokens: reward.creditedUnsoldTokens, creditedUnsoldEstimate: reward.creditedUnsoldEstimate,
          ...(out_ && { note: `out: fell below the hold line (${sale.rules.holdPct}% of what it minted). A new mint requalifies it from then on${sale.rules.postMint && acct.view.quotaLeft ? '' : ' (no quota left / no post-launch minting here, so it stays out)'}` }),
        })
      } else {
        Object.assign(pos, { reward: 'none', pendingReward: reward.claimable, note: 'did not mint in this sale: the holder reward is only for minters' })
      }
      if (sale.rules.postMint) {
        const pause = await mintPause(ctx, token, sale, handler, side)
        pos.mintPaused = pause
        if (acct.view.quotaLeft > 0) {
          const [acc, paid, fee, tokensOut, ok] = await ctx.read(ctx.pad, FLY_PAD_ABI, 'previewMintPost', [token, who, 1n])
          pos.mintOneShareNow = acc ? { paid: await units(ctx, sale.quote, paid), fee: await units(ctx, sale.quote, fee), tokensOut: formatUnits(tokensOut, 18), ok } : null
          // the sale's rules allow a mint, the wallet's own 30-minute pace does not
          if (acc && !ok && !pause.pausedNow) pos.mintPaused = { pausedNow: true, reason: 'pace', why: 'this wallet\'s recent post-launch mints reach its 30-minute pace (2% of the pool\'s quote side)', resumes: 'the pace decays over 30 minutes' }
        }
      }
    }
    return out({ success: true, chainId, kind: 'fly', wallet: who, sale: pub(sale), position: pos, next: nextFor(sale, token, net, acct.view, pos.mintPaused) })
  }

  if (sub === 'invite') {
    const token = tokenArg()
    const sale = await loadSale(token)
    const who = flag('who') ? opt('who') : me()
    if (!isAddress(who ?? '')) fail('--who must be a 0x address', { got: who ?? null })
    const [acct, agent] = await Promise.all([accountOf(ctx, token, sale, who), hasAgent(ctx, sale.gate, who)])
    const reason = !acct.view.minted ? 'not_minted' : !agent ? 'not_agent' : !sale.rules.inviteBonus ? 'no_invite_bonus' : null
    const why = {
      not_minted: 'this address has not minted in this token yet: its first mint makes it an inviter',
      not_agent: 'this address holds no Agent ID, so its invites do not count',
      no_invite_bonus: 'this sale gives no invite bonus (inviteBonus 0): invites add no quota',
    }
    // the invitee list is gang.fun's (Referred logs); the count and bonus are read on chain
    const board = await apiGet(`/fly/tokens/${token}/invites/${who}`, undefined, null).catch(() => null)
    return out({
      success: true, chainId, token, referrer: who, link: inviteLink(token, who), canRefer: !reason, ...(reason && { reason, why: why[reason] }),
      inviteBonusPerInvite: sale.rules.inviteBonus, invited: acct.view.invited, bonusShares: acct.view.inviteBonusShares,
      quota: acct.view.quota, quotaLeft: acct.view.quotaLeft,
      ...(board?.invitees && { invitees: board.invitees }),
      // gang.fun's board counts an invite only while it holds up (so sell-backs can't farm it); the bonus above is the
      // pad's and stays either way. Older servers have no such counts: the output is as before
      ...(Number.isFinite(board?.validInvites) && {
        validInvites: board.validInvites, totalInvites: board.totalInvites ?? acct.view.invited,
        validNote: 'gang.fun counts an invite as valid while the invitee still holds pre-launch shares (before the fill), once the sale has filled or launched, or when the invitee first minted after launch; none counts in a refund-only sale. The quota bonus is on chain and stays either way',
      }),
      ...(!board && { inviteesNote: `the list of invitees comes from ${API} (/fly/tokens/<token>/invites) once it indexes this pad; the count here is read on chain` }),
      note: 'an invite counts on the invitee\'s first mint in this token (before or after launch), when it passes --ref (gang mint --ref <inviter>) or opens the link; the inviter must have minted here and hold an Agent ID',
    })
  }

  if (sub === 'create') {
    const name = opt('name'), symbol = opt('symbol')
    if (!name || !symbol) fail('--name and --symbol are required')
    checkMeta()
    if (!(await padOpen(ctx))) fail(closed(ctx, testnet), { pad: ctx.pad, padVersion: ctx.version })
    if (flag('grad')) fail('--grad is a V3 curve setting (the graduation target, 2.0): a 铸币飞轮 sale fills at its --raise instead, so leave --grad out')
    const presetName = opt('preset', 'j')
    const preset = FLY_PRESETS[presetName]
    if (!preset) fail(`--preset must be ${Object.keys(FLY_PRESETS).join(' or ')}`, { got: presetName })
    const v = { ...preset }
    for (const [f, [key, min, max, kind]] of Object.entries(CREATE_FLAGS)) {
      if (!flag(f)) continue
      v[key] = kind === 'int' ? parseIntIn(fail, f, opt(f), min, max) : parseNum(fail, f, opt(f), min, max)
    }
    if (flag('tier')) {
      v.tier = opt('tier')
      if (!TIERS.includes(v.tier)) fail('--tier must be flat, standard or linear', { got: v.tier })
    }
    if (flag('post-mint') && flag('no-post-mint')) fail('give --post-mint or --no-post-mint, not both')
    if (flag('post-mint')) v.postMint = true
    if (flag('no-post-mint')) v.postMint = false
    // V2's post-launch rules; a V1 create target has none, so the flags are refused there rather than ignored
    const v2 = ctx.version === 2
    if (!v2 && (flag('guard') || flag('twap-window'))) fail('--guard / --twap-window are settings of the V2 Mint Flywheel pad, which is not live on this network yet: leave them out')
    if (flag('guard')) {
      v.guard = String(opt('guard'))
      if (!(v.guard in GUARDS)) fail('--guard must be off, 15, 20 or 30 (% below the average at which post-launch mints pause)', { got: opt('guard') ?? null })
    }
    if (flag('twap-window')) {
      v.twapWindow = Number(opt('twap-window'))
      if (!(v.twapWindow in TWAP_WINDOWS)) fail('--twap-window must be 15 or 30 (minutes)', { got: opt('twap-window') ?? null })
    }
    if (v2 && v.postMint && v.quota > MAX_POST_QUOTA) {
      fail(`--quota must be 5-${MAX_POST_QUOTA} with post-launch minting on (the V2 pad's rule): lower --quota, or add --no-post-mint`, { quota: v.quota })
    }
    if (v2 && v.postMint && v.invite > MAX_POST_INVITE) {
      fail(`--invite-bonus must be 0-${MAX_POST_INVITE} with post-launch minting on (the V2 pad's rule): lower it, or add --no-post-mint`, { inviteBonus: v.invite })
    }
    // a pad without the Agent ID gate takes no dev cut (checkConfig refuses one): the preset's goes to 0 unless asked for
    const gated = await ctx.read(ctx.pad, FLY_PAD_ABI, 'agentGateEnabled')
    if (!gated && !flag('dev-cut')) v.devCut = 0
    // V2: post-launch minting needs the Agent ID gate (one wallet per ID is what bounds the per-wallet quota)
    if (v2 && v.postMint && !gated) {
      fail('post-launch minting needs the Agent ID gate, which this pad has off right now: add --no-post-mint for a sale that only mints before launch', { pad: ctx.pad })
    }
    const linear = v.tier === 'linear'
    if (!linear && ['step-pct', 'step-shares', 'max-mul'].some(flag)) fail('--step-pct / --step-shares / --max-mul only apply with --tier linear')
    if (linear) { v.stepPct ??= 1; v.stepShares ??= 1_000; v.maxMul ??= 10 }
    const devShares = parseIntIn(fail, 'dev-shares', opt('dev-shares', '1'), 1, Math.min(v.quota, v.maxPerTx))
    const bps = (x) => Math.round(x * 100)
    const cfg = {
      raiseBnb: parseEther(String(v.raise)), baseQuota: v.quota, inviteBonus: v.invite, maxPerTx: v.maxPerTx,
      holdBps: bps(v.hold), mintFeeBps: bps(v.mintFee), exitFeeBps: bps(v.exitFee), devCutBps: bps(v.devCut), buyBps: bps(v.buyPct),
      sellTaxBps: bps(v.sellTax), launchDelay: v.launchDelay, window: v.window, windowCapMul: v.capMul, postMint: v.postMint,
      tierMode: TIERS.indexOf(v.tier), stepBps: linear ? bps(v.stepPct) : 0, stepShares: linear ? v.stepShares : 0,
      maxMulX100: linear ? Math.round(v.maxMul * 100) : 0, supplyCapMul: v.supplyCap,
      ...(v2 && { guardBps: GUARDS[v.guard], twapWindow: TWAP_WINDOWS[v.twapWindow] }),
    }
    // V2 has its own create / checkConfig (FlyConfig grew): the ABI follows the create target
    const padAbi = v2 ? FLY_PAD_V2_ABI : FLY_PAD_ABI
    const [ok, reason] = await ctx.read(ctx.pad, padAbi, 'checkConfig', [cfg, BigInt(devShares)])
    if (!ok) fail(`setting out of bounds: ${reason}`, { config: cfgView(cfg) })
    const quote = flag('quote') ? opt('quote') : ctx.wbnb
    const refPool = flag('ref-pool') ? opt('ref-pool') : (defaultRefPool(ctx.chainId, quote) ?? zeroAddress)
    if (!isAddress(quote ?? '') || !isAddress(refPool ?? '')) fail('--quote / --ref-pool must be 0x addresses')
    const quoteWbnb = same(quote, ctx.wbnb)
    // the share price: raise / 10,000 in a WBNB sale; another quote is priced by the pad at create (its ref pool's
    // TWAP), so the dev's cost is estimated with GangLaunchpad's preview of the same conversion and approved with 2% room
    let price
    if (quoteWbnb) price = cfg.raiseBnb / BigInt(TOTAL_SHARES)
    else {
      const gangPad = padNets('fair')[testnet ? 'testnet' : 'mainnet'].pad
      try {
        const [, p] = await ctx.read(gangPad, parseAbi(['function previewCreate(address quote, address refPool, uint256 raiseBnb) view returns (uint256 raiseQuote, uint256 sharePrice)']), 'previewCreate', [quote, refPool, cfg.raiseBnb])
        price = (p * 102n) / 100n
      } catch (e) {
        return fail('cannot price the raise in this quote', revertOf(e) || { detail: short(e) })
      }
    }
    const cost = price * BigInt(devShares)
    const need = cost + (cost * BigInt(cfg.mintFeeBps)) / 10_000n
    const who = me()
    const sym = await symbolOf(ctx, quote)
    const pre = await fund(ctx, { me: who, token: quote, need, spender: ctx.pad, sym }, rawOnly, summarize)
    if (pre) return out(pre)
    const createData = (logoURI, metaURI) => encodeFunctionData({
      abi: padAbi, functionName: 'create', args: [[name, symbol, logoURI, metaURI], quote, refPool, cfg, BigInt(devShares)],
    })
    const dry = await dryRun(ctx, who, ctx.pad, createData('', ''))
    if (dry) return out({ success: false, step: 'create', ...dry })
    const logo = await resolveLogo()
    const meta = await resolveMeta({ name, symbol, logoURI: logo.logoURI })
    return out(write({ from: who, to: ctx.pad, data: createData(logo.logoURI, meta.metaURI) }, {
      step: 'create', kind: 'fly', padVersion: ctx.version, pad: ctx.pad, name, symbol, logoURI: logo.logoURI, ...(logo.uploaded && { uploaded: true }),
      metaURI: meta.metaURI, metadata: meta.metadata, quote: sym || quote, preset: presetName, config: cfgView(cfg),
      sharePrice: await units(ctx, quote, quoteWbnb ? price : (price * 100n) / 102n), devShares, devCost: await units(ctx, quote, need),
      ...(v2 && v.postMint && {
        guardNote: cfg.guardBps
          ? `post-launch mints pause while the pool is more than ${cfg.guardBps / 100}% below its ${cfg.twapWindow / 60}-minute average (--guard ${cfg.guardBps / 100})`
          : 'the price guard is off (the default): post-launch minting does not pause when the price drops; the quota cap of 10 shares per wallet bounds it. Turn it on with --guard 15|20|30 (% below the average, over --twap-window 15|30 minutes)',
      }),
      minWallets: Math.ceil(TOTAL_SHARES / cfg.baseQuota),
      note: '10,000 shares at one price; it launches once they are sold (or you open early at ≥ 30%: gang fly open-early), launchDelay later, by anyone (gang fly launch; gang.fun\'s keeper does it too). Minters can sell back before that at the mint price less the exit fee. No GangBond or buy-back on these tokens.',
    }))
  }

  if (sub === 'mint') {
    const token = tokenArg()
    const want = parseIntIn(fail, 'shares', opt('shares'), 1, 10_000)
    const sale = await loadSale(token)
    const who = me()
    const acct = await accountOf(ctx, token, sale, who)
    if (sale.gate && !(await hasAgent(ctx, sale.gate, who))) fail('this wallet holds no Agent ID; 铸币飞轮 minting is Agent-only', { wallet: who })
    const referrer = await checkReferrer(ctx, token, sale, who, acct.raw, opt('ref'), fail)
    const quota = { quota: acct.view.quota, quotaLeft: acct.view.quotaLeft, maxPerTx: sale.rules.maxPerTx }
    if (!acct.view.quotaLeft) fail('this wallet\'s quota in this sale is used up', { ...quota, hint: `invites add ${sale.rules.inviteBonus} share(s) each: gang fly invite --token ${token}${net}` })
    const refNote = referrer !== zeroAddress
      ? { ref: referrer, inviteNote: `first mint here: ${referrer} gets +${sale.rules.inviteBonus} share(s) of quota` }
      : !acct.raw.minted && sale.rules.inviteBonus ? { inviteNote: 'first mint here: pass --ref <inviter> if someone invited this wallet (only the first mint can carry it)' } : {}
    const bnb = same(sale.quote, ctx.wbnb) && !flag('use-wbnb')

    if (sale.status === 'minting') {
      const [accepted, cost, fee] = await ctx.read(ctx.pad, FLY_PAD_ABI, 'previewMint', [token, who, BigInt(want)])
      if (accepted === 0n) fail('no shares available to this wallet now', quota)
      const minShares = flag('min-shares') ? parseIntIn(fail, 'min-shares', opt('min-shares'), 1, Number(accepted)) : Number(accepted)
      const need = cost + fee
      const fills = sale.sold + Number(accepted) === TOTAL_SHARES
      // launchDelay 0: the mint that fills also launches (about 2.5M gas); near the end other mints landing first can make
      // this one that mint, so it gets a launch-sized gas limit
      const mayLaunch = sale.rules.launchDelaySec === 0 && sale.sharesLeft - Number(accepted) <= 10 * sale.rules.maxPerTx
      const extra = {
        step: 'mint', kind: 'fly', phase: 'pre-launch', token, shares: Number(accepted), ...(Number(accepted) < want && { truncatedFrom: want, ...quota }),
        cost: await units(ctx, sale.quote, cost), fee: await units(ctx, sale.quote, fee), feePct: sale.rules.mintFeePct, quote: sale.quoteSymbol,
        tokens: formatUnits(accepted * TOKENS_PER_SHARE, 18), soldAfter: sale.sold + Number(accepted), quotaLeftAfter: acct.view.quotaLeft - Number(accepted), ...refNote,
        ...(fills && { fills: `this mint fills the sale${sale.rules.launchDelaySec ? `; it launches ${sale.rules.launchDelaySec}s later (gang fly launch, anyone)` : ' and launches it (higher gas)'}` }),
        note: `the ${sale.rules.mintFeePct}% mint fee goes to the platform; before launch you can sell back at the mint price less the exit fee (gang withdraw)`,
      }
      if (bnb) {
        const native = await ctx.client.getBalance({ address: who })
        if (native < need + GAS_RESERVE) fail('not enough BNB for this mint (native BNB must also cover gas)', { haveBnb: formatUnits(native, 18), needBnb: formatUnits(need, 18), hint: 'add --use-wbnb to pay from WBNB' })
        const data = encodeFunctionData({ abi: FLY_PAD_ABI, functionName: 'mintWithBnb', args: [token, accepted, BigInt(minShares), referrer] })
        const dry = await dryRun(ctx, who, ctx.pad, data, need)
        if (dry) return out({ success: false, ...extra, ...dry })
        const tx = { from: who, to: ctx.pad, data, value: need }
        if (mayLaunch) try { tx.gas = await roomyGas(ctx, tx, GAS_FLOOR.launch) } catch (e) { return out({ success: false, ...extra, reverted: true, ...(revertOf(e) || { error: short(e) }) }) }
        return out(write(tx, { ...extra, payBnb: formatUnits(need, 18), ...(tx.gas && { gasLimit: tx.gas.toString() }) }))
      }
      const pre = await fund(ctx, { me: who, token: sale.quote, need, spender: ctx.pad, sym: sale.quoteSymbol }, rawOnly, summarize)
      if (pre) return out(pre)
      const data = encodeFunctionData({ abi: FLY_PAD_ABI, functionName: 'mint', args: [token, accepted, BigInt(minShares), referrer] })
      const dry = await dryRun(ctx, who, ctx.pad, data)
      if (dry) return out({ success: false, ...extra, ...dry })
      const tx = { from: who, to: ctx.pad, data }
      if (mayLaunch) try { tx.gas = await roomyGas(ctx, tx, GAS_FLOOR.launch) } catch (e) { return out({ success: false, ...extra, reverted: true, ...(revertOf(e) || { error: short(e) }) }) }
      return out(write(tx, { ...extra, ...(tx.gas && { gasLimit: tx.gas.toString() }) }))
    }

    if (!sale.launched) {
      fail(`the sale is ${sale.status}: no mints until it launches`, {
        token, ...(sale.launchAt && { launchAt: sale.launchAt, launchableNow: sale.launchableNow }),
        hint: sale.launchableNow ? `anyone can launch it now: gang fly launch --token ${token}${net}` : 'wait for the launch (gang info)',
      })
    }
    if (!sale.rules.postMint) fail('this sale has no post-launch minting: buy in the pool', { hint: `gang buy --token ${token} --amount <quote>${net}` })
    const slippage = parseNum(fail, 'slippage', opt('slippage', '2'), 0, 50)
    const [accepted, paid, fee, tokensOut, ok] = await ctx.read(ctx.pad, FLY_PAD_ABI, 'previewMintPost', [token, who, BigInt(want)])
    const handler = await handlerOf()
    const side = await poolSide(ctx, token, sale, handler)
    const priceView = {
      poolPrice: side.prices.pool,
      ...(tokensOut > 0n && { mintPricePerToken: formatUnits((paid * 10n ** 18n) / tokensOut, 18) }),
      ...(tokensOut > 0n && side.raw.spot > 0n && { premiumOverPoolPct: Number(((paid * Q112 * 10_000n) / tokensOut / side.raw.spot) - 10_000n) / 100 }),
      unit: side.prices.unit,
    }
    if (accepted === 0n) fail('no shares available to this wallet now', quota)
    const minTokensOut = minOf(tokensOut, slippage)
    const maxSpent = paid + fee
    const data = bnb
      ? encodeFunctionData({ abi: FLY_PAD_ABI, functionName: 'mintPostWithBnb', args: [token, accepted, minTokensOut, referrer] })
      : encodeFunctionData({ abi: FLY_PAD_ABI, functionName: 'mintPost', args: [token, accepted, minTokensOut, maxSpent, referrer] })
    const extra = {
      step: 'mint', kind: 'fly', phase: 'post-launch', function: bnb ? 'mintPostWithBnb' : 'mintPost', token, shares: Number(accepted),
      ...(Number(accepted) < want && { truncatedFrom: want, ...quota }),
      paid: await units(ctx, sale.quote, paid), fee: await units(ctx, sale.quote, fee), maxSpent: await units(ctx, sale.quote, maxSpent), quote: sale.quoteSymbol,
      expectTokens: formatUnits(tokensOut, 18), minTokensOut: formatUnits(minTokensOut, 18), slippagePct: slippage, ...priceView,
      quotaLeftAfter: acct.view.quotaLeft - Number(accepted), ...refNote,
      note: `the money goes into the pool (${sale.rules.buyPct}% of it buys from it${sale.rules.devCutPct ? `, ${sale.rules.devCutPct}% to the creator` : ''}), the tokens are minted to you; the ${sale.rules.mintFeePct}% fee is the platform's. Minted tokens earn the holder reward while you keep ${sale.rules.holdPct}% of them`,
    }
    if (!ok) {
      // the preview says no: the same call, simulated, names the rule (a BNB sale: BNB lent for the simulation only). Only
      // a rule of the pad / handler / token counts: a quote-token revert (no allowance yet) says nothing about the rule
      const dry = await dryRun(ctx, who, ctx.pad, data, bnb ? maxSpent : 0n, bnb)
      const r = dry?.reverted && HINTS[dry.error] ? dry : null
      // no rule from the simulation (e.g. it stopped at the quote transfer): the pad's rules read as gang info does,
      // and what is left when none applies is this wallet's own pace
      const pause = r ? null : await mintPause(ctx, token, sale, handler, side)
      return out({
        success: false, ...extra, error: `a post-launch mint is refused right now${r ? `: ${r.error}` : `: ${pause.pausedNow ? pause.reason : 'pace'}`}`,
        ...(r ? { reason: r.error, hint: r.hint } : pause.pausedNow ? { reason: pause.reason, hint: pause.why, resumes: pause.resumes } : {
          reason: 'pace', hint: HINTS.PaceExceeded,
        }),
        prices: side.prices, supply: side.supply,
      })
    }
    if (bnb) {
      const native = await ctx.client.getBalance({ address: who })
      if (native < maxSpent + GAS_RESERVE) fail('not enough BNB for this mint (native BNB must also cover gas)', { haveBnb: formatUnits(native, 18), needBnb: formatUnits(maxSpent, 18), hint: 'add --use-wbnb to pay from WBNB' })
      const dry = await dryRun(ctx, who, ctx.pad, data, maxSpent)
      if (dry) return out({ success: false, ...extra, ...dry })
      const tx = { from: who, to: ctx.pad, data, value: maxSpent }
      try { tx.gas = await roomyGas(ctx, tx, GAS_FLOOR.mintPost) } catch (e) { return out({ success: false, ...extra, reverted: true, ...(revertOf(e) || { error: short(e) }) }) }
      return out(write(tx, { ...extra, payBnb: formatUnits(maxSpent, 18), refundNote: 'what the mint does not spend comes back in the same tx', gasLimit: tx.gas.toString(), gasNote: GAS_NOTE }))
    }
    const pre = await fund(ctx, { me: who, token: sale.quote, need: maxSpent, spender: ctx.pad, sym: sale.quoteSymbol }, rawOnly, summarize)
    if (pre) return out(pre)
    const dry = await dryRun(ctx, who, ctx.pad, data)
    if (dry) return out({ success: false, ...extra, ...dry })
    const tx = { from: who, to: ctx.pad, data }
    try { tx.gas = await roomyGas(ctx, tx, GAS_FLOOR.mintPost) } catch (e) { return out({ success: false, ...extra, reverted: true, ...(revertOf(e) || { error: short(e) }) }) }
    return out(write(tx, { ...extra, gasLimit: tx.gas.toString(), gasNote: GAS_NOTE }))
  }

  if (sub === 'withdraw') {
    const token = tokenArg()
    const sale = await loadSale(token)
    if (!sale.sellBackOpen) {
      fail(`the sale is ${sale.status}: sell-back is closed`, sale.launched
        ? { pair: sale.pair, hint: `it launched: sell in the pool with gang sell --token ${token} (--amount <tokens> | --all)${net}` }
        : { sellBackReopensAt: sale.sellBackReopensAt, hint: 'a filled sale launches soon (gang fly launch); sell-backs reopen only if it is still not launched 7 days later' })
    }
    const who = me()
    const acct = await accountOf(ctx, token, sale, who)
    const held = Number(acct.raw.preShares)
    if (!held) fail('this wallet has no pre-launch shares in this sale')
    if (flag('all') && flag('shares')) fail('give --shares <n> or --all, not both')
    const shares = flag('all') ? held : parseIntIn(fail, 'shares', opt('shares'), 1, held)
    const [payout, fee] = await ctx.read(ctx.pad, FLY_PAD_ABI, 'previewWithdraw', [token, who, BigInt(shares)])
    const minPayout = (payout * (10_000n - WITHDRAW_TOLERANCE_BPS)) / 10_000n
    const data = encodeFunctionData({ abi: FLY_PAD_ABI, functionName: 'withdraw', args: [token, BigInt(shares), minPayout] })
    const dry = await dryRun(ctx, who, ctx.pad, data)
    if (dry) return out({ success: false, step: 'withdraw', ...dry })
    return out(write({ from: who, to: ctx.pad, data }, {
      step: 'withdraw', kind: 'fly', token, shares, receive: await units(ctx, sale.quote, payout), minReceive: await units(ctx, sale.quote, minPayout),
      exitFee: await units(ctx, sale.quote, fee), exitFeePct: sale.rules.exitFeeNowPct, quote: sale.quoteSymbol,
      note: `mint price less the ${sale.rules.exitFeeNowPct}% exit fee (none after 7 days without progress); the mint fee is not returned; the shares go back to this wallet\'s quota`,
    }))
  }

  if (sub === 'open-early' || sub === 'launch') {
    const token = tokenArg()
    const sale = await loadSale(token)
    const who = me()
    if (sale.launched) fail('already launched', { pair: sale.pair })
    if (sub === 'open-early') {
      if (sale.status !== 'minting') fail(`the sale is ${sale.status}: open-early is for a sale still minting`, { launchAt: sale.launchAt })
      if (!same(who, sale.creator)) fail('only the creator can open the sale early', { creator: sale.creator, wallet: who })
      if (sale.sold < EARLY_OPEN_SHARES) fail(`open-early needs at least ${EARLY_OPEN_SHARES} shares (30%) sold`, { sold: sale.sold })
    } else {
      if (sale.status === 'minting') fail('the sale has not filled yet: nothing to launch', { sold: sale.sold, hint: sale.canOpenEarly ? `the creator can open early: gang fly open-early --token ${token}${net}` : undefined })
      if (sale.status === 'refund') fail('fewer than 3,000 shares are held 7 days after the fill: this sale can no longer launch, only refund (gang withdraw)', { sold: sale.sold })
      if (!sale.launchableNow) fail(`too early: launch opens at ${sale.launchAt}`, { launchIn: sale.launchIn })
    }
    const data = encodeFunctionData({ abi: FLY_PAD_ABI, functionName: sub === 'launch' ? 'launch' : 'openEarly', args: [token] })
    const dry = await dryRun(ctx, who, ctx.pad, data)
    if (dry) return out({ success: false, step: sub, ...dry })
    const tx = { from: who, to: ctx.pad, data }
    if (sub === 'launch' || !sale.rules.launchDelaySec) {
      try { tx.gas = await roomyGas(ctx, tx, GAS_FLOOR.launch) } catch (e) { return out({ success: false, step: sub, reverted: true, ...(revertOf(e) || { error: short(e) }) }) }
    }
    return out(write(tx, {
      step: sub, kind: 'fly', token, sold: sale.sold, ...(tx.gas && { gasLimit: tx.gas.toString() }),
      note: sub === 'launch'
        ? `creates the PancakeSwap pool at the mint price (about 2.5M gas); protection runs ${sale.rules.protectionSec}s after it`
        : sale.rules.launchDelaySec ? `stops the sale at ${sale.sold} shares; anyone can launch it ${sale.rules.launchDelaySec}s later (gang fly launch)` : `stops the sale at ${sale.sold} shares and launches in the same tx (about 2.5M gas)`,
    }))
  }

  if (sub === 'buy' || sub === 'sell') {
    const token = tokenArg()
    const sale = await loadSale(token)
    if (!sale.launched || !sale.pair) {
      fail(`the sale is ${sale.status}: gang ${sub} trades the token in its pool after launch`, {
        hint: sub === 'buy' ? `before launch, mint shares: gang mint --token ${token} --shares <n>${net}` : `before launch, sell shares back: gang withdraw --token ${token} (--shares <n> | --all)${net}`,
      })
    }
    for (const f of ['bond', 'break-bond', 'settle-first']) if (flag(f)) fail(`--${f}: 铸币飞轮 tokens take no GangBond`)
    const slippage = parseNum(fail, 'slippage', opt('slippage', '1'), 0, 50)
    if (sub === 'sell' && flag('all') === !!opt('amount')) fail('pass exactly one of --amount <tokens> or --all')
    if (sub === 'buy' && !flag('amount')) fail('--amount <quote (or BNB) to spend> required')
    const handler = await handlerOf()
    const side = await poolSide(ctx, token, sale, handler)
    const who = me()
    const payBnb = sub === 'buy' && poolPayBnb(ctx, sale.quote, flag)
    let extra = {}
    if (sub === 'buy' && side.protection.active) {
      // launch protection: the handler refuses a buy without an Agent ID or past the wallet's cap, so say it here
      if (side.raw.gate !== zeroAddress && !(await hasAgent(ctx, side.raw.gate, who))) {
        fail('launch protection: only Agent ID holders can buy from the pool until it ends', { until: side.protection.until, endsIn: side.protection.endsIn })
      }
      const bought = await ctx.read(handler, FLY_HANDLER_ABI, 'boughtInWindow', [token, who])
      const left = side.raw.cap > bought ? side.raw.cap - bought : 0n
      const amountIn = parseUnits(parseAmount(fail, 'amount', opt('amount')), 18)
      let gross = null
      try { gross = await grossBuy(ctx, token, sale.quote, payBnb, amountIn) } catch { /* the pool trade reports a missing pool */ }
      if (gross != null && gross > left) {
        fail('launch protection: this buy takes more tokens from the pool than this wallet\'s protected cap allows', {
          expectTokensBeforeTax: formatUnits(gross, 18), capLeftTokens: formatUnits(left, 18), until: side.protection.until,
          hint: sale.rules.postMint ? `buy less, or mint instead: gang mint --token ${token} --shares <n>${net}` : 'buy less, or wait for the protection to end',
        })
      }
      extra = { protection: { until: side.protection.until, capLeftTokens: formatUnits(left, 18) } }
    }
    let outWarning = null
    if (sub === 'sell') {
      const a = await ctx.read(ctx.pad, FLY_PAD_ABI, 'accounts', [token, who])
      const baseline = a[6]
      if (baseline > 0n && !(await ctx.read(handler, FLY_HANDLER_ABI, 'isOut', [token, who]))) {
        const bal = await ctx.read(token, TOKEN_ABI, 'balanceOf', [who])
        const line = holdLine(baseline, sale.rules.holdPct)
        const sellable = bal > line ? bal - line : 0n
        const amount = flag('all') ? bal : parseUnits(parseAmount(fail, 'amount', opt('amount')), 18)
        if (amount <= bal && amount > sellable) {
          outWarning = {
            warning: `selling ${formatUnits(amount, 18)} tokens goes past sellableBeforeOut (${formatUnits(sellable, 18)}): this wallet drops below its hold line (${formatUnits(line, 18)} tokens) and stops earning the holder reward until it mints again`,
            sellableBeforeOut: formatUnits(sellable, 18), holdLineTokens: formatUnits(line, 18), balance: formatUnits(bal, 18),
          }
          if (!flag('confirm-out')) fail(outWarning.warning, { ...outWarning, token, wallet: who, hint: 'sell at most sellableBeforeOut to keep the reward, or re-run with --confirm-out once the user accepts' })
        }
      }
    }
    // GangRouter's pool functions trade any token on its Pancake pair (they never ask the pad): the fly token too
    const poolCtx = { ...ctx, pad: null }
    return out(await poolTrade(poolCtx, {
      side: sub, token, quote: sale.quote, me: who, slippage, buyTaxBps: BUY_TAX_PCT * 100, sellTaxBps: side.raw.sellTaxBps, handler,
      amount: sub === 'sell' && flag('all') ? null : parseAmount(fail, 'amount', opt('amount')), all: sub === 'sell' && flag('all'),
      swapBackGas: true, payBnb, toBnb: flag('to-bnb'), gasFloor: GAS_FLOOR[sub],
      base: {
        kind: 'fly', pair: sale.pair, ...extra, ...(outWarning && { ...outWarning, confirmedOut: true }),
        ...(sub === 'buy' && {
          rewardNote: 'pool-bought tokens earn no holder reward (only minted ones do)',
          gasNote: GAS_NOTE,
        }),
        // a large pool buy seen in the public mempool can be front-run (issue #75 asks for private sends): the CLI does
        // not broadcast, so it can only say where to send it
        ...(sub === 'buy' && (rawOnly || side.protection.active) && { mempoolNote: rawOnly
          ? 'send this buy through a private submission endpoint (not a public RPC): a large pool buy in the public mempool can be front-run'
          : 'the Agentic Wallet broadcasts through its own RPC; for a large buy, consider gang buy … --calldata and sending the tx through a private submission endpoint' }),
      },
    }, { rawOnly, summarize, revertOf }))
  }

  if (sub === 'claim') {
    const token = tokenArg()
    const sale = await loadSale(token)
    const who = me()
    const vault = await ctx.read(ctx.pad, FLY_PAD_ABI, 'dividendVault')
    let spot = 0n, standing = {}
    if (sale.launched) {
      const handler = await handlerOf()
      const [[s], isOut, a, bal] = await Promise.all([
        ctx.read(ctx.pad, FLY_PAD_ABI, 'prices', [token]), ctx.read(handler, FLY_HANDLER_ABI, 'isOut', [token, who]),
        ctx.read(ctx.pad, FLY_PAD_ABI, 'accounts', [token, who]), ctx.read(token, TOKEN_ABI, 'balanceOf', [who]),
      ])
      spot = (s * 10n ** 18n) / Q112
      const line = holdLine(a[6], sale.rules.holdPct)
      standing = { reward: a[6] === 0n ? 'none' : isOut ? 'out' : 'earning', holdLineTokens: formatUnits(line, 18), balance: formatUnits(bal, 18) }
    }
    const r = await dividendOf(ctx, vault, token, who, sale.quote, spot)
    const unsold = r.creditedUnsoldTokens && Number(r.creditedUnsoldTokens) > 0
    if (r.claimableRaw === 0n) {
      fail('nothing to claim yet', { ...standing, ...(unsold && { creditedUnsoldEstimate: r.creditedUnsoldEstimate, note: r.note }), hint: `gang status --token ${token}${net}` })
    }
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'claim', args: [token] })
    return out(write({ from: who, to: vault, data }, {
      step: 'claim', kind: 'fly', token, amount: r.claimable, quote: sale.quoteSymbol, ...standing,
      ...(unsold && { stillCreditedUnsold: r.creditedUnsoldEstimate }),
    }))
  }

  if (sub === 'release') {
    // the creator's money that a transfer could not deliver: the pad's dev cut first, then the handler's tax share
    const token = tokenArg()
    const sale = await loadSale(token)
    const who = me()
    const handler = await handlerOf()
    const [dev, tax] = await Promise.all([ctx.read(ctx.pad, FLY_PAD_ABI, 'owedDev', [token]), ctx.read(handler, FLY_HANDLER_ABI, 'owedOf', [token])])
    if (dev === 0n && tax === 0n) fail('nothing is owed to the creator of this token', { token, creator: sale.creator })
    const [to, abi, functionName, amount, what] = dev > 0n
      ? [ctx.pad, FLY_PAD_ABI, 'claimDev', dev, 'dev cut']
      : [handler, FLY_HANDLER_ABI, 'release', tax, 'tax share']
    const data = encodeFunctionData({ abi, functionName, args: [token] })
    const dry = await dryRun(ctx, who, to, data)
    if (dry) return out({ success: false, step: 'release', what, ...dry, hint: dry.error === 'execution reverted' ? 'the creator still cannot receive the quote: try again later' : dry.hint })
    return out(write({ from: who, to, data }, {
      step: 'release', kind: 'fly', token, what, function: functionName, amount: await units(ctx, sale.quote, amount), quote: sale.quoteSymbol, to: sale.creator,
      ...(dev > 0n && tax > 0n && { alsoOwed: { taxShare: await units(ctx, sale.quote, tax), next: `run gang release --token ${token}${net} again after this one` } }),
      note: 'anyone may send it; the creator receives it',
    }))
  }

  if (sub === 'tx') {
    const hash = opt('hash')
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) fail('--hash must be a tx hash')
    const r = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    return out({ success: true, chainId, hash, status: r.status, block: Number(r.blockNumber), events: decodeFly(r.logs), explorer: `${ctx.explorer}/tx/${hash}` })
  }
  return fail(USAGE, { got: sub })
}

/** The logs of a tx, decoded with the fly ABIs (raw units). */
export function decodeFly(logs) {
  const events = []
  for (const log of logs) {
    for (const abi of FLY_EVENT_ABIS) {
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics })
        events.push({ event: ev.eventName, address: log.address, ...JSON.parse(JSON.stringify(ev.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v))) })
        break
      } catch { /* other contract / event */ }
    }
  }
  return events
}

const cfgView = (c) => ({
  raiseBnb: formatUnits(c.raiseBnb, 18), baseQuota: c.baseQuota, inviteBonus: c.inviteBonus, maxPerTx: c.maxPerTx, holdPct: pct(c.holdBps),
  mintFeePct: pct(c.mintFeeBps), exitFeePct: pct(c.exitFeeBps), devCutPct: pct(c.devCutBps), buyPct: pct(c.buyBps), sellTaxPct: pct(c.sellTaxBps),
  launchDelaySec: c.launchDelay, protectionSec: c.window, protectionCapMul: c.windowCapMul, postMint: c.postMint, tier: TIERS[c.tierMode],
  ...(c.tierMode === 2 && { stepPct: pct(c.stepBps), stepShares: c.stepShares, maxMul: c.maxMulX100 / 100 }), supplyCapMul: c.supplyCapMul,
  ...(c.guardBps !== undefined && { guardPct: c.guardBps ? pct(c.guardBps) : 'off', twapWindowMin: c.twapWindow / 60 }),
})

/** The command that acts on the sale next. `paused`: mintPause (or the wallet's) after launch. */
function nextFor(sale, token, net, acct, paused) {
  if (sale.status === 'minting') return `gang mint --token ${token} --shares <n>${net}${acct && !acct.minted ? ' [--ref <inviter>]' : ''}`
  if (sale.status === 'filled') return sale.launchableNow ? `gang fly launch --token ${token}${net}` : `wait until ${sale.launchAt}, then gang fly launch --token ${token}${net}`
  if (sale.status === 'stalled') return `gang fly launch --token ${token}${net} (or gang withdraw to sell back)`
  if (sale.status === 'refund') return `gang withdraw --token ${token} --all${net}`
  if (sale.rules.postMint && paused?.pausedNow) return `gang buy --token ${token} --amount <quote>${net} (post-launch minting is paused: ${paused.why})`
  if (sale.rules.postMint && acct && !acct.quotaLeft) return `gang buy --token ${token} --amount <quote>${net} (this wallet's mint quota is used up)`
  return sale.rules.postMint ? `gang mint --token ${token} --shares <n>${net} (or gang buy in the pool)` : `gang buy --token ${token} --amount <quote>${net}`
}
