import { createPublicClient, parseAbi, encodeFunctionData, decodeEventLog, formatUnits, parseUnits, isAddress, zeroAddress } from 'viem'
import { decimalsOf, defaultRefPool, dividendOf, VAULT_ABI, fundingStep as fund, parseAmount, parseNum, poolSellQuote, POOL_SELL_HINT, revertOf as revertIn, ROUTER_ABI as GANG_ROUTER_ABI, ROUTER_HINTS, routerDeadline, step, swapBackState, units, viaRouter, GAS_RESERVE } from './steps.js'
import { API } from './discover.js'
import { UA } from './version.js'
import { walletFor } from './fair.js'
import { MERGED_ERRORS_ABI, MERGED_HINTS, NOT_ON_MAINNET, notThisKind, padNets, rpcTransport } from './gangpad.js'
import { poolPayBnb, poolTrade } from './pool.js'
import { bondGuard } from './bond.js'
import { splitterOf } from './buyback.js'
import { splitOf } from './split.js'
import { lpOf } from './lp.js'
import { comboOf, decoyWarning } from './combo.js'

/**
 * `gang v3 …` — LaunchpadV3 (tax recipient): a token with its own buy / sell tax (1–5% each), a dividend share and a
 * recipient (the creator itself, or a whitelisted partner such as its treasury) paid in the quote token. The tax is charged only in the PancakeSwap
 * pool after graduation (the platform keeps 0.5% of that volume); curve trades pay only the 1% fee, no tax.
 * Contracts: gang-launchpad GangLaunchpad (merged pad: V3 curves and 打新 sales on one address; see gangpad.js).
 * Mainnet needs a pad address (GANG_PAD or the one shipped in gangpad.js); without it mainnet answers "no mainnet address".
 */
export const V3_NETS = padNets('v3')

const TAX = '(uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)'
const PAD_ABI = parseAbi([
  `function create(string name, string symbol, string logoURI, string metaURI, address quote, address refPool, ${TAX} tax) returns (address)`,
  'function buy(address token, uint256 quoteIn, uint256 minTokensOut) returns (uint256)',
  'function sell(address token, uint256 tokensIn, uint256 minQuoteOut) returns (uint256)',
  `function checkTaxConfig(${TAX} tax) view returns (bool ok, string reason)`,
  `function checkTaxConfigFor(address creator, ${TAX} tax) view returns (bool ok, string reason)`,
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)',
  'function isAgent(address account) view returns (bool)',
  'function walletRoom(address token, address buyer) view returns (uint256)',
  'function graduationRemaining(address token) view returns (uint256)',
  'function graduationAmountOf(address quote, address refPool) view returns (uint256)',
  'function taxHandler() view returns (address)',
  'function dividendVault() view returns (address)',
  'function router() view returns (address)',
  'function recipientRegistry() view returns (address)',
  'function PROTOCOL_FEE_BPS() view returns (uint256)',
  'function PLATFORM_TAX_BPS() view returns (uint256)',
  'error UnknownToken()', 'error AlreadyGraduated()', 'error ZeroAmount()', 'error GradAmtTooSmall()', 'error Slippage()',
  'error MigratorNotSet()', 'error ZeroAddress()', 'error NotAgent()', 'error WalletCapReached()', 'error RefPoolRequired()',
  'error NoBridgePool()', 'error BridgeNotWbnb()', 'error BadTaxConfig(string reason)',
  'error PoolNotFactory()', 'error QuoteNotInPool()', 'error PoolNoLiquidity()', 'error ThinReferencePool()', 'error NotContract()',
  'error UnknownPoolType()', 'error QuoteNotAllowed()', 'error RouterNeedsGate()', 'error V3FactoryNotSet()', 'error GradAmtZero()',
  'error VaultFloorTooHigh()',
  'event Created(address indexed token, address indexed creator, string name, string symbol, string logoURI, address indexed quote, address refPair, uint256 gradAmt)',
  'event TaxConfigured(address indexed token, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address indexed recipient)',
  'event Buy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 protocolFee, uint256 tax, uint256 tokensOut, uint256 realQuote)',
  'event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 protocolFee, uint256 tax, uint256 quoteOut, uint256 realQuote)',
  'event Graduated(address indexed token, address indexed pair, address quote, uint256 tokenAmount, uint256 quoteAmount)',
])
const TAX_ROUTER_ABI = parseAbi([
  'function owedOf(address token) view returns (uint256)',
  'function release(address token) returns (uint256)',
  'error NothingOwed()',
  'event TaxDistributed(address indexed token, uint8 phase, uint256 amount, uint256 toPlatform, uint256 toDividend, uint256 toRecipient)',
  'event TaxPaid(address indexed token, address indexed recipient, address indexed quote, uint256 amount)',
  'event TaxOwed(address indexed token, address indexed recipient, address indexed quote, uint256 amount)',
])
const REGISTRY_ABI = parseAbi([
  'function isListed(address recipient) view returns (bool)',
  'function entries(address recipient) view returns (bool listed, uint64 listedAt, string label)',
])
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
])
const PAIR_ABI = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)'])

// what to tell the agent for each pad error
const HINTS = {
  BadTaxConfig: 'a tax setting is out of bounds, or the recipient is neither you nor on the whitelist: see reason',
  NotAgent: 'this wallet holds no Agent ID; V3 create and curve trades are Agent-only',
  WalletCapReached: 'this wallet already holds the per-wallet cap (1% of supply)',
  AlreadyGraduated: 'the token graduated: re-run gang buy / gang sell, which now trade it in the PancakeSwap pool',
  Slippage: 'the price moved past --slippage; re-run to re-quote',
  RefPoolRequired: 'a non-WBNB --quote needs --ref-pool: a Pancake V2 pair or V3 pool that holds the quote token',
  QuoteNotInPool: '--ref-pool does not contain the --quote token',
  ThinReferencePool: '--ref-pool is too shallow; pick the deepest pool for this quote',
  GradAmtTooSmall: 'the quote token is priced so high that the graduation amount rounds below the minimum',
  NothingOwed: 'the router owes this token\'s recipient nothing',
  QuoteNotAllowed: '--quote must be WBNB or an 18-decimal ERC-20 token (leave it out to use WBNB)',
  PoolNotFactory: '--ref-pool is not a PancakeSwap V2 pair / V3 pool',
  NotContract: '--ref-pool is not a contract',
  UnknownPoolType: '--ref-pool is not a PancakeSwap V2 pair / V3 pool',
  PoolNoLiquidity: '--ref-pool has no liquidity',
  V3FactoryNotSet: 'V3 pools are not enabled on this pad yet; use a Pancake V2 pair as --ref-pool',
  NoBridgePool: '--ref-pool pairs the quote with a token that has no bridge to WBNB here; pick a pool against WBNB (or USDT on mainnet)',
  BridgeNotWbnb: 'the bridge pool for this --ref-pool is misconfigured; pick a pool against WBNB',
  GradAmtZero: 'the quote token is priced so high that the target rounds to 0',
  RouterNeedsGate: 'the router path is off while the Agent gate is off; re-run with --use-wbnb to buy directly',
  // not a create flag: the shared dividend vault's holding floor for this pad was raised above what V3 allows (10,000 tokens)
  VaultFloorTooHigh: 'the platform\'s dividend vault requires a larger holding than V3 dividends allow (10,000 tokens), so a dividend token can\'t be created right now; --dividend 0 still works, or ask gang to fix the vault setting',
}

/** What `gang tx` decodes a V3 trade's logs with (the pad, the tax router, the dividend vault). */
export const V3_EVENT_ABIS = [PAD_ABI, TAX_ROUTER_ABI, VAULT_ABI]

export function v3Ctx(testnet) {
  const net = V3_NETS[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const symbolOf = async (ctx, token) => { try { return await ctx.read(token, ERC20_ABI, 'symbol') } catch { return null } }
const pct = (bps) => Number(bps) / 100
const VIRTUAL_TOKEN = 1_066_666_666_666_666_666_666_666_667n
const ceilDiv = (a, b) => (a + b - 1n) / b

/** Revert name (+ BadTaxConfig reason) of a failed call, or null when it was the RPC. */
const revertOf = (e) => revertIn(e, [PAD_ABI, TAX_ROUTER_ABI, GANG_ROUTER_ABI, MERGED_ERRORS_ABI], { ...MERGED_HINTS, ...ROUTER_HINTS, ...HINTS })

/** eth_call `data` from `from`: { result } when it passes, { failed } with the revert (or RPC error) otherwise. */
async function simulate(ctx, from, to, abi, functionName, args, value = 0n) {
  try {
    const { result } = await ctx.client.simulateContract({ account: from, address: to, abi, functionName, args, value })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

/**
 * Where the tax split / owed pushes (router) and the recipient whitelist (registry) live: one TaxHandlerV3 since the
 * contract merge, so both are taxHandler(). 旧部署兼容，第 6 套上线后可删: older pads keep them on router() /
 * recipientRegistry() (TaxRouterV3 / RecipientRegistry).
 */
async function taxContracts(ctx) {
  if (!ctx._tax) {
    ctx._tax = (async () => {
      const handler = await ctx.read(ctx.pad, PAD_ABI, 'taxHandler')
      const [router, registry] = await Promise.all(['router', 'recipientRegistry']
        .map((fn) => ctx.read(ctx.pad, PAD_ABI, fn).catch(() => handler)))
      return { handler, router, registry }
    })()
  }
  return ctx._tax
}

/** The call hit a contract without this function: a bare revert (no error data) or an empty return. */
function noSuchFunction(e) {
  if (e?.walk?.((x) => x?.name === 'ContractFunctionZeroDataError')) return true
  const r = e?.walk?.((x) => x?.name === 'ContractFunctionRevertedError')
  return !!r && !r.data && (!r.raw || r.raw === '0x')
}

/** The whitelist label of a recipient; null when unlisted or the whitelist keeps no entries() (labels only in events). */
async function labelOf(ctx, registry, recipient) {
  try { return (await ctx.read(registry, REGISTRY_ABI, 'entries', [recipient]))[2] || null } catch { return null }
}

/** A token's curve and tax as the pad stores them, plus the recipient's whitelist label. null when not a V3 token. */
export async function curveOf(ctx, token) {
  const c = await ctx.read(ctx.pad, PAD_ABI, 'curves', [token])
  const [creator, quote, realQuote, sold, gradAmt, virtualQuote, graduated, buyTaxBps, sellTaxBps, dividendBps, pair] = c
  if (creator === zeroAddress) return null
  // the recipient is not in curves(): it lives on the tax handler's route, read back through taxConfigOf
  const [{ handler, router, registry }, remaining, tax] = await Promise.all([
    taxContracts(ctx),
    ctx.read(ctx.pad, PAD_ABI, 'graduationRemaining', [token]), ctx.read(ctx.pad, PAD_ABI, 'taxConfigOf', [token]),
  ])
  const recipient = tax[3] === zeroAddress ? null : tax[3]
  // §22: the creator may be its own recipient without a listing; say so, the platform did not review it
  const recipientIsCreator = !!recipient && recipient.toLowerCase() === creator.toLowerCase()
  let label = null
  if (recipient && !recipientIsCreator) label = await labelOf(ctx, registry, recipient)
  const owed = await ctx.read(router, TAX_ROUTER_ABI, 'owedOf', [token])
  // graduation zeroes realQuote (it went into the pool): a graduated token is priced from the pair reserves
  let price = ((virtualQuote + realQuote) * 10n ** 18n) / (VIRTUAL_TOKEN - sold)
  let reserveTokenRaw = 0n
  if (graduated && pair !== zeroAddress) {
    const [[r0, r1], t0] = await Promise.all([ctx.read(pair, PAIR_ABI, 'getReserves'), ctx.read(pair, PAIR_ABI, 'token0')])
    const [rT, rQ] = t0.toLowerCase() === token.toLowerCase() ? [r0, r1] : [r1, r0]
    price = rT > 0n ? (rQ * 10n ** 18n) / rT : 0n
    reserveTokenRaw = rT
  }
  return {
    token, creator, quote, quoteSymbol: await symbolOf(ctx, quote), taxHandler: handler, router, registry,
    graduated, pair: pair === zeroAddress ? null : pair,
    buyTaxPct: pct(buyTaxBps), sellTaxPct: pct(sellTaxBps), dividendPct: pct(dividendBps), recipient, recipientLabel: label,
    ...(recipientIsCreator && { recipientIsCreator: true, recipientNote: 'the recipient is the creator itself, not reviewed by the platform' }),
    raised: await units(ctx, quote, graduated ? gradAmt : realQuote), graduationAt: await units(ctx, quote, gradAmt),
    toGraduation: await units(ctx, quote, remaining),
    progressPct: graduated ? 100 : gradAmt > 0n ? Number((realQuote * 10_000n) / gradAmt) / 100 : 0,
    priceQuote: await units(ctx, quote, price), priceFrom: graduated ? 'pool' : 'curve', priceRaw: price,
    owedToRecipient: await units(ctx, quote, owed), owedRaw: owed, reserveTokenRaw, curveRaw: { realQuote, sold, virtualQuote },
  }
}

/**
 * What a curve buy of `quoteIn` that gets `tokensOut` spends, the fee included (CurveLogic _quoteInFor + _recomputeFee):
 * less than quoteIn when the wallet cap or the graduation cut trimmed it and the rest is refunded.
 */
async function spentFor(ctx, c, quoteIn, tokensOut) {
  const { realQuote, sold, virtualQuote } = c.curveRaw
  const net = ceilDiv(virtualQuote * VIRTUAL_TOKEN, VIRTUAL_TOKEN - sold - tokensOut) - (virtualQuote + realQuote)
  const feeBps = BigInt(Math.round((await feesOf(ctx)).curveFeePct * 100))
  const gross = ceilDiv(net * 10_000n, 10_000n - feeBps)
  return gross < quoteIn ? gross : quoteIn
}

/** `token` funding for `need` toward the pad (wrap BNB, then approve): a step object, or null when ready. */
const fundingStep = (ctx, me, token, need, sym, approveStep, rawOnly, summarize) =>
  fund(ctx, { me, token, need, spender: ctx.pad, sym, approveStep }, rawOnly, summarize)

/** The pad's fee constants: the curve fee (the only charge on a curve trade), the platform's part of every pool tax (bps of volume). */
async function feesOf(ctx) {
  ctx.fees ??= Promise.all([ctx.read(ctx.pad, PAD_ABI, 'PROTOCOL_FEE_BPS'), ctx.read(ctx.pad, PAD_ABI, 'PLATFORM_TAX_BPS')])
    .then(([curve, platform]) => ({ curveFeePct: pct(curve), platformTaxPct: pct(platform) }))
  return ctx.fees
}

const addrArg = (opt, fail, name, what) => {
  const v = opt(name)
  if (!isAddress(v ?? '')) fail(`--${name} must be ${what} (0x…)`, { got: v ?? null })
  return v
}
const parseSlippage = (fail, raw) => parseNum(fail, 'slippage', raw, 0, 50)
const minOf = (x, slippagePct) => (x * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n

const SUBS = ['list', 'info', 'status', 'create', 'buy', 'sell', 'claim', 'income', 'release', 'tx']
const USAGE = 'usage: gang v3 <list|info|status|create|buy|sell|claim|income|release|tx> [--testnet] — see gang help'

/**
 * Entry for `gang v3 <sub>`. io: { opt, flag, out, fail, summarize, resolveLogo, checkMeta, resolveMeta, notes } from
 * index.js (summarize = summarizePreview, so previews look like every other command's; notes = padNotes: --note / --follow).
 */
export async function runV3(sub, { opt, flag, out, fail, summarize, resolveLogo, checkMeta, resolveMeta, notes }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const net = testnet ? ' --testnet' : ''
  const rawOnly = flag('calldata')

  if (sub === 'list' || sub === 'income') {
    const recipient = sub === 'income' ? addrArg(opt, fail, 'recipient', 'the tax recipient address') : null
    const status = opt('status', 'all')
    if (sub === 'list' && !['curve', 'graduated', 'all'].includes(status)) fail('--status must be curve, graduated or all')
    const path = recipient ? `/v3/recipients/${recipient.toLowerCase()}?limit=20` : `/v3/tokens?status=${status}&limit=30`
    const r = await fetch(`${API}${path}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) })
      .then((x) => (x.ok ? x.json() : { error: x.status })).catch((e) => ({ error: e.message }))
    if (r.error) return out({ success: false, error: `gang.fun V3 data unavailable (${r.error})`, hint: `use gang info --token <addr>${net} for one token (reads the chain)` })
    // the quote's own decimals from gang.fun (18 when an older server does not send them)
    const f = (x, d) => (x == null ? null : formatUnits(BigInt(x), d ?? 18))
    if (recipient) {
      return out({
        success: true, recipient, label: r.label, whitelist: r.whitelist ?? (r.listed ? 'listed' : null), chainId: r.chainId,
        totals: (r.totals || []).map((x) => ({ quote: x.symbol || x.quote, paid: f(x.paid, x.decimals) })),
        tokens: (r.tokens || []).map((x) => ({ token: x.token, symbol: x.symbol, quote: x.quoteSymbol, paid: f(x.paid, x.quoteDecimals), payments: x.payments, lastPaidAt: x.lastPaidAt })),
        recentPayments: (r.payments?.items || []).map((x) => ({ token: x.token, amount: f(x.amount, x.decimals), ts: x.ts, tx: x.tx })),
      })
    }
    return out({ success: true, status, items: (r.items || []).map((x) => ({
      token: x.address, symbol: x.symbol, buyTaxPct: pct(x.buyTaxBps), sellTaxPct: pct(x.sellTaxBps), dividendPct: pct(x.dividendBps),
      recipient: x.recipient, recipientLabel: x.recipientLabel, quote: x.quoteSymbol, progressPct: x.progressPct, graduated: x.graduated,
      chainId: x.chainId, link: `https://gang.fun/token/${x.address}`,
    })) })
  }

  let ctx
  try { ctx = v3Ctx(testnet) } catch (e) { return fail(e.message) }
  // not a curve on this pad: on the merged pad it may be a 打新 token (kindOf), so point at `gang fair`
  const notV3 = async (token) => {
    const { error, kind } = await notThisKind(ctx, token, 'v3', net)
    return fail(error, { token, chainId: ctx.chainId, ...(kind && { kind }) })
  }

  if (sub === 'info') {
    const token = addrArg(opt, fail, 'token', 'a V3 token address')
    const c = await curveOf(ctx, token)
    if (!c) return notV3(token)
    const { owedRaw: _raw, priceRaw: _p, reserveTokenRaw: rT, curveRaw: _cv, ...pub } = c
    // in the pool the tax is held as tokens and sold in small chunks under a per-block budget
    const swapBack = c.graduated && c.pair ? await swapBackState(ctx, c.taxHandler, token, rT) : null
    const fees = await feesOf(ctx)
    const taxNote = c.buyTaxPct > 0 || c.sellTaxPct > 0
      ? `buy ${c.buyTaxPct}% / sell ${c.sellTaxPct}% tax only in the PancakeSwap pool after graduation (${fees.platformTaxPct}% of volume to the platform, then ${c.dividendPct}% of the rest to holders, the remainder to the recipient); curve trades pay only the ${fees.curveFeePct}% fee, no tax`
      : `untaxed; curve trades pay the ${fees.curveFeePct}% fee`
    // a recipient that is the dev's buy-back splitter: its ratio and what waits to be bought back
    const buyback = c.recipient && !c.recipientIsCreator ? await splitterOf(ctx.read, c.recipient) : null
    // or the dev's split module (split-v1): its fixed payees and shares, what waits to be split
    const split = c.recipient && !c.recipientIsCreator && !buyback
      ? await splitOf(ctx.read, c.recipient, { wbnb: ctx.wbnb, extraAssets: [c.quote], ref: `--token ${token}${net}` }) : null
    // or the dev's LP splitter (lp-burn-v1): its ratio, what is set aside for the pool, the next chunk
    const lp = c.recipient && !c.recipientIsCreator && !buyback && !split ? await lpOf(ctx.read, c.recipient, { pad: ctx.pad }) : null
    // or the dev's combined recipient (combo-v1): fixed buy-back / LP ratios and payees, the set-aside parts, the next chunk
    const comboRef = `--token ${token}${net}`
    const combo = c.recipient && !c.recipientIsCreator && !buyback && !split && !lp
      ? await comboOf(ctx.read, c.recipient, { wbnb: ctx.wbnb, pad: ctx.pad, extraAssets: [c.quote], ref: comboRef }) : null
    const comboWarning = combo ? decoyWarning(combo, token, c.quote, comboRef) : null
    const lpWarn = lp && lp.token && lp.token.toLowerCase() !== token.toLowerCase()
      ? { warning: `this token pays its tax to the LP splitter, but it is bound to another token (${lp.token}): the liquidity goes to that token's pair` } : null
    const splitWarn = split && split.token && split.token.toLowerCase() !== token.toLowerCase()
      ? { warning: `this token pays its tax to the split module, but the module is bound to another token (${split.token}): the keeper never splits this token's tax (${c.quote}); it is split only by hand (gang split distribute --token ${token}${net} --asset ${c.quote})` } : null
    return out({
      success: true, chainId: Number(ctx.chainId), ...fees, ...pub, taxNote, ...(swapBack && { swapBack }), ...(buyback && { buyback }),
      ...(split && { split: { ...split, ...splitWarn } }), ...(lp && { lp: { ...lp, ...lpWarn } }),
      ...(combo && { combo: { ...combo, ...(comboWarning && { warning: comboWarning }) } }),
    })
  }

  if (sub === 'status') {
    const token = addrArg(opt, fail, 'token', 'a V3 token address')
    const c = await curveOf(ctx, token)
    if (!c) return notV3(token)
    const slippage = parseSlippage(fail, opt('slippage', '1'))
    const me = walletFor(ctx, opt('from'))
    const [vault, bal] = await Promise.all([ctx.read(ctx.pad, PAD_ABI, 'dividendVault'), ctx.read(token, ERC20_ABI, 'balanceOf', [me])])
    const { claimableRaw: _r, ...dividend } = c.dividendPct > 0 ? await dividendOf(ctx, vault, token, me, c.quote, c.priceRaw) : {}
    // graduated: what selling the whole balance into the pool pays now (sell tax and the chunk sold first included)
    const q = c.graduated && c.pair && bal > 0n ? await poolSellQuote(ctx, c.taxHandler, token, bal) : null
    return out({
      success: true, chainId: Number(ctx.chainId), wallet: me, token, quote: c.quoteSymbol, graduated: c.graduated,
      balance: formatUnits(bal, 18), dividendPct: c.dividendPct,
      ...(q && {
        poolSellAll: {
          expectOut: await units(ctx, c.quote, q.out), minOut: await units(ctx, c.quote, minOf(q.out, slippage)), slippagePct: slippage,
          quotedWith: q.quotedWith, hint: POOL_SELL_HINT,
        },
      }),
      ...(c.dividendPct > 0 ? { dividend } : { note: 'this token pays no dividend (dividend 0%)' }),
    })
  }

  if (sub === 'claim') {
    const token = addrArg(opt, fail, 'token', 'a V3 token address')
    const c = await curveOf(ctx, token)
    if (!c) return notV3(token)
    if (!(c.dividendPct > 0)) return fail('this token pays no dividend (dividend 0%)', { token })
    const me = walletFor(ctx, opt('from'))
    const vault = await ctx.read(ctx.pad, PAD_ABI, 'dividendVault')
    const d = await dividendOf(ctx, vault, token, me, c.quote, c.priceRaw)
    if (d.claimableRaw === 0n) {
      return fail('nothing to claim yet', {
        ...(d.creditedUnsoldTokens && Number(d.creditedUnsoldTokens) > 0 && { creditedUnsoldEstimate: d.creditedUnsoldEstimate, note: d.note }),
        hint: `gang status --token ${token}${testnet ? ' --testnet' : ''}`,
      })
    }
    const sim = await simulate(ctx, me, vault, VAULT_ABI, 'claim', [token])
    if (sim.failed) return out({ success: false, step: 'claim', ...sim.failed })
    return out(step(ctx, { from: me, to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'claim', args: [token] }) }, {
      step: 'claim', chainId: Number(ctx.chainId), token, amount: d.claimable, quote: c.quoteSymbol,
      ...(d.creditedUnsoldEstimate && Number(d.creditedUnsoldTokens) > 0 && { stillCreditedUnsold: d.creditedUnsoldEstimate }),
    }, rawOnly, summarize))
  }

  if (sub === 'create') {
    const name = opt('name'), symbol = opt('symbol')
    if (!name || !symbol) fail('--name and --symbol are required')
    checkMeta() // a bad --website / --twitter / --description fails here, before any chain read or upload
    // no --buy-tax / --sell-tax (or both 0): an untaxed token (tax all 0, no dividend, no recipient; the pad never hooks it)
    if (flag('buy-tax') !== flag('sell-tax')) {
      fail('give both --buy-tax and --sell-tax (each 1–5, in %; e.g. --buy-tax 2 --sell-tax 2), or neither for an untaxed token')
    }
    const isZero = (f) => /^0+(\.0+)?$/.test(opt(f) ?? '')
    const zeroTax = isZero('buy-tax') && isZero('sell-tax')
    const taxed = flag('buy-tax') && !zeroTax
    if (!taxed) {
      const f = ['dividend', 'recipient'].find((x) => flag(x))
      if (f) fail(`--${f} only applies to a taxed token: add --buy-tax and --sell-tax (each 1–5, in %), or leave --${f} out for an untaxed token`)
    }
    const taxOf = (f) => {
      const n = Number(opt(f))
      if (!(n >= 1 && n <= 5)) fail(`--${f} must be a number between 1 and 5 (in %); for an untaxed token leave out both tax flags (or give both as 0)`, { got: opt(f) ?? null })
      return n
    }
    const buyTax = taxed ? taxOf('buy-tax') : 0
    const sellTax = taxed ? taxOf('sell-tax') : 0
    const dividend = taxed ? parseNum(fail, 'dividend', opt('dividend', '0'), 0, 100) : 0
    const me = walletFor(ctx, opt('from'))
    // everything to holders needs no recipient; otherwise the recipient gets the rest: --recipient (a whitelisted
    // partner, or yourself), else the creator itself
    const recipient = !taxed || (dividend === 100 && !flag('recipient')) ? zeroAddress
      : flag('recipient') ? addrArg(opt, fail, 'recipient', 'the tax recipient: your own address, or a whitelisted partner') : me
    const quote = flag('quote') ? opt('quote') : ctx.wbnb
    const refPool = flag('ref-pool') ? opt('ref-pool') : (defaultRefPool(ctx.chainId, quote) ?? zeroAddress)
    if (!isAddress(quote ?? '') || !isAddress(refPool ?? '')) fail('--quote / --ref-pool must be 0x addresses')
    const tax = { buyTaxBps: Math.round(buyTax * 100), sellTaxBps: Math.round(sellTax * 100), dividendBps: Math.round(dividend * 100), recipient }
    // the recipient may be the creator itself: checkTaxConfigFor knows who creates (a pad without it: checkTaxConfig)
    const [ok, reason] = await ctx.read(ctx.pad, PAD_ABI, 'checkTaxConfigFor', [me, tax]).catch((e) => {
      if (!noSuchFunction(e)) throw e
      return ctx.read(ctx.pad, PAD_ABI, 'checkTaxConfig', [tax])
    })
    if (!ok) fail(`tax setting refused: ${reason}`, { hint: HINTS.BadTaxConfig, tax: { buyTax, sellTax, dividend, recipient } })
    if (!(await ctx.read(ctx.pad, PAD_ABI, 'isAgent', [me]))) fail('this wallet holds no Agent ID; V3 create is Agent-only', { wallet: me })
    // like LaunchpadV2: WBNB → 15 BNB; a fixed rate in QuoteRegistry; else --ref-pool prices the target
    let gradAmt
    try { gradAmt = await ctx.read(ctx.pad, PAD_ABI, 'graduationAmountOf', [quote, refPool]) } catch (e) {
      return fail('cannot price the graduation target in this quote', revertOf(e) || { detail: e.shortMessage || e.message })
    }
    const createData = (logoURI, metaURI) =>
      encodeFunctionData({ abi: PAD_ABI, functionName: 'create', args: [name, symbol, logoURI, metaURI, quote, refPool, tax] })
    // the logo / metadata strings never decide a revert: dry-run without them, so a create that would fail uploads nothing
    const dry = await simulate(ctx, me, ctx.pad, PAD_ABI, 'create', [name, symbol, '', '', quote, refPool, tax])
    if (dry.failed) return out({ success: false, step: 'create', ...dry.failed })
    const logo = await resolveLogo()
    const meta = await resolveMeta({ name, symbol, logoURI: logo.logoURI })
    let label = null
    const selfRecipient = recipient !== zeroAddress && recipient.toLowerCase() === String(me).toLowerCase()
    if (recipient !== zeroAddress && !selfRecipient) {
      label = await labelOf(ctx, (await taxContracts(ctx)).registry, recipient)
    }
    const rest = 100 - dividend
    const fees = await feesOf(ctx)
    return out(notes.step(ctx, { from: me, to: ctx.pad, data: createData(logo.logoURI, meta.metaURI) }, {
      step: 'create', chainId: Number(ctx.chainId), name, symbol, logoURI: logo.logoURI, ...(logo.uploaded && { uploaded: true }),
      metaURI: meta.metaURI, metadata: meta.metadata,
      quote: (await symbolOf(ctx, quote)) || quote, graduationAt: await units(ctx, quote, gradAmt),
      ...(refPool !== zeroAddress && quote.toLowerCase() !== String(ctx.wbnb).toLowerCase() && { refPool }),
      buyTaxPct: buyTax, sellTaxPct: sellTax, dividendPct: dividend,
      recipient: recipient === zeroAddress ? null : recipient, recipientLabel: selfRecipient ? 'you (the creator)' : label, tokenIfNext: dry.result,
      split: taxed
        ? `of each ${buyTax}% buy / ${sellTax}% sell tax in the PancakeSwap pool (after graduation; the curve charges no tax): ${fees.platformTaxPct}% of volume to the platform, then ${dividend}% of the rest to holders, ${rest}% to the recipient in the quote`
          + (dividend > 0 ? '; if no holder has 10,000+ tokens when a tax is paid, the holders\' part goes to the recipient too' : '')
        : 'untaxed: no tax in the PancakeSwap pool after graduation, no dividend, no recipient',
      note: `${taxed ? 'tax rates and recipient are' : 'untaxed is'} fixed at create. Curve trades pay only the ${fees.curveFeePct}% fee, no tax${taxed ? ': the tax starts in the pool after graduation' : ''}. tokenIfNext changes if another create lands first: the real address is the Created event from \`gang tx --hash …\`.`,
    }, 'create'))
  }

  if (sub === 'buy') {
    const token = addrArg(opt, fail, 'token', 'a V3 token address')
    const c = await curveOf(ctx, token)
    if (!c) return notV3(token)
    if (c.graduated) {
      // graduated: buy in the PancakeSwap pool through GangRouter (the buy tax applies; no Agent gate, no wallet cap)
      if (!c.pair) return fail('the pad marks this token graduated but has no PancakeSwap pair on record: nothing to trade it on', { token })
      if (notes.following) fail('--follow only counts on curve buys before graduation; this token trades on PancakeSwap now', { pair: c.pair })
      if (!flag('amount') && !flag('bnb')) fail('--amount <quote (or BNB) to spend> required')
      const raw = parseAmount(fail, flag('amount') ? 'amount' : 'bnb', opt('amount') ?? opt('bnb'))
      return out(await poolTrade(ctx, {
        side: 'buy', token, quote: c.quote, me: walletFor(ctx, opt('from')), amount: raw,
        slippage: parseSlippage(fail, opt('slippage', '1')), buyTaxBps: Math.round(c.buyTaxPct * 100),
        sellTaxBps: Math.round(c.sellTaxPct * 100), handler: c.taxHandler, payBnb: poolPayBnb(ctx, c.quote, flag),
        base: { kind: 'v3', pair: c.pair, ...notes.pool },
      }, { rawOnly, summarize, revertOf }))
    }
    const me = walletFor(ctx, opt('from'))
    if (!(await ctx.read(ctx.pad, PAD_ABI, 'isAgent', [me]))) fail('this wallet holds no Agent ID; curve trades are Agent-only', { wallet: me })
    if ((await ctx.read(ctx.pad, PAD_ABI, 'walletRoom', [token, me])) === 0n) fail(HINTS.WalletCapReached)
    if (!flag('amount') && !flag('bnb')) fail('--amount <quote to spend> required (the 1% curve fee included; no tax on the curve)')
    const raw = parseAmount(fail, flag('amount') ? 'amount' : 'bnb', opt('amount') ?? opt('bnb'))
    const quoteIn = parseUnits(raw, await decimalsOf(ctx, c.quote))
    const slippage = parseSlippage(fail, opt('slippage', '1'))
    // asked from gang.fun before any wrap / approve round, so a follow that can't count fails first
    const follow = await notes.follow(token, me)
    const priced = async (tokensOut) => follow && notes.priced(follow, token, await spentFor(ctx, c, quoteIn, tokensOut), await decimalsOf(ctx, c.quote))
    const extra = (tokensOut, minOut) => ({
      step: 'buy', chainId: Number(ctx.chainId), token, spend: raw, quote: c.quoteSymbol, expectTokens: formatUnits(tokensOut, 18),
      minTokensOut: formatUnits(minOut, 18), curveTaxPct: 0, ...(c.buyTaxPct > 0 && { poolBuyTaxPct: c.buyTaxPct }),
    })
    // WBNB-quoted: pay native BNB through the router in one tx (it wraps; tokens land in this wallet; a cap / graduation
    // refund comes back from the pad to this wallet as WBNB, not BNB)
    if (viaRouter(ctx, c.quote, flag)) {
      const native = await ctx.client.getBalance({ address: me })
      if (native < quoteIn + GAS_RESERVE) {
        fail('not enough BNB for this buy (native BNB must also cover gas)', {
          haveBnb: formatUnits(native, 18), needBnb: raw, reserveForGas: formatUnits(GAS_RESERVE, 18), hint: 'add --use-wbnb to pay from WBNB instead',
        })
      }
      const sim = await simulate(ctx, me, ctx.router, GANG_ROUTER_ABI, 'v3BuyBNB', [token, 0n, routerDeadline()], quoteIn)
      if (sim.failed) return out({ success: false, step: 'buy', via: 'router', ...sim.failed })
      const minOut = minOf(sim.result, slippage)
      const data = encodeFunctionData({ abi: GANG_ROUTER_ABI, functionName: 'v3BuyBNB', args: [token, minOut, routerDeadline()] })
      return out(notes.step(ctx, { from: me, to: ctx.router, data, value: quoteIn }, {
        ...extra(sim.result, minOut), via: 'router', curveFeePct: (await feesOf(ctx)).curveFeePct,
        note: 'paid in BNB through GangRouter; spend includes the 1% curve fee (no tax on the curve; the buy tax applies only in the pool after graduation); at the 1% wallet cap or the graduation cut the excess comes back to this wallet as WBNB (not BNB)',
      }, 'buy', await priced(sim.result)))
    }
    const pre = await fundingStep(ctx, me, c.quote, quoteIn, c.quoteSymbol, 'approve-quote', rawOnly, summarize)
    if (pre) return out(pre.success ? { ...pre, ...notes.skipped(follow) } : pre)
    const sim = await simulate(ctx, me, ctx.pad, PAD_ABI, 'buy', [token, quoteIn, 0n])
    if (sim.failed) return out({ success: false, step: 'buy', ...sim.failed })
    const minOut = minOf(sim.result, slippage)
    return out(notes.step(ctx, { from: me, to: ctx.pad, data: encodeFunctionData({ abi: PAD_ABI, functionName: 'buy', args: [token, quoteIn, minOut] }) }, {
      ...extra(sim.result, minOut), curveFeePct: (await feesOf(ctx)).curveFeePct,
      note: 'spend includes the 1% curve fee (no tax on the curve; the buy tax applies only in the pool after graduation); at the 1% wallet cap the excess is refunded',
    }, 'buy', await priced(sim.result)))
  }

  if (sub === 'sell') {
    const token = addrArg(opt, fail, 'token', 'a V3 token address')
    const c = await curveOf(ctx, token)
    if (!c) return notV3(token)
    if (flag('all') === !!opt('amount')) fail('pass exactly one of --amount <tokens> or --all')
    const slippage = parseSlippage(fail, opt('slippage', '1'))
    if (c.graduated) {
      // graduated: sell into the PancakeSwap pool through GangRouter, minOut from the handler's previewSellNextBlock
      // (sell tax and the chunk of held tax sold first included). No wallet: the quote alone, as before.
      if (!c.pair) return fail('the pad marks this token graduated but has no PancakeSwap pair on record: nothing to sell it into', { token })
      let me = null
      try { me = walletFor(ctx, opt('from')) } catch { /* no wallet configured */ }
      if (me) {
        return out(await poolTrade(ctx, {
          side: 'sell', token, quote: c.quote, me, amount: flag('all') ? null : parseAmount(fail, 'amount', opt('amount')), all: flag('all'),
          slippage, buyTaxBps: Math.round(c.buyTaxPct * 100), sellTaxBps: Math.round(c.sellTaxPct * 100), handler: c.taxHandler,
          swapBackGas: c.sellTaxPct > 0, toBnb: flag('to-bnb'), base: { kind: 'v3', pair: c.pair, ...notes.pool },
          bond: { testnet, breakBond: flag('break-bond'), settleFirst: flag('settle-first') },
        }, { rawOnly, summarize, revertOf }))
      }
      if (flag('all')) return fail('--all needs a wallet (or --from <addr>) whose balance can be read', { pair: c.pair })
      const amount = parseUnits(parseAmount(fail, 'amount', opt('amount')), 18)
      const q = await poolSellQuote(ctx, c.taxHandler, token, amount)
      return fail('no wallet to build the pool sell for: pass --from <addr> (quote only)', {
        pair: c.pair, ...(q && {
          poolQuote: {
            amount: formatUnits(amount, 18), expectOut: await units(ctx, c.quote, q.out), minOut: await units(ctx, c.quote, minOf(q.out, slippage)),
            slippagePct: slippage, quote: c.quoteSymbol, sellTaxPct: c.sellTaxPct, quotedWith: q.quotedWith,
          },
          hint: POOL_SELL_HINT,
        }),
        ...(!q && { note: 'no pool quote: the tax handler did not answer (RPC); re-run for one' }),
      })
    }
    const me = walletFor(ctx, opt('from'))
    const bal = await ctx.read(token, ERC20_ABI, 'balanceOf', [me])
    if (bal === 0n) fail('no balance to sell')
    const amount = flag('all') ? bal : parseUnits(parseAmount(fail, 'amount', opt('amount')), 18)
    if (amount > bal) fail('amount exceeds balance', { balance: formatUnits(bal, 18) })
    // a bond posted on the curve already binds: a creator's curve sell below X breaks it
    const guard = await bondGuard(ctx, { token, me, amount, testnet, breakBond: flag('break-bond'), settleFirst: flag('settle-first') }, rawOnly, summarize)
    if (guard?.refuse) return out({ success: false, step: 'sell', wallet: me, ...guard.refuse })
    const pre = await fundingStep(ctx, me, token, amount, c.quoteSymbol, 'approve', rawOnly, summarize)
    if (pre) return out(pre.success ? { ...pre, ...notes.skipped() } : pre)
    const sim = await simulate(ctx, me, ctx.pad, PAD_ABI, 'sell', [token, amount, 0n])
    if (sim.failed) return out({ success: false, step: 'sell', ...sim.failed })
    const minOut = minOf(sim.result, slippage)
    return out(notes.step(ctx, { from: me, to: ctx.pad, data: encodeFunctionData({ abi: PAD_ABI, functionName: 'sell', args: [token, amount, minOut] }) }, {
      step: 'sell', chainId: Number(ctx.chainId), token, amount: formatUnits(amount, 18), quote: c.quoteSymbol,
      expectOut: await units(ctx, c.quote, sim.result), minOut: await units(ctx, c.quote, minOut), curveTaxPct: 0,
      ...(c.sellTaxPct > 0 && { poolSellTaxPct: c.sellTaxPct }),
      curveFeePct: (await feesOf(ctx)).curveFeePct, ...guard?.info,
      note: 'expectOut is after the 1% curve fee only (no tax on the curve; the sell tax applies only in the pool after graduation)',
    }, 'sell'))
  }

  if (sub === 'release') {
    const token = addrArg(opt, fail, 'token', 'a V3 token address')
    const c = await curveOf(ctx, token)
    if (!c) return notV3(token)
    if (c.owedRaw === 0n) return fail('nothing owed: every tax payment reached the recipient', { recipient: c.recipient })
    const me = walletFor(ctx, opt('from'))
    const sim = await simulate(ctx, me, c.router, TAX_ROUTER_ABI, 'release', [token])
    if (sim.failed) return out({ success: false, step: 'release', ...sim.failed, hint: 'the recipient may still refuse transfers of this quote; try again later' })
    return out(step(ctx, { from: me, to: c.router, data: encodeFunctionData({ abi: TAX_ROUTER_ABI, functionName: 'release', args: [token] }) }, {
      step: 'release', chainId: Number(ctx.chainId), token, recipient: c.recipient, recipientLabel: c.recipientLabel,
      amount: c.owedToRecipient, quote: c.quoteSymbol, note: 'anyone may release; the quote goes to the recipient, not to the caller',
    }, rawOnly, summarize))
  }

  if (sub === 'tx') {
    const hash = opt('hash')
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) fail('--hash must be a tx hash')
    const r = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    const events = []
    for (const log of r.logs) {
      for (const abi of [PAD_ABI, TAX_ROUTER_ABI, VAULT_ABI]) {
        try {
          const ev = decodeEventLog({ abi, data: log.data, topics: log.topics })
          events.push({ event: ev.eventName, ...Object.fromEntries(Object.entries(ev.args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) })
          break
        } catch { /* other contract / event */ }
      }
    }
    return out({ success: true, chainId: Number(ctx.chainId), hash, status: r.status, block: Number(r.blockNumber), events, explorer: `${ctx.explorer}/tx/${hash}` })
  }

  return fail(USAGE, { got: sub })
}
