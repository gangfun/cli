import { encodeFunctionData, decodeFunctionData, decodeFunctionResult, formatUnits, keccak256, isAddress, parseAbi, parseUnits, toFunctionSelector, zeroAddress } from 'viem'
import { GAS_RESERVE, isMissingFunction, revertOf as revertIn, roomyGas, routerDeadline, step } from './steps.js'
import { fundingOf, minOf, PoolError, rawTx } from './pool.js'
import { gangGens, GANGSWAP_KIND, PAD3_GEN, padNets } from './gangpad.js'
import { missingRead } from './base.js'
import { bondGuard } from './bond.js'
import { callBondGuard } from './callbond.js'
import { VANITY_ABI, vanityDeployer } from './vanity.js'
import { AGENT_WINDOW_ABI, wrapCreate } from './agentwindow.js'

/**
 * GangSwap (docs/SPEC-GANGSWAP-2026-11-22.md): the optional graduation venue of a GangLaunchpad 3.0 curve token, picked
 * at create (`gang create --venue gangswap`, kind 4). On the curve it is a WBNB-quoted, untaxed V3 token; at graduation it
 * moves into a GangSwap pair instead of a PancakeSwap one, for good. The pair has the V2 interface, but getReserves() are
 * EFFECTIVE reserves (real quote + a fixed virtual reserve): prices come from them, while realQuoteReserve() is what can
 * be paid out. 1% fee on the input, taken out of the pool.
 *
 * It trades through GangSwapRouter only. Never GangRouter's pool* functions nor the PancakeSwap router: anyone can make
 * a PancakeSwap pool of the token, and those would fill against it.
 *
 * GangSwap has versions, as PancakeSwap does: each is its own GangSwapMigrator with its own factory, boost, fees and router.
 * The pad's gangSwapMigrator() is only the version NEW tokens get (the owner's to change, 0 = closed); a token keeps the
 * one of its create forever, gangSwapMigratorOf(token). Everything about an existing token starts from the latter.
 *
 * Addresses: the token's migrator names the factory and the boost; the factory names the fees contract. The router is
 * named by nothing on chain: the versions are pinned per network below (or GANG_SWAP_ROUTER / GANG_TESTNET_SWAP_ROUTER
 * names one, for development), the one whose factory() is the token's own is used, and it is identified by its code before
 * every trade (checkRouter): what it says about itself (factory(), WETH()) proves nothing on its own.
 */

const ROUTER_ENV = { mainnet: 'GANG_SWAP_ROUTER', testnet: 'GANG_TESTNET_SWAP_ROUTER' }
/**
 * The one GangSwapRouter build this CLI knows: keccak256 of its runtime code with both immutables zero, as the
 * compiler's artifact has it (deployedBytecode), and which immutable each PUSH32 operand is, in code order (F = factory,
 * W = WETH). The order matters: zeroing alone would take a router with the two swapped at some operands.
 * Recompute after any change to gangswap/ (the code's own metadata hash is part of it, so build with the committed
 * foundry.toml and remappings.txt from a clean copy):
 *   git archive <commit> gangswap | tar -x -C <dir>; ln -s <repo>/lib <dir>/lib; cd <dir>/gangswap; forge build
 *   cast keccak $(jq -r .deployedBytecode.object out/GangSwapRouter.sol/GangSwapRouter.json)
 * and for the order, sort the offsets of .deployedBytecode.immutableReferences (factory is declared before WETH).
 */
export const GANGSWAP_ROUTER_CODE_HASH = '0x07886a19fc51c00596b5f1a703c66903ee86222faf200b6a86adfbee9e4f005d'
export const GANGSWAP_ROUTER_SITES = 'WWFFWFFWFFWWWWFWWFFWWWWFFFWFWWFFFFF'
const BUILD = { codeHash: GANGSWAP_ROUTER_CODE_HASH, sites: GANGSWAP_ROUTER_SITES }
/**
 * The GangSwap versions this CLI trades on, per network: { router, codeHash, sites } each (the router's address and its
 * build). Open on both networks since 2026-11-25 (the pad's owner can close it for new tokens). A new version is another entry; the older ones stay for their tokens.
 */
export const GANGSWAP_VERSIONS = {
  mainnet: [
    // GangSwapMigrator 0x22e13298D48100420F2F386D70D18E498161B20b: factory 0xd0C15eB66e08596F9F534d0051F691b86Bc584F5,
    // boost 0x42A3dBcBb2339f52AE332cc480766003C43f1416, fees 0xa9D9a67D724d487f843d37db92162F6728c58900
    { router: '0xd685e3432472d0da34903888f96b0D0221bC779c', ...BUILD },
  ],
  testnet: [
    // GangSwapMigrator 0x1B942d7eA4B9C2229e6776150d989ab1E6aDD36A: factory 0x90aF66E555E8C90fFFd0780cF4ca56A8313CEA36,
    // boost 0xBcE63184f8BA913eD1dE6002fEdDe587305F00Ea, fees 0xDbA8FEBB6aC9Da3eEb9A8805E4053C42763B7236
    { router: '0x1EAdAEe9b7C04Db9b828CcC342c3Ef2355722d94', ...BUILD },
  ],
}
const netOf = (ctx) => (Number(ctx.chainId) === 56 ? 'mainnet' : 'testnet')
/** Every router build this CLI knows: what a router named by the env must be one of. */
const knownBuilds = () => [BUILD, ...GANGSWAP_VERSIONS.mainnet, ...GANGSWAP_VERSIONS.testnet]
const fromEnv = (routers) => routers.map((router) => ({ router, builds: knownBuilds(), env: true }))
/**
 * The routers a token of this network may trade on: { router, builds, env }. The pinned ones and every one the
 * network's env lists (comma-separated; one pinned already is not added again). Whichever way, a router is used only for its own version's tokens and after every check (verifyRouter).
 */
function candidates(net) {
  const env = process.env[ROUTER_ENV[net]]
  const pinned = GANGSWAP_VERSIONS[net].map((v) => ({ router: v.router, builds: [v], env: false }))
  const listed = [...new Map((env ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => [x.toLowerCase(), x])).values()]
  return [...pinned, ...fromEnv(listed.filter((x) => !pinned.some((p) => p.router.toLowerCase() === x.toLowerCase())))]
}
/** Every GangSwapRouter address this run knows on `testnet` / mainnet (the env's too), whatever its version. */
export const gangSwapRouterAddresses = (testnet) => {
  const net = testnet ? 'testnet' : 'mainnet'
  const known = [...candidates(net).map((c) => c.router), ...GANGSWAP_VERSIONS[net].map((v) => v.router)]
  return known.filter((r, i) => known.findIndex((x) => x.toLowerCase() === r.toLowerCase()) === i)
}

export const GANGSWAP_PAD_ABI = parseAbi([
  'function gangSwapMigrator() view returns (address)',
  'function gangSwapMigratorOf(address token) view returns (address)',
  'function createGangSwap(string name, string symbol, string logoURI, string metaURI, uint256 gradBnb, address migrator) returns (address token)',
  // the same with a graduation reward the creator seeds in WBNB (docs/SPEC-GANGSWAP-GRAD-REWARD-2026-11-25.md); cfg as gradreward.js's
  'function createGangSwapWithGradReward(string name, string symbol, string logoURI, string metaURI, uint256 gradBnb, address migrator, (uint128 seed, uint96 minBuy, uint8 entries, uint16 lastBps, uint16 carryBps, uint32 refundAfter, uint16 promoteBps, uint32 promoteWindow) cfg) returns (address token)',
  'error GangSwapNotOpen()', 'error GangSwapVersionChanged(address current)', 'error WrongGangSwapMigrator()',
  'event GangSwapCreated(address indexed token, address indexed migrator)',
  'event GangSwapMigratorSet(address indexed migrator)',
])
const GRAD_REFUSALS = parseAbi(['error GradNotOpen()', 'function claimGradReward(address token) returns (uint256 amount)'])
const KIND_ABI = parseAbi(['function kindOf(address token) view returns (uint8)'])
const CREATOR_ABI = parseAbi(['function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)'])
const MIGRATOR_ABI = parseAbi([
  'function factory() view returns (address)', 'function boost() view returns (address)',
  'event GangSwapMigrated(address indexed token, address indexed pair, address indexed pad, uint256 tokenAmount, uint256 seed, uint256 virtualReserve, uint256 lp)',
])
const FACTORY_ABI = parseAbi([
  'function fees() view returns (address)', 'function migrator() view returns (address)', 'function getPair(address, address) view returns (address)',
  'function INIT_CODE_PAIR_HASH() view returns (bytes32)',
])
const PAIR_ABI = parseAbi([
  'function token0() view returns (address)', 'function getReserves() view returns (uint112, uint112, uint32)',
  'function virtualReserve() view returns (uint256)', 'function realQuoteReserve() view returns (uint256)', 'function feeAccrued() view returns (uint256)',
  'event FeeTaken(uint256 feeQuote, uint256 feeTokenBurned)',
])
const BOOST_ABI = parseAbi([
  'function boosts(address token) view returns (address pair, uint64 lastStepAt, bool quoteIs0, uint128 v, uint128 left)',
  'event BoostRegistered(address indexed token, address indexed pair, uint256 v)',
  'event BoostStep(address indexed token, uint256 quoteIn, uint256 tokensBurned, uint256 left)',
])
export const GANGSWAP_FEES_ABI = parseAbi([
  'function CREATOR_BPS() view returns (uint256)', 'function creatorFeeOf(address token) view returns (uint256)',
  'function claim(address token, address to) returns (uint256 amount)',
  'error ZeroAddress()', 'error UnknownPair()', 'error NotCreator()', 'error ZeroAmount()',
  'event FeesCollected(address indexed pair, address indexed token, uint256 amount, uint256 toCreator)',
  // the pad's creator fee has an event of the same signature with `to` indexed too: the topic count tells them apart
  'event CreatorFeeClaimed(address indexed token, address indexed creator, address to, uint256 amount)',
])
export const GANGSWAP_ROUTER_ABI = parseAbi([
  'function factory() view returns (address)', 'function WETH() view returns (address)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
])
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)'])
/** What `gang tx` decodes a GangSwap tx's logs with. */
export const GANGSWAP_EVENT_ABIS = [GANGSWAP_PAD_ABI, MIGRATOR_ABI, BOOST_ABI, GANGSWAP_FEES_ABI, PAIR_ABI]
export const HINTS = {
  GangSwapNotOpen: 'GangSwap is not open on this network yet: leave --venue out (PancakeSwap)',
  GangSwapVersionChanged: 'the pad gives new tokens another GangSwap version now (reason: its migrator) than the one this create names, so nothing was created: re-run the create to see the new version and confirm it',
}

/** The pair's fee on the input, as GangSwapRouter computes with it: 1%. */
export const FEE_BPS = 100n
const BPS = 10_000n
const BOOST_STEPS = 40n
const BOOST_CAP_BPS = 50n
/** Share of the real quote liquidity from which a trade is warned about, in %. */
const LARGE_PCT = 10
// well above what a swap takes (about 150k–200k); used as the limit when the swap can't be estimated yet
const GAS_FLOOR = 300_000n

export const PANCAKE_WARNING = 'trade this token on its GangSwap pair only: a PancakeSwap pool of it was made by someone else, not by its graduation'
const UPDATE_CLI = 'update the CLI: npm i -g @gangfun/cli@latest'
const VENUE_LINE = 'trades on GangSwap after graduation, not PancakeSwap'

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
const short = (e) => e?.shortMessage || String(e?.message || e).split('\n')[0]
const isZero = (a) => !a || same(a, zeroAddress)
/** The contract answered with a revert (or had no such function), as opposed to the RPC failing (-32603 included). */
const isRevert = (e) => !e?.walk?.((x) => x?.code === -32603)
  && !!e?.walk?.((x) => ['ContractFunctionRevertedError', 'ContractFunctionZeroDataError', 'AbiDecodingZeroDataError', 'ExecutionRevertedError'].includes(x?.name) || x?.code === 3)
/** The distinct non-empty revert data an error carries, lowercased, in the shapes nodes nest it ({ data }, { data: { data } }, Parity's "Reverted 0x…", …). Never its messages. Pure. */
export function revertData(e) {
  const found = new Set()
  const dig = (d, depth) => {
    if (typeof d === 'string') {
      const m = /^(?:Reverted )?(0x(?:[0-9a-f]{2})+)$/i.exec(d.trim())
      if (m) found.add(m[1].toLowerCase())
    } else if (d && typeof d === 'object' && depth < 5) {
      for (const k of Object.keys(d)) if (['data', 'result', 'return', 'error', 'originalError', 'cause'].includes(k) || /^0x[0-9a-f]{64}$/i.test(k)) dig(d[k], depth + 1)
    }
  }
  for (let x = e, n = 0; x && typeof x === 'object' && n < 10; x = x.cause, n++) dig(x.data, 0)
  return [...found]
}
/** Whether a revert's data is there but in no shape revertData knows. Pure. */
function oddRevertData(e) {
  if (revertData(e).length) return false
  const odd = (d, depth = 0) => {
    if (typeof d === 'string') return /0x[0-9a-f]/i.test(d) || (depth === 0 && !/^(Reverted)?\s*$|^(Reverted )?0x$/i.test(d))
    if (Array.isArray(d)) return d.length > 0
    return !!d && typeof d === 'object' && (depth > 5 || Object.values(d).some((x) => odd(x, depth + 1)))
  }
  for (let x = e, n = 0; x && typeof x === 'object' && n < 10; x = x.cause, n++) if (odd(x.data)) return true
  return false
}
/** A revert that carries no data at all. geth also reports one as -32000 "execution reverted"; -32603 is the node's own failure. */
const bareRevert = (e) => !revertData(e).length && !oddRevertData(e)
  && (isRevert(e) || !!e?.walk?.((x) => x?.code === -32000 && /^execution reverted/i.test(x?.details ?? '')))
const rpcError = (what, e) => Object.assign(new PoolError(`RPC error while ${what}: ${short(e)}`, { hint: 're-run; set GANG_RPC_URL / GANG_TESTNET_RPC_URL if the RPC keeps failing' }), { rpc: true })

// ---------------------------------------------------------------- create

/**
 * Whether ctx's pad creates GangSwap tokens: { open: true, migrator } (the version a new token gets now) | { open: false,
 * why } | { unread }. A pad without gangSwapMigrator(), with it 0, or that keeps no version per token (no
 * gangSwapMigratorOf: its tokens could not be traded here) is not open; anything else that fails is the RPC.
 */
export async function gangSwapSupport(ctx) {
  const why = 'GangSwap is not open on this network yet'
  if (ctx.gen !== PAD3_GEN) return { open: false, why }
  let migrator
  try {
    migrator = await ctx.read(ctx.pad, GANGSWAP_PAD_ABI, 'gangSwapMigrator')
    if (!isZero(migrator)) await ctx.read(ctx.pad, GANGSWAP_PAD_ABI, 'gangSwapMigratorOf', [zeroAddress])
  } catch (e) {
    if (missingRead(e)) return { open: false, why }
    return { unread: short(e) }
  }
  return isZero(migrator) ? { open: false, why } : { open: true, migrator }
}

/**
 * Whether ctx's pad serves createGangSwapWithGradReward in the very shape the create will take (inside createWithSalt
 * with abcd on, inside createWithAgentWindow with `windowMinutes`): { open: true } | { open: false, why } | { unread }.
 * Nothing on the pad names the entry, so it is asked with an empty config, which it refuses as such (BadGradConfig)
 * before anything else. A pad without it answers a bare revert, a wrapper that does not list it its own error; only
 * those exact answers count, anything else is { unread } (the create is not built either way).
 */
export async function gangSwapGradSupport(ctx, windowMinutes = null) {
  const where = netOf(ctx) === 'mainnet' ? 'BSC mainnet' : 'the BSC testnet'
  const no = { open: false, why: `GangLaunchpad 3.0 on ${where} has no graduation reward for GangSwap tokens yet (the pad is not upgraded for it)` }
  if (ctx.gen !== PAD3_GEN) return no
  const none = { seed: 0n, minBuy: 0n, entries: 0, lastBps: 0, carryBps: 0, refundAfter: 0, promoteBps: 0, promoteWindow: 0 }
  let data = encodeFunctionData({ abi: GANGSWAP_PAD_ABI, functionName: 'createGangSwapWithGradReward', args: ['', '', '', '', 0n, zeroAddress, none] })
  try {
    if (await vanityDeployer(ctx)) data = encodeFunctionData({ abi: VANITY_ABI, functionName: 'createWithSalt', args: [`0x${'00'.repeat(32)}`, data] })
    if (windowMinutes !== null) data = wrapCreate(windowMinutes, data)
  } catch (e) { return { unread: short(e) } }
  // the raw request: viem's call() loses the error of a node that nests its revert data deeper than { data: { data } }
  const ask = (d) => ctx.client.request({ method: 'eth_call', params: [{ to: ctx.pad, data: d }, 'latest'] })
  try { await ask(data) } catch (e) {
    const got = revertData(e)
    if (got.length > 1) return { unread: 'the node returned conflicting revert data' }
    const is = (name) => got[0] === toFunctionSelector(`${name}()`)
    if (is('BadGradConfig')) return { open: true }
    if (is('GradNotOpen')) return { open: false, why: 'the graduation reward is closed on this pad' }
    if (is('BadVanityCall') || is('BadAgentWindowCall')) return no
    if (got.length) return { unread: `the pad answered an unexpected error (${got[0].slice(0, 10)})` }
    if (oddRevertData(e)) return { unread: 'the node returned revert data in a shape this CLI does not know' }
    if (!bareRevert(e)) return { unread: short(e) }
    // no revert data: a pad without the entry, or a node that drops it. A call every pad with a graduation reward refuses
    // with data (NotGradState) tells which
    const known = await ask(encodeFunctionData({ abi: GRAD_REFUSALS, functionName: 'claimGradReward', args: [zeroAddress] })).then(() => [], revertData)
    return known.length === 1 && known[0] === toFunctionSelector('NotGradState()') ? no : { unread: 'the RPC node does not return revert data' }
  }
  return { unread: 'the pad answered a create with an empty config without an error' }
}

/** What the create preview says about --venue gangswap. `gradReward`: with a graduation reward. */
export const gangSwapCreateView = (migrator, routerWarning = null, gradReward = false) => ({
  name: 'gangswap',
  ...(routerWarning && { routerWarning }),
  version: migrator,
  versionNote: `the GangSwap version is fixed at this create, for good: GangSwapMigrator ${migrator}. The create names it: if the pad gives new tokens another version before the tx lands, the tx reverts (GangSwapVersionChanged) and nothing is created. A later version never changes this token's pool, fees or router`,
  permanent: 'PERMANENT: the venue is fixed at this create, for good; nobody can move the token to PancakeSwap later',
  trading: `${VENUE_LINE}: only GangSwapRouter (gang buy / gang sell) and tools that support GangSwap trade it, and sites such as DexScreener may not list it. A PancakeSwap pool of this token would be someone else's`,
  buyBack: 'at graduation the part of the raise no trade could ever reach is replaced by an equal virtual reserve (the price curve stays the same), and that quote is used for a scheduled buy-back and burn: about 40 steps over about 5 minutes',
  fee: 'the pool takes a 1% fee on the input: on buys (paid in BNB) the creator gets 70% of it, claimed with gang creator-fee; on sells the fee is tokens, burned, and the creator gets nothing',
  terms: `WBNB quote, untaxed, no modules (no bond, promoter share, base, vault, countdown reward or recipient). ${gradReward ? 'With the graduation reward you fund (see gradReward): it is paid from your seed only, never from the curve, the fees, the GangSwap pool or its buy-back' : 'No graduation reward'}. The curve is an ordinary V3 one`,
})

/** The GangSwap create a tx input is, unwrapped from createWithSalt / createWithAgentWindow (decoded), or null. */
function gangSwapCall(input) {
  let data = input
  for (let i = 0; i < 3 && typeof data === 'string'; i++) {
    let d
    try { d = decodeFunctionData({ abi: [...GANGSWAP_PAD_ABI, ...VANITY_ABI, ...AGENT_WINDOW_ABI], data }) } catch { return null }
    if (d.functionName === 'createGangSwap' || d.functionName === 'createGangSwapWithGradReward') return d
    if (d.functionName !== 'createWithSalt' && d.functionName !== 'createWithAgentWindow') return null
    data = d.args[1]
  }
  return null
}
/** true when a tx input is (or wraps) createGangSwap / createGangSwapWithGradReward. */
export const asksGangSwap = (input) => !!gangSwapCall(input)

/**
 * Why a reverted GangSwap create reverted, when it was the version (GangSwapVersionChanged), closed (GangSwapNotOpen; the reward:
 * GradNotOpen) or the reward's seed (a bare revert, and the creator's WBNB or its allowance to the pad was short of it):
 * { gangSwap } to add to the result, else {}. Replays the call on the state before its block and on that block's own: the
 * state the tx ran on is somewhere between. `reverted` is said only when both give the cause (certain); one of them
 * alone is `mayBe`, with what the other allows left open. Best effort: anything else, or a node without that state, adds
 * nothing. `tx`: the transaction, or a function that reads it (called only for a reverted tx to a 3.0 pad).
 */
export async function gangSwapRevert(ctx, { status, to, tx }) {
  const pads = gangGens(netOf(ctx) === 'testnet').filter((g) => g.gen === PAD3_GEN).map((g) => g.pad)
  if (status !== 'reverted' || (to && !pads.some((p) => same(p, to)))) return {}
  try {
    const t = typeof tx === 'function' ? await tx() : tx
    const d = t?.blockNumber && pads.some((p) => same(p, t.to)) ? gangSwapCall(t.input) : null
    if (!d) return {}
    const before = await replayCause(ctx, t, d, t.blockNumber - 1n)
    if (before === null) return {}
    const at = await replayCause(ctx, t, d, t.blockNumber).catch(() => null)
    const c = before ?? at
    if (!c) return {}
    const certain = !!before && at?.error === before.error && (c.error !== SEED || at.kinds.some((k) => before.kinds.includes(k)))
    const kinds = certain && c.error === SEED ? before.kinds.filter((k) => at.kinds.includes(k)) : c.kinds
    const hint = c.error === SEED
      ? `the create pulls a ${c.seed} WBNB reward seed from the creator, ${certain ? 'but' : 'and on the state checked'} ${kinds.map((k) => (k === 'wbnb' ? `it held ${c.wbnb} WBNB` : `it had approved the pad for ${c.approved} WBNB`)).join(' and ')}`
      : c.hint
    return { gangSwap: {
      created: false, ...(certain ? { reverted: c.error } : { mayBe: c.error }), certain, ...(c.reason && { current: c.reason }), ...(c.error === SEED && { seed: c.seed, wbnb: c.wbnb, approved: c.approved }),
      hint: `${certain ? '' : 'it may be this, but the state changed around its block (or could not be read), so another cause, e.g. too little gas, is possible: '}${hint}${d.functionName === 'createGangSwapWithGradReward' ? `. ${earlierCreate(t.from, netOf(ctx) === 'testnet')}` : ''}`,
      source: `a replay of the call${c.error === SEED ? ' and the wallet\'s WBNB' : ''}, ${certain ? 'before its block and at it' : before ? 'before its block only' : 'at the end of its block only'}`,
    } }
  } catch { /* nothing to add */ }
  return {}
}
const SEED = 'seed not covered'
const earlierCreate = (from, testnet) => {
  const tn = testnet ? ' --testnet' : ''
  return `This transaction created nothing, but an earlier create from this wallet may already have succeeded and pulled the seed: check its tx hash (gang tx --hash <hash>${tn}) and the tokens this wallet created (gang creator-fee --from ${from}${tn}, unless it says scanNote or unreadNote: then the list is not complete) first, and re-run the create only once sure none succeeded, or it makes a second token and pays a second seed`
}

/** One replay of a reverted create at `blockNumber`: undefined when it passes, null when its failure is not one we name, else { error, … }. */
async function replayCause(ctx, t, d, blockNumber) {
  try {
    await ctx.client.call({ account: t.from, to: t.to, data: t.input, value: t.value, gas: t.gas, blockNumber })
    return undefined
  } catch (e) {
    const r = revertIn(e, [GANGSWAP_PAD_ABI, GRAD_REFUSALS], { ...HINTS, GradNotOpen: 'the graduation reward is closed on this pad: drop --grad-reward' })
    if (['GangSwapVersionChanged', 'GangSwapNotOpen', 'GradNotOpen'].includes(r?.error)) return r
    // a bare revert of a reward create: the pull of its seed, when the creator's WBNB or allowance was short of it there
    if (d.functionName !== 'createGangSwapWithGradReward' || !bareRevert(e)) return null
    const seed = d.args[6]?.seed
    const wbnb = padNets('v3')[netOf(ctx)].wbnb
    const ask = (functionName, args) => ctx.client.readContract({ address: wbnb, abi: ERC20_ABI, functionName, args, blockNumber })
    const [have, approved] = await Promise.all([ask('balanceOf', [t.from]), ask('allowance', [t.from, t.to])])
    const kinds = [have < seed && 'wbnb', approved < seed && 'approved'].filter(Boolean)
    const w = (x) => formatUnits(x, 18)
    return kinds.length ? { error: SEED, kinds, seed: w(seed), wbnb: w(have), approved: w(approved) } : null
  }
}

/** { input } of a landed tx that went to a 3.0 pad and made no GangSwap token, for gangSwapCreateCheck (inputUnread when it could not be read); { input: null } for any other. */
export async function createInput(ctx, receipt, events) {
  const pads = gangGens(netOf(ctx) === 'testnet').filter((g) => g.gen === PAD3_GEN).map((g) => g.pad)
  if (receipt.status !== 'success' || events.some((e) => e.event === 'GangSwapCreated') || !pads.some((p) => same(p, receipt.to))) return { input: null }
  return ctx.client.getTransaction({ hash: receipt.transactionHash }).then((t) => ({ input: t.input }), () => ({ input: null, inputUnread: true }))
}

/**
 * A landed create, checked: `events` as gang tx decodes them (event, contract, token, migrator), `input` the tx's calldata and
 * `sender` its from (null when unread). { gangSwap: … } to add to the result, or {} when the tx has nothing to do with a GangSwap create.
 */
export async function gangSwapCreateCheck(ctx, { status, events, input, inputUnread = false, sender = null }) {
  // only a GangLaunchpad 3.0 pad's own event counts
  const pads = gangGens(netOf(ctx) === 'testnet').filter((g) => g.gen === PAD3_GEN).map((g) => g.pad)
  const made = (events ?? []).filter((e) => e.event === 'GangSwapCreated' && pads.some((p) => same(p, e.contract)))
  if (!made.length) {
    if (status === 'success' && inputUnread) return { gangSwapUnread: 'the tx\'s input could not be read, so whether it was a GangSwap create is not checked' }
    if (status !== 'success' || !pads.length || !asksGangSwap(input)) return {}
    return { gangSwap: { verified: false, error: 'this tx asked for a GangSwap token, but no GangSwapCreated event of the pad is in its receipt: do not treat its token as one (gang info reads its kind)' } }
  }
  // one tx can make several (a contract or a batch): each is checked, and says whose it is
  const rows = await Promise.all(made.map(async ({ token, contract, migrator }) => {
    let kind, creator, own
    try {
      const [k, c, m] = await Promise.all([ctx.read(contract, KIND_ABI, 'kindOf', [token]), ctx.read(contract, CREATOR_ABI, 'curves', [token]),
        ctx.read(contract, GANGSWAP_PAD_ABI, 'gangSwapMigratorOf', [token]).catch((e) => { if (missingRead(e)) return null; throw e })])
      kind = Number(k)
      creator = c[0]
      own = m
    } catch (e) {
      return { token, migrator, verified: null, error: `could not read the token's kind, creator and GangSwap version (RPC error: ${short(e)})`, retry: 'same command again' }
    }
    const other = !!sender && !same(sender, creator) && { creatorIsSender: false, warning: 'this token\'s creator is not the wallet that sent the tx' }
    const row = { token, creator, kindOf: kind, migrator, ...other }
    if (kind !== GANGSWAP_KIND) return { ...row, verified: false, error: 'the pad emitted GangSwapCreated but kindOf is not 4: do not trade it as a GangSwap token' }
    if (isZero(own) || !same(own, migrator)) {
      return { ...row, gangSwapMigratorOf: own, verified: false, error: own === null ? 'the pad does not say which GangSwap version the token has (no gangSwapMigratorOf): not supported by this CLI' : 'the token\'s GangSwap version on the pad (gangSwapMigratorOf) is not the one in its GangSwapCreated event: do not trade it as a GangSwap token' }
    }
    return { ...row, kind: 'gangswap', verified: true, note: `the pad's GangSwapCreated event, kindOf and gangSwapMigratorOf agree: this token ${VENUE_LINE}, on this version (migrator), for good` }
  }))
  if (rows.length === 1) return { gangSwap: rows[0] }
  return { gangSwap: { verified: rows.some((x) => x.verified === false) ? false : rows.some((x) => x.verified === null) ? null : true, tokens: rows } }
}

// ---------------------------------------------------------------- addresses and state

/** `make()` once per ctx and `key` (a failed one is asked again). The keys carry the pad, so a ctx moved to another is safe. */
function cached(ctx, key, make) {
  ctx._gangSwap ??= new Map()
  const k = `${String(ctx.pad).toLowerCase()}:${key.toLowerCase()}`
  let p = ctx._gangSwap.get(k)
  if (!p) {
    p = make()
    ctx._gangSwap.set(k, p)
    p.catch(() => { if (ctx._gangSwap.get(k) === p) ctx._gangSwap.delete(k) })
  }
  return p
}

/** An address one of GangSwap's contracts names, or a PoolError (0, unreadable, RPC). */
async function askAddress(ctx, what, at, abi, fn, args = []) {
  let a
  try { a = await ctx.read(at, abi, fn, args) } catch (e) {
    if (!isRevert(e)) throw rpcError(`reading ${what}`, e)
    throw new PoolError(`${what} is not readable (${fn}): not supported by this CLI`, { pad: ctx.pad, hint: UPDATE_CLI })
  }
  if (isZero(a)) throw new PoolError(`${what} is not set (${fn} is 0)`, { pad: ctx.pad })
  return a
}

/** The GangSwapMigrator (version) `token` got at its create, for good. 0 is an error: never the version new tokens get. */
export const gangSwapMigratorOf = (ctx, token) => cached(ctx, `of:${token}`, () => askAddress(ctx, 'this token\'s GangSwap version', ctx.pad, GANGSWAP_PAD_ABI, 'gangSwapMigratorOf', [token]))

/** The contracts of `token`'s own GangSwap version, from the chain: { migrator, factory, boost, fees }. Throws a PoolError. */
export async function gangSwapSet(ctx, token) {
  const migrator = await gangSwapMigratorOf(ctx, token)
  return cached(ctx, `set:${migrator}`, async () => {
    const [factory, boost] = await Promise.all([
      askAddress(ctx, 'the GangSwap factory', migrator, MIGRATOR_ABI, 'factory'), askAddress(ctx, 'the GangSwap boost', migrator, MIGRATOR_ABI, 'boost'),
    ])
    return { migrator, factory, boost, fees: await askAddress(ctx, 'the GangSwap fees contract', factory, FACTORY_ABI, 'fees') }
  })
}

/** Byte-aligned occurrences of PUSH32 <hash> (0x7f + 32 bytes) in runtime code. Pure. */
export function countInitHash(code, hash) {
  const hay = String(code ?? '').toLowerCase().replace(/^0x/, ''), needle = `7f${String(hash).toLowerCase().replace(/^0x/, '')}`
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) if (i % 2 === 0) n++
  return n
}

/**
 * Runtime code with each PUSH32 of exactly `factory` / `weth` (left-padded) turned into a PUSH32 of zero: { hash, sites },
 * the keccak256 of the result and which of the two each was, in order. Nothing else in the code is touched. Pure.
 */
export function maskedRouter(code, factory, weth) {
  const hex = String(code ?? '').toLowerCase().replace(/^0x/, '')
  const push = (a) => `7f${'0'.repeat(24)}${String(a).toLowerCase().slice(2)}`
  const F = push(factory), W = push(weth)
  const zero = `7f${'0'.repeat(64)}`
  let out = '', sites = ''
  for (let i = 0; i < hex.length;) {
    const word = hex.slice(i, i + 66)
    if (word === F || word === W) { sites += word === F ? 'F' : 'W'; out += zero; i += 66 } else { out += hex.slice(i, i + 2); i += 2 }
  }
  return { hash: keccak256(`0x${out}`), sites }
}

/** One view of a contract; null when it has none (a revert), a PoolError on an RPC failure. */
async function viewOf(ctx, at, abi, fn, what) {
  try { return await ctx.read(at, abi, fn) } catch (e) {
    if (!isRevert(e)) throw rpcError(`reading ${what}`, e)
    return null
  }
}
const factoryOf = (ctx, router) => cached(ctx, `factory:${router}`, () => viewOf(ctx, router, GANGSWAP_ROUTER_ABI, 'factory', 'the GangSwap router'))

/**
 * The candidate routers whose factory() is `factory`. `all` false: a single candidate comes back as it is (verifyRouter reads
 * its factory() anyway and says what is wrong with it).
 */
async function routersFor(ctx, factory, all = true) {
  const list = candidates(netOf(ctx))
  if (!all && list.length < 2) return list
  let unread
  const seen = await Promise.all(list.map((c) => (isAddress(c.router) ? factoryOf(ctx, c.router).catch((e) => { unread = e; return null }) : null)))
  const fits = list.filter((_, i) => seen[i] && same(seen[i], factory))
  // a version's router that could not be read may be the one: never "this CLI knows none"
  if (!fits.length && unread) throw unread
  return fits
}

/** Every check of one candidate against the token's factory, once per ctx; a PoolError when it is not the router. */
const verifyRouter = (ctx, set, { router, builds, env }) => cached(ctx, `router:${set.factory}:${router}`, async () => {
  const net = netOf(ctx)
  const bad = (why) => new PoolError(`the router address ${router} is not this token's GangSwapRouter (${why}): nothing is built`, {
    router, hint: env ? `unset ${ROUTER_ENV[net]} (a development setting), then ${UPDATE_CLI}` : UPDATE_CLI,
  })
  if (!isAddress(router)) throw bad('not a 0x address')
  let code
  try { code = await ctx.client.getCode({ address: router }) } catch (e) { throw rpcError('reading the GangSwap router', e) }
  if (!code || code === '0x') throw bad(`no contract at it on chain ${ctx.chainId}`)
  const [factory, weth, hash] = await Promise.all([
    factoryOf(ctx, router), viewOf(ctx, router, GANGSWAP_ROUTER_ABI, 'WETH', 'the GangSwap router'),
    viewOf(ctx, set.factory, FACTORY_ABI, 'INIT_CODE_PAIR_HASH', 'the GangSwap factory'),
  ])
  if (!factory || !same(factory, set.factory)) throw bad(`its factory() is ${factory ?? 'not readable'}, this token's GangSwap factory is ${set.factory}: another version's router, or none`)
  if (!weth || !same(weth, ctx.wbnb)) throw bad(`its WETH() is ${weth ?? 'not readable'}, not this chain's WBNB`)
  if (!hash) throw bad('the GangSwap factory gave no INIT_CODE_PAIR_HASH()')
  const n = countInitHash(code, hash)
  if (n !== 1) throw bad(`its code has the factory's pair init code hash ${n} times, not once`)
  const m = maskedRouter(code, set.factory, ctx.wbnb)
  const build = builds.filter((b) => b.codeHash === m.hash)
  if (!build.length) throw bad('its code is not a GangSwapRouter build this CLI knows')
  if (!build.some((b) => b.sites === m.sites)) throw bad('its factory and WBNB are not where the GangSwapRouter build has them')
  return router
})

/**
 * For a create: what to say when no GangSwapRouter this run knows serves `migrator`'s version (checked as for a trade),
 * or when that could not be read; null when one does. Never refuses.
 */
export async function gangSwapRouterWarning(ctx, migrator) {
  const none = `this CLI version has no GangSwapRouter for this GangSwap version, so it could not trade the token after graduation: ${UPDATE_CLI} before creating, or check that another tool trades it`
  try {
    const factory = await askAddress(ctx, 'the GangSwap factory', migrator, MIGRATOR_ABI, 'factory')
    let unread = null
    for (const c of await routersFor(ctx, factory)) {
      try { await verifyRouter(ctx, { factory }, c); return null } catch (e) {
        if (!(e instanceof PoolError)) throw e
        if (e.rpc) unread ??= e
      }
    }
    if (unread) throw unread
    return none
  } catch (e) {
    return `could not read whether this CLI version has a GangSwapRouter for this GangSwap version (${short(e)}): run it again before creating`
  }
}

/**
 * The factory, fees, migrator and boost reachable from every router this run knows on `testnet` / mainnet (best effort):
 * { addresses, unread } where unread names the routers some of whose contracts could not be read.
 */
export async function gangSwapKnownContracts(ctx, testnet) {
  const addresses = [], unread = []
  for (const router of new Set(gangSwapRouterAddresses(testnet).map((a) => a.toLowerCase()))) {
    try {
      if (!isAddress(router)) throw new Error('not an address')
      const factory = await askAddress(ctx, 'the GangSwap factory', router, GANGSWAP_ROUTER_ABI, 'factory')
      addresses.push(factory)
      const [fees, migrator] = await Promise.allSettled(['fees', 'migrator'].map((f) => askAddress(ctx, 'a GangSwap contract', factory, FACTORY_ABI, f)))
      if (fees.status === 'fulfilled') addresses.push(fees.value)
      if (migrator.status === 'fulfilled') {
        addresses.push(migrator.value)
        addresses.push(await askAddress(ctx, 'the GangSwap boost', migrator.value, MIGRATOR_ABI, 'boost'))
      }
      if (fees.status !== 'fulfilled' || migrator.status !== 'fulfilled') unread.push(router)
    } catch { unread.push(router) }
  }
  return { addresses, unread }
}

/**
 * The GangSwapRouter for a trade of `token` in `pair`, or a PoolError: the known version (or the env's router) whose
 * factory() is the token's own factory, whose WETH() is this chain's WBNB, whose bytecode has that factory's pair init
 * code hash exactly once and IS a known GangSwapRouter build with that factory and WBNB; and the factory's pair of the
 * token is the one the pad recorded. A router of another version is never used.
 */
export async function checkRouter(ctx, token, pair) {
  const net = netOf(ctx)
  if (!candidates(net).length) {
    throw new PoolError('no GangSwapRouter address for this network in this CLI version: this token trades on GangSwap only, and no other router is used for it', { hint: UPDATE_CLI })
  }
  const set = await gangSwapSet(ctx, token)
  const fits = await routersFor(ctx, set.factory, false)
  if (!fits.length) {
    throw new PoolError(`this CLI version knows no GangSwapRouter of this token's GangSwap version (GangSwapMigrator ${set.migrator}): nothing is built, and no other version's router is used for it`, { migrator: set.migrator, hint: UPDATE_CLI })
  }
  let router, failed
  for (const c of fits) {
    try { router = await verifyRouter(ctx, set, c); break } catch (e) {
      if (!(e instanceof PoolError)) throw e
      failed ??= e
    }
  }
  if (!router) throw failed
  let listed
  try { listed = await ctx.read(set.factory, FACTORY_ABI, 'getPair', [token, ctx.wbnb]) } catch (e) {
    if (!isRevert(e)) throw rpcError('reading the GangSwap factory', e)
    listed = null
  }
  if (isZero(pair) || isZero(listed) || !same(listed, pair)) {
    throw new PoolError(`the GangSwap factory's pair of this token (${listed ?? 'not readable'}) is not the pair the pad recorded (${pair ?? 'none'}): nothing is built`, { factory: set.factory, pair: pair ?? null })
  }
  return router
}

/** The pair's reserves: { rq, rt } effective, `real` quote that can be paid out, `virtual`, `feeAccrued` (raw wei). */
export async function pairState(ctx, token, pair) {
  try {
    const [[r0, r1], t0, real, virtual, feeAccrued] = await Promise.all([
      ctx.read(pair, PAIR_ABI, 'getReserves'), ctx.read(pair, PAIR_ABI, 'token0'), ctx.read(pair, PAIR_ABI, 'realQuoteReserve'),
      ctx.read(pair, PAIR_ABI, 'virtualReserve'), ctx.read(pair, PAIR_ABI, 'feeAccrued'),
    ])
    const [rt, rq] = same(t0, token) ? [r0, r1] : [r1, r0]
    return { rq: BigInt(rq), rt: BigInt(rt), real, virtual, feeAccrued }
  } catch (e) {
    if (!isRevert(e)) throw rpcError('reading the GangSwap pair', e)
    throw new PoolError('the pair on record does not answer as a GangSwap pair: nothing is built', { pair })
  }
}

/** GangSwapRouter's getAmountOut: the 1% fee on the input, effective reserves. */
export function amountOut(amountIn, reserveIn, reserveOut) {
  const net = amountIn * (BPS - FEE_BPS)
  return (net * reserveOut) / (reserveIn * BPS + net)
}
const pct = (num, den) => (den > 0n ? Number((num * 1_000_000n) / den) / 10_000 : null)

/** The price impact (the fee apart) and what the trade is of the real quote liquidity. `quoteSide`: wei of WBNB in / out. */
function sizeOf(amountIn, reserveIn, quoteSide, s) {
  const net = (amountIn * (BPS - FEE_BPS)) / BPS
  return { priceImpactPct: pct(net, reserveIn + net), pctOfRealLiquidity: pct(quoteSide, s.real) }
}

const shownLiquidity = (s) => ({
  effectiveBnb: formatUnits(s.rq, 18), effectiveTokens: formatUnits(s.rt, 18), realBnb: formatUnits(s.real, 18), virtualBnb: formatUnits(s.virtual, 18),
})

/** gang info / status: the pool, the scheduled buy-back and the warning. `c`: curveOf's. Never throws. */
export async function gangSwapView(ctx, token, c) {
  const base = { warning: PANCAKE_WARNING }
  if (!c.graduated) {
    const version = await gangSwapMigratorOf(ctx, token).then((migrator) => ({ migrator }), (e) => ({ error: `could not read the token's GangSwap version (${e.message})`, retry: 'same command again' }))
    return { graduatesTo: 'GangSwap', ...version, note: `on its curve; ${VENUE_LINE}, on this version (migrator), fixed at create: 1% pool fee, 70% of it on buys to the creator`, ...base }
  }
  try {
    const set = await gangSwapSet(ctx, token)
    const [s, b] = await Promise.all([
      pairState(ctx, token, c.pair),
      ctx.read(set.boost, BOOST_ABI, 'boosts', [token]).catch((e) => { throw rpcError('reading the scheduled buy-back', e) }),
    ])
    const [bPair, lastStepAt, , v, left] = b
    const spent = v - left
    const perStep = v / BOOST_STEPS
    const cap = (s.rq * BOOST_CAP_BPS) / BPS
    const next = cap < perStep ? cap : perStep
    const net = netOf(ctx)
    // the router is beside the point here: one that can't be read leaves the rest as it is
    let routerUnread = null
    const fit = (await routersFor(ctx, set.factory).catch((e) => { routerUnread = e.message; return [] }))[0]
    const router = fit?.env ? null : fit?.router
    return {
      pair: c.pair, migrator: set.migrator, factory: set.factory, fees: set.fees, router: router ?? null,
      ...(fit?.env && { routerFromEnv: fit.router, routerVerified: false, routerNote: `${ROUTER_ENV[net]} names this router; it is not verified here (gang buy / gang sell check its code before they build anything)` }),
      ...(routerUnread && { routerUnread }),
      ...(!fit && !routerUnread && { routerNote: `no GangSwapRouter of this token's GangSwap version in this CLI version: gang buy / gang sell need one; ${UPDATE_CLI}` }),
      poolFeePct: Number(FEE_BPS) / 100,
      liquidity: { ...shownLiquidity(s), note: 'prices follow the effective reserves (real + virtual); only the real BNB can be paid out' },
      buyBack: isZero(bPair) ? { error: 'the boost has no record of this token' } : {
        totalBnb: formatUnits(v, 18), spentBnb: formatUnits(spent, 18), leftBnb: formatUnits(left, 18), finished: left === 0n,
        stepsDoneApprox: perStep > 0n ? Number((spent + perStep / 2n) / perStep) : 0, stepsPlanned: Number(BOOST_STEPS),
        ...(left > 0n && next > 0n && { stepsLeftApprox: Number((left + next - 1n) / next) }),
        lastStepAt: Number(lastStepAt) ? new Date(Number(lastStepAt) * 1000).toISOString() : null,
        note: 'a fixed schedule set at graduation: each step buys the token from its pair and burns it',
      },
      ...base,
    }
  } catch (e) {
    return { pair: c.pair, error: `could not read the GangSwap pool (${e.message})`, retry: 'same command again', ...base }
  }
}

/** What selling `amount` on the pair pays now, from its effective reserves; null when it can't be read. */
export async function gangSwapSellQuote(ctx, token, pair, amount) {
  try {
    const s = await pairState(ctx, token, pair)
    return { out: amountOut(amount, s.rt, s.rq), real: s.real, quotedWith: 'getReserves (effective), 1% fee' }
  } catch { return null }
}

// ---------------------------------------------------------------- creator fee of the pool

/** The creator's part of the pool fee: { fees, sharePct, collected, uncollected, claimable } raw; throws a PoolError. */
export async function gangSwapFeeOf(ctx, token, pair) {
  const { fees } = await gangSwapSet(ctx, token)
  try {
    const [bps, collected, accrued] = await Promise.all([
      ctx.read(fees, GANGSWAP_FEES_ABI, 'CREATOR_BPS'), ctx.read(fees, GANGSWAP_FEES_ABI, 'creatorFeeOf', [token]), ctx.read(pair, PAIR_ABI, 'feeAccrued'),
    ])
    const uncollected = (accrued * bps) / BPS
    return { fees, sharePct: Number(bps) / 100, collected, uncollected, claimable: collected + uncollected }
  } catch (e) { throw rpcError('reading the GangSwap creator fee', e) }
}

/** It as info / status / creator-fee show it; { error } when it can't be read; null before graduation. */
export async function gangSwapFeeView(ctx, token, { graduated, pair }, net = '') {
  if (!graduated) return { claimable: '0', claimableRaw: '0', note: 'starts at graduation: 70% of the 1% GangSwap fee on buys' }
  try {
    const f = await gangSwapFeeOf(ctx, token, pair)
    return {
      contract: f.fees, sharePct: f.sharePct, claimable: formatUnits(f.claimable, 18), claimableRaw: f.claimable.toString(),
      collected: formatUnits(f.collected, 18), uncollected: formatUnits(f.uncollected, 18), quote: 'WBNB',
      ...(f.claimable > 0n && { claim: `gang creator-fee --token ${token}${net} --claim --part pool (the creator only)` }),
      note: `${f.sharePct}% of the 1% GangSwap fee on buys; sells pay the creator nothing (their fee is tokens, burned). A claim collects the rest from the pair first`,
    }
  } catch (e) {
    return { error: `could not read the GangSwap creator fee (${e.message})`, retry: `gang creator-fee --token ${token}${net}` }
  }
}

// ---------------------------------------------------------------- trades

/** A failed call in words: `revertOf` (the command's own) with GangSwap's revert strings, which carry no error name. */
const failedOf = (e, revertOf) => {
  const text = `${e?.walk?.((x) => typeof x?.reason === 'string')?.reason ?? ''} ${e?.details ?? ''} ${short(e)}`
  const m = text.match(/GangSwap(?:Router|Library)?: [A-Z_]+|GangSwap: K/)
  if (m) {
    const hint = /INSUFFICIENT_OUTPUT_AMOUNT/.test(m[0]) ? 'the price moved past --slippage; re-run to re-quote, or raise --slippage'
      : /EXPIRED/.test(m[0]) ? 'the tx landed after its deadline (30 min after the preview): re-run the command for a fresh one' : undefined
    return { error: m[0], ...(hint && { hint }) }
  }
  return revertOf(e) || { error: short(e) }
}

/**
 * Build a trade on the token's GangSwap pair through GangSwapRouter. Returns the object the command prints, shaped as a
 * pool trade (step pool-buy / pool-sell).
 *  p: { side, token, pair, me, amount (decimal string; sell: null with all), all, slippage, payBnb (buy), toBnb (sell),
 *       base (fields every step carries), bond (sell, as poolTrade's) }
 *  io: { rawOnly, summarize, revertOf }
 */
export async function gangSwapTrade(ctx, p, io) {
  try {
    return await build(ctx, p, io)
  } catch (e) {
    if (!(e instanceof PoolError)) throw e
    return { success: false, ...(p.base || {}), step: `pool-${p.side}`, venue: 'gangswap', error: e.message, ...e.fields }
  }
}

async function build(ctx, p, { rawOnly, summarize, revertOf }) {
  const { side, token, pair, me, slippage, base = {} } = p
  const failOut = (o) => ({ success: false, ...base, venue: 'gangswap', ...o })
  const router = await checkRouter(ctx, token, pair)
  const s = await pairState(ctx, token, pair)
  const deadline = routerDeadline()
  const large = (pctReal, side) => (pctReal === null ? { warning: `the pool holds no real BNB now: ${side === 'buy' ? 'what this buy pays in becomes all of it' : 'it can\'t pay this sell'}` }
    : pctReal >= LARGE_PCT ? { warning: `large against the pool's real liquidity (${formatUnits(s.real, 18)} BNB): this ${side} is ${pctReal}% of it; expect a big price move` } : {})
  let call, value = 0n, pull = null, fields, guard = null, floor
  if (side === 'buy') {
    const amountIn = parseUnits(p.amount, 18)
    if (amountIn === 0n) throw new PoolError(`--amount ${p.amount} rounds to 0 in BNB`)
    const expect = amountOut(amountIn, s.rq, s.rt)
    const minOut = minOf(expect, slippage)
    floor = minOut
    if (minOut === 0n) throw new PoolError('this buy would get 0 tokens: raise --amount')
    const path = [ctx.wbnb, token]
    if (p.payBnb) {
      const native = await ctx.client.getBalance({ address: me }).catch((e) => { throw rpcError('reading the BNB balance', e) })
      if (native < amountIn + GAS_RESERVE) {
        return failOut({
          step: 'pool-buy', error: 'not enough BNB for this buy (native BNB must also cover gas)',
          haveBnb: formatUnits(native, 18), needBnb: formatUnits(amountIn, 18), reserveForGas: formatUnits(GAS_RESERVE, 18), hint: 'add --use-quote to pay from WBNB instead',
        })
      }
      call = { functionName: 'swapExactETHForTokens', args: [minOut, path, me, deadline] }
      value = amountIn
    } else {
      call = { functionName: 'swapExactTokensForTokens', args: [amountIn, minOut, path, me, deadline] }
      pull = { token: ctx.wbnb, need: amountIn, sym: 'WBNB', approveStep: 'approve-quote' }
    }
    const size = sizeOf(amountIn, s.rq, amountIn, s)
    fields = {
      step: 'pool-buy', venue: 'gangswap', via: 'gangswap-router', router, pair, function: call.functionName,
      // the amount the tx carries (--amount may have more decimals than 18)
      spend: formatUnits(amountIn, 18), payWith: p.payBnb ? 'BNB' : 'WBNB', quote: 'WBNB', path, poolFeePct: Number(FEE_BPS) / 100,
      expectTokens: formatUnits(expect, 18), minTokensOut: formatUnits(minOut, 18), slippagePct: slippage, deadline: Number(deadline),
      quotedWith: 'getReserves (effective), 1% fee', ...size, liquidity: shownLiquidity(s),
      ...large(size.pctOfRealLiquidity, 'buy'),
      note: `the tokens go straight to ${me}; minTokensOut = the pair's effective reserves after the 1% fee, less --slippage (the buy reverts below it)`,
    }
  } else {
    const bal = await ctx.read(token, ERC20_ABI, 'balanceOf', [me]).catch((e) => { throw rpcError('reading the token balance', e) })
    if (bal === 0n) return failOut({ step: 'pool-sell', error: 'no balance to sell', wallet: me })
    const amount = p.all ? bal : parseUnits(p.amount, 18)
    if (amount === 0n) throw new PoolError(`--amount ${p.amount} rounds to 0 tokens`)
    if (amount > bal) return failOut({ step: 'pool-sell', error: 'amount exceeds balance', balance: formatUnits(bal, 18) })
    // GangBond and GangCallBond take no GangSwap token; checked as any pool sell all the same
    if (p.bond) {
      guard = await bondGuard(ctx, { token, me, amount, ...p.bond }, rawOnly, summarize)
      const callGuard = await callBondGuard(ctx, { token, me, amount, testnet: p.bond.testnet, breakBond: p.bond.breakCallBond })
      if (guard?.refuse || callGuard?.refuse) {
        return failOut({ step: 'pool-sell', wallet: me, ...(guard?.refuse ?? callGuard.refuse), ...(guard?.refuse && callGuard?.refuse && { callBond: callGuard.refuse }) })
      }
      if (guard?.settleStep) return guard.settleStep
      if (callGuard?.info) guard = { ...guard, info: { ...guard?.info, ...callGuard.info } }
    }
    const expect = amountOut(amount, s.rt, s.rq)
    const minOut = minOf(expect, slippage)
    floor = minOut
    if (minOut === 0n) throw new PoolError('this sell would pay 0: raise --amount')
    if (expect > s.real) {
      return failOut({ step: 'pool-sell', error: `this sell prices at ${formatUnits(expect, 18)} BNB, more than the pool's real liquidity (${formatUnits(s.real, 18)} BNB): it can't be paid, so nothing is built`, liquidity: shownLiquidity(s) })
    }
    const path = [token, ctx.wbnb]
    call = { functionName: p.toBnb ? 'swapExactTokensForETH' : 'swapExactTokensForTokens', args: [amount, minOut, path, me, deadline] }
    pull = { token, need: amount, sym: null, approveStep: 'approve' }
    const size = sizeOf(amount, s.rt, expect, s)
    fields = {
      step: 'pool-sell', venue: 'gangswap', via: 'gangswap-router', router, pair, function: call.functionName,
      amount: formatUnits(amount, 18), receive: p.toBnb ? 'BNB' : 'WBNB', quote: 'WBNB', path, poolFeePct: Number(FEE_BPS) / 100,
      expectOut: formatUnits(expect, 18), minOut: formatUnits(minOut, 18), slippagePct: slippage, deadline: Number(deadline),
      quotedWith: 'getReserves (effective), 1% fee', ...size, liquidity: shownLiquidity(s), ...guard?.info,
      ...large(size.pctOfRealLiquidity, 'sell'),
      note: 'minOut = the pair\'s effective reserves after the 1% fee, less --slippage (the sell reverts below it); the pool can never pay out more than its real BNB',
    }
  }
  const swap = { from: me, to: router, data: encodeFunctionData({ abi: GANGSWAP_ROUTER_ABI, ...call }), value }
  const pre = pull ? await fundingOf(ctx, { me, ...pull, spender: router }) : { steps: [] }
  if (pre.error) return failOut({ step: fields.step, ...pre.error })
  const extra = { chainId: Number(ctx.chainId), token, ...base }

  if (pre.steps.length) {
    if (rawOnly) {
      const steps = [...pre.steps.map((x) => ({ ...x.meta, tx: rawTx(ctx, x.tx) })), { step: fields.step, function: fields.function, tx: rawTx(ctx, { ...swap, gas: GAS_FLOOR }) }]
      return {
        success: true, ...extra, ...fields, step: steps[0].step, steps, tx: steps[0].tx,
        note: `send the ${steps.length} txs in steps[] in order (tx = the first); the ${fields.step} is not simulated until the ${steps.slice(0, -1).map((x) => x.step).join(' / ')} is mined. ${fields.note}`,
      }
    }
    const first = pre.steps[0]
    return step(ctx, first.tx, {
      ...extra, venue: 'gangswap', ...first.meta, next: fields.step, ...(fields.warning && { warning: fields.warning }),
      then: { function: fields.function, ...(side === 'buy' ? { spend: fields.spend, minTokensOut: fields.minTokensOut } : { amount: fields.amount, minOut: fields.minOut }) },
      note: `${first.meta.note ? `${first.meta.note}. ` : ''}after executing, re-run the same command for the ${pre.steps.length > 1 ? 'next step' : fields.step}`,
    }, false, summarize)
  }
  // eth_call the swap: a revert names the reason and builds no preview
  const reverted = (e) => failOut({
    ...extra, ...fields, reverted: true, ...failedOf(e, revertOf),
    ...(rawOnly && { doNotSend: true, unsentTxForInspection: rawTx(ctx, swap), txNote: 'DO NOT SEND: the simulation reverted; shown for inspection only' }),
  })
  let data
  try {
    ({ data } = await ctx.client.call({ account: me, to: swap.to, data: swap.data, value: swap.value }))
  } catch (e) {
    if (!isRevert(e) && !isMissingFunction(e)) throw rpcError('simulating the trade', e)
    return reverted(e)
  }
  // what the router says it paid: anything else than a swap's answer of at least the minimum builds nothing
  let got
  try {
    const amounts = decodeFunctionResult({ abi: GANGSWAP_ROUTER_ABI, functionName: call.functionName, data })
    got = amounts.length === 2 ? amounts[1] : null
  } catch { got = null }
  if (got === null || got < floor) {
    return failOut({
      ...extra, ...fields, error: got === null ? 'the simulated trade did not answer as a GangSwapRouter swap: nothing is built' : `the simulated trade pays ${formatUnits(got, 18)}, less than the minimum: nothing is built`,
      ...(rawOnly && { doNotSend: true, unsentTxForInspection: rawTx(ctx, swap), txNote: 'DO NOT SEND: the simulation did not pay the minimum; shown for inspection only' }),
    })
  }
  try { swap.gas = await roomyGas(ctx, swap, GAS_FLOOR) } catch (e) { return reverted(e) }
  return step(ctx, swap, { ...extra, ...fields, gasLimit: swap.gas.toString() }, rawOnly, summarize)
}

/** Revert names of the fees contract, for creatorfee.js. */
export const feesRevertOf = (e, hints) => revertIn(e, [GANGSWAP_FEES_ABI], hints)
