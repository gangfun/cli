import { createPublicClient, parseAbi, encodeFunctionData, decodeEventLog, formatUnits, parseEther, parseUnits, isAddress, zeroAddress } from 'viem'
import { bawAddress } from './baw.js'
import { defaultRefPool, dividendOf, fundingStep as fund, parseAmount, parseIntIn, parseNum, poolSellQuote, POOL_SELL_HINT, revertOf as revertIn, ROUTER_ABI, ROUTER_HINTS, routerDeadline, step, swapBackState, units, viaRouter, GAS_RESERVE } from './steps.js'
import { API } from './discover.js'
import { UA } from './version.js'
import { atTokenPad, KIND_UNREAD, MERGED_ERRORS_ABI, MERGED_HINTS, NOT_ON_MAINNET, notThisKind, padNets, rpcTransport } from './gangpad.js'
import { poolPayBnb, poolTrade } from './pool.js'
import { bondGuard } from './bond.js'

/**
 * `gang fair …` — 打新 (fair mint): one fixed price per share both ways (mint buys at it, withdraw sells back at it);
 * the last share launches the token on PancakeSwap at that price. No deadline, no refund: a sale stays open until it
 * fills. Contracts: gang-launchpad GangLaunchpad (merged pad: 打新 sales and V3 curves on one address; see gangpad.js).
 * Mainnet needs a pad address (GANG_PAD or the one shipped in gangpad.js); without it mainnet answers "no mainnet address".
 */
export const FAIR_NETS = padNets('fair')

const PAD_ABI = parseAbi([
  'function create(string name, string symbol, string logoURI, string metaURI, address quote, address refPool, (uint256 raiseBnb, uint16 capBps, uint16 holdBps, uint16 mintFeeBps, uint16 exitFeeBps) cfg, uint256 devShares) returns (address)',
  'function mint(address token, uint256 shares, uint256 minShares) returns (uint256)',
  'function withdraw(address token, uint256 shares, uint256 minPayout) returns (uint256)',
  'function sales(address token) view returns (address creator, uint64 progressAt, uint16 capShares, uint16 holdBps, address quote, uint16 sold, bool launched, uint16 mintFeeBps, uint16 exitFeeBps, address gate, uint128 sharePrice, address pair, address refPool, uint16 markSold)',
  'function positions(address token, address user) view returns (uint16 shares)',
  'function previewWithdraw(address token, address user, uint256 shares) view returns (uint256 payout, uint256 fee)',
  'function exitFeeBpsOf(address token) view returns (uint256)',
  'function STALE_AFTER() view returns (uint256)',
  'function status(address token) view returns (uint8)',
  'function previewMint(address token, address user, uint256 shares) view returns (uint256 accepted, uint256 cost, uint256 fee)',
  'function previewCreate(address quote, address refPool, uint256 raiseBnb) view returns (uint256 raiseQuote, uint256 sharePrice)',
  'function checkConfig((uint256 raiseBnb, uint16 capBps, uint16 holdBps, uint16 mintFeeBps, uint16 exitFeeBps) cfg, uint256 devShares) pure returns (bool ok, string reason)',
  'function taxHandler() view returns (address)',
  'function dividendVault() view returns (address)',
  'function agentIdRegistry() view returns (address)',
  'function agentGateEnabled() view returns (bool)',
  'function TOKENS_PER_SHARE() view returns (uint256)',
  'function TOTAL_SHARES() view returns (uint256)',
  'error BadConfig(string reason)', 'error UnknownToken()', 'error NotMinting()', 'error ZeroAmount()',
  'error BadAmount()', 'error Slippage()', 'error WalletCapReached()', 'error NotAgent()', 'error OutOfGas()',
  'error MigratorNotSet()', 'error ZeroAddress()', 'error RefPoolRequired()', 'error NoBridgePool()', 'error BridgeNotWbnb()',
  'error PriceTooSmall()', 'error FeeOnTransferQuote()', 'error VaultFloorTooHigh()', 'error QuoteNotAllowed()',
  'error RouterNeedsGate()', 'error NotContract()', 'error UnknownPoolType()', 'error V3FactoryNotSet()',
  'error PoolNotFactory()', 'error QuoteNotInPool()', 'error PoolNoLiquidity()', 'error ThinReferencePool()', 'error GradAmtZero()',
  'event Created(address indexed token, address indexed creator, string name, string symbol, string logoURI, address indexed quote, address refPool, uint256 raiseBnb, uint256 sharePrice, uint256 capShares, uint256 holdBps, uint256 mintFeeBps, uint256 exitFeeBps)',
  'event Minted(address indexed token, address indexed user, uint256 shares, uint256 cost, uint256 fee, uint256 userShares, uint256 sold)',
  'event Withdrawn(address indexed token, address indexed user, uint256 shares, uint256 payout, uint256 fee, uint256 userShares, uint256 sold)',
  'event Launched(address indexed token, address indexed pair, address quote, uint256 tokenAmount, uint256 quoteAmount)',
])
const HANDLER_ABI = parseAbi([
  'function isOut(address token, address user) view returns (bool)',
  'function eligibleShare(address token, address user) view returns (uint256)',
])
const VAULT_ABI = parseAbi([
  'function pending(address token, address user) view returns (uint256)',
  'function totalShares(address token) view returns (uint256)',
  'function claim(address token) returns (uint256)',
  'event DividendClaimed(address indexed token, address indexed user, uint256 amount)',
])
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
])
// GangToken's pool tax rates (immutable; 0 / 0 on an untaxed token)
const TAX_ABI = parseAbi(['function buyTaxBps() view returns (uint16)', 'function sellTaxBps() view returns (uint16)'])
const ERC721_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])
const PAIR_ABI = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)'])

/** A launched sale's pool reserves as [token side, quote side] ([0, 0] before launch). */
async function poolReserves(ctx, token, pair) {
  if (!pair) return [0n, 0n]
  const [[r0, r1], t0] = await Promise.all([ctx.read(pair, PAIR_ABI, 'getReserves'), ctx.read(pair, PAIR_ABI, 'token0')])
  return t0.toLowerCase() === token.toLowerCase() ? [r0, r1] : [r1, r0]
}

/** Pool price of a launched sale's token, in quote wei per token (0 before launch / an empty pool). */
async function poolPriceRaw(ctx, token, pair) {
  const [rT, rQ] = await poolReserves(ctx, token, pair)
  return rT > 0n ? (rQ * 10n ** 18n) / rT : 0n
}

const STATUS = ['none', 'minting', 'launched']
// what to tell the agent for each pad error
const HINTS = {
  BadConfig: 'a rule is out of bounds: see reason',
  NotAgent: 'this wallet holds no Agent ID; fair mint is Agent-only',
  NotMinting: 'the sale already launched: trade the token in the pool with gang buy / gang sell',
  WalletCapReached: 'this wallet already holds the per-wallet cap of shares',
  Slippage: 'fewer shares are left than --min-shares (someone filled first)',
  BadAmount: '--shares is more than this wallet holds in the sale',
  FeeOnTransferQuote: 'the quote token takes a fee on transfer; it cannot be used',
  RefPoolRequired: 'this quote needs --ref-pool (a Pancake pool pricing it)',
  PriceTooSmall: 'the raise in this quote is too small to split into 10,000 shares',
  QuoteNotAllowed: '--quote must be WBNB or an 18-decimal ERC-20 token (leave it out to use WBNB)',
  PoolNotFactory: '--ref-pool is not a PancakeSwap V2 pair / V3 pool',
  NotContract: '--ref-pool is not a contract',
  UnknownPoolType: '--ref-pool is not a PancakeSwap V2 pair / V3 pool',
  PoolNoLiquidity: '--ref-pool has no liquidity',
  V3FactoryNotSet: 'V3 pools are not enabled on this pad yet; use a Pancake V2 pair as --ref-pool',
  NoBridgePool: '--ref-pool pairs the quote with a token that has no bridge to WBNB here; pick a pool against WBNB (or USDT on mainnet)',
  BridgeNotWbnb: 'the bridge pool for this --ref-pool is misconfigured; pick a pool against WBNB',
  GradAmtZero: 'the quote token is priced so high that the raise rounds to 0',
  QuoteNotInPool: '--ref-pool does not contain the --quote token',
  ThinReferencePool: '--ref-pool is too shallow; pick the deepest pool for this quote',
  RouterNeedsGate: 'this sale has no Agent gate, so the router path is off; re-run with --use-wbnb to mint directly',
  // not a create flag: the shared dividend vault's holding floor for this pad was raised above what 打新 allows
  VaultFloorTooHigh: 'the platform\'s dividend vault requires a larger holding than fair-mint rewards allow, so no sale can be created right now; ask gang to fix the vault setting',
}

/** What `gang tx` decodes a 打新 trade's logs with (the pad, the holder-reward vault). */
export const FAIR_EVENT_ABIS = [PAD_ABI, VAULT_ABI]

export function fairCtx(testnet) {
  const net = FAIR_NETS[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const symbolOf = async (ctx, token) => { try { return await ctx.read(token, ERC20_ABI, 'symbol') } catch { return null } }

/** Wallet address on the fair chain; the Agentic Wallet's EVM address is the same on every chain, so 56 is the fallback. */
export function walletFor(ctx, from) {
  if (from) return from
  try { return bawAddress(ctx.chainId) } catch { return bawAddress('56') }
}

/** Revert name (+ BadConfig reason) of a failed eth_call, or null when it was the RPC. */
const revertOf = (e) => revertIn(e, [PAD_ABI, ROUTER_ABI, MERGED_ERRORS_ABI], { ...MERGED_HINTS, ...ROUTER_HINTS, ...HINTS })

/** Dry-run `data` from `from`; null when it would pass. */
async function dryRun(ctx, from, to, data, value = 0n) {
  try {
    await ctx.client.call({ account: from, to, data, value })
    return null
  } catch (e) {
    const r = revertOf(e)
    return r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] }
  }
}

/** A sale as the pad stores it, plus derived fields. null when the token is not a fair-mint sale on this pad. */
export async function saleOf(ctx, token) {
  const s = await ctx.read(ctx.pad, PAD_ABI, 'sales', [token])
  if (s[0] === zeroAddress) return null
  const [creator, progressAt, capShares, holdBps, quote, sold, launched, mintFeeBps, exitFeeBps, gate, sharePrice, pair] = s
  const [st, exitNowBps, staleAfter] = await Promise.all([
    ctx.read(ctx.pad, PAD_ABI, 'status', [token]), ctx.read(ctx.pad, PAD_ABI, 'exitFeeBpsOf', [token]),
    ctx.read(ctx.pad, PAD_ABI, 'STALE_AFTER'),
  ])
  const status = STATUS[Number(st)]
  const left = 10_000 - Number(sold)
  return {
    token, status, creator, quote, quoteSymbol: await symbolOf(ctx, quote), gate,
    capShares: Number(capShares), holdPct: Number(holdBps) / 100, sold: Number(sold), totalShares: 10_000,
    // no deadline: what a fill still needs, and how long until withdraws stop paying the exit fee
    sharesLeft: left, minWalletsLeft: Math.ceil(left / Number(capShares)),
    // the stale clock: restarts only on progress (sold up 10 shares since the last restart), not on every mint
    progressAt: Number(progressAt), progressIso: new Date(Number(progressAt) * 1000).toISOString(),
    stale: !launched && Number(exitNowBps) === 0,
    exitFeeFreeIn: launched ? 0 : Math.max(0, Number(progressAt) + Number(staleAfter) - Math.floor(Date.now() / 1000)),
    mintFeePct: Number(mintFeeBps) / 100, exitFeePct: Number(exitFeeBps) / 100, exitFeeNowPct: Number(exitNowBps) / 100,
    exitFeeBps: Number(exitFeeBps),
    sharePriceRaw: sharePrice, sharePrice: await units(ctx, quote, sharePrice), launched,
    pair: pair === zeroAddress ? null : pair,
  }
}

/** Quote funding for `need` toward the pad (wrap BNB, then approve): a step object, or null when ready. */
const fundingStep = (ctx, me, quote, need, sym, rawOnly, summarize) =>
  fund(ctx, { me, token: quote, need, spender: ctx.pad, sym }, rawOnly, summarize)

const tokenArg = (opt, fail) => {
  const t = opt('token')
  if (!isAddress(t ?? '')) fail('--token must be the sale\'s token address (0x…)', { got: t ?? null })
  return t
}

/** `x` less `slippagePct`% (the pool quote's minOut, as `gang v3 sell`). */
const minOf = (x, slippagePct) => (x * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n

/**
 * Live position of `me` in a sale (reward fields once launched). After launch any wallet holding the token — a minter
 * or one that only bought in the pool — gets poolSellAll: what selling its whole balance pays, and the minOut for it at
 * `slippage`%.
 */
async function positionOf(ctx, token, me, sale, slippage) {
  const shares = await ctx.read(ctx.pad, PAD_ABI, 'positions', [token, me])
  const tps = await ctx.read(ctx.pad, PAD_ABI, 'TOKENS_PER_SHARE')
  const baseline = BigInt(shares) * tps
  const pos = { shares: Number(shares), baselineTokens: formatUnits(baseline, 18) }
  if (!sale.launched) {
    if (shares) {
      const [payout] = await ctx.read(ctx.pad, PAD_ABI, 'previewWithdraw', [token, me, BigInt(shares)])
      pos.sellBackAll = await units(ctx, sale.quote, payout) // what `gang fair withdraw --all` pays now
    }
    return pos
  }
  const [handler, vault, bal] = await Promise.all([
    ctx.read(ctx.pad, PAD_ABI, 'taxHandler'), ctx.read(ctx.pad, PAD_ABI, 'dividendVault'), ctx.read(token, ERC20_ABI, 'balanceOf', [me]),
  ])
  // what selling the whole balance into the pool pays (the 1% tax and the chunk sold first included, as of the next block)
  const q = sale.pair && bal > 0n ? await poolSellQuote(ctx, handler, token, bal) : null
  const sellAll = q && {
    poolSellAll: {
      expectOut: await units(ctx, sale.quote, q.out), minOut: await units(ctx, sale.quote, minOf(q.out, slippage)), slippagePct: slippage,
      quotedWith: q.quotedWith, hint: POOL_SELL_HINT,
    },
  }
  if (!shares) {
    return { ...pos, balance: formatUnits(bal, 18), ...sellAll, reward: 'none', note: 'did not mint in this sale: the holder reward is only for minters' }
  }
  const [out, weight, reward, total] = await Promise.all([
    ctx.read(handler, HANDLER_ABI, 'isOut', [token, me]),
    ctx.read(handler, HANDLER_ABI, 'eligibleShare', [token, me]),
    poolPriceRaw(ctx, token, sale.pair).then((p) => dividendOf(ctx, vault, token, me, sale.quote, p)),
    ctx.read(vault, VAULT_ABI, 'totalShares', [token]),
  ])
  const line = (baseline * BigInt(Math.round(sale.holdPct * 100))) / 10_000n
  return {
    ...pos,
    balance: formatUnits(bal, 18),
    ...sellAll,
    reward: out ? 'out' : 'earning',
    holdLineTokens: formatUnits(line, 18),
    sellableBeforeOut: !out && bal > line ? formatUnits(bal - line, 18) : '0',
    poolSharePct: total > 0n ? Number((weight * 1_000_000n) / total) / 10_000 : 0,
    pendingReward: reward.claimable,
    // tax credited to me when it was paid, claimable once its batch is sold (null on vaults without tax-time crediting)
    creditedUnsoldTokens: reward.creditedUnsoldTokens, creditedUnsoldEstimate: reward.creditedUnsoldEstimate,
    ...(out ? { note: 'out for good: fell below the hold line once; buying back does not restore it' } : reward.note && { note: reward.note }),
  }
}

/**
 * Entry for `gang fair <sub>`. io: { opt, flag, out, fail, summarize, resolveLogo, checkMeta, resolveMeta, notes } from
 * index.js (summarize = summarizePreview, so previews look like every other command's; notes = padNotes: --note).
 */
const SUBS = ['list', 'info', 'status', 'create', 'mint', 'withdraw', 'buy', 'sell', 'claim', 'tx']
/** withdraw reverts below the preview minus this (bps): it catches an exit fee coming back (≥ 1%). */
const WITHDRAW_TOLERANCE_BPS = 10n
const USAGE = 'usage: gang fair <list|info|status|create|mint|withdraw|buy|sell|claim|tx> [--testnet] — see gang help'

export async function runFair(sub, { opt, flag, out, fail, summarize, resolveLogo, checkMeta, resolveMeta, notes }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const rawOnly = flag('calldata')
  if (sub === 'list') {
    const status = opt('status', 'minting')
    if (!['minting', 'launched', 'all'].includes(status)) fail('--status must be minting, launched or all')
    const r = await fetch(`${API}/fair/sales?status=${status}&limit=30`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) })
      .then((x) => (x.ok ? x.json() : { error: x.status })).catch((e) => ({ error: e.message }))
    if (r.error) return out({ success: false, error: `gang.fun fair list unavailable (${r.error})`, hint: `use gang info --token <addr>${testnet ? ' --testnet' : ''} for one sale` })
    return out({ success: true, status, items: (r.items || []).map((x) => ({
      token: x.address, symbol: x.symbol, status: x.status, sold: x.sold, participants: x.participants,
      sharePrice: x.sharePrice && formatUnits(BigInt(x.sharePrice), 18), quote: x.quoteSymbol, chainId: x.chainId,
      sharesLeft: x.sharesLeft ?? null, minWalletsLeft: x.minWalletsLeft ?? null, lastMintAt: x.lastMintAt ?? null, progressAt: x.progressAt ?? null, stale: x.stale ?? null,
      link: `https://gang.fun/token/${x.address}`,
    })) })
  }

  let ctx
  try { ctx = fairCtx(testnet) } catch (e) { return fail(e.message) }
  // a token is served by the GangLaunchpad generation that has it (its pad, router, GangBond); a create goes to the newest
  if (sub !== 'create' && sub !== 'tx' && (await atTokenPad(ctx, opt('token'))) === null) return fail(KIND_UNREAD.error, { token: opt('token'), retry: KIND_UNREAD.retry })
  // not a sale on this pad: on the merged pad it may be a V3 token (kindOf), so point at `gang v3`
  const notFair = async (token) => {
    const { error, kind } = await notThisKind(ctx, token, 'fair', testnet ? ' --testnet' : '')
    return fail(error, { token, chainId: ctx.chainId, ...(kind && { kind }) })
  }

  if (sub === 'info' || sub === 'status') {
    const token = tokenArg(opt, fail)
    const sale = await saleOf(ctx, token)
    if (!sale) return notFair(token)
    const { sharePriceRaw: _raw, exitFeeBps: _exit, ...pub } = sale
    if (sub === 'info') {
      // after launch the 1% tax is held as tokens and sold in small chunks under a per-block budget
      const swapBack = sale.launched && sale.pair
        ? await swapBackState(ctx, await ctx.read(ctx.pad, PAD_ABI, 'taxHandler'), token, (await poolReserves(ctx, token, sale.pair))[0])
        : null
      return out({ success: true, chainId: Number(ctx.chainId), ...pub, ...(ctx.gen && { padGen: ctx.gen }), ...(swapBack && { swapBack }) })
    }
    const slippage = parseNum(fail, 'slippage', opt('slippage', '1'), 0, 50)
    const me = walletFor(ctx, opt('from'))
    return out({ success: true, chainId: Number(ctx.chainId), wallet: me, sale: pub, position: await positionOf(ctx, token, me, sale, slippage) })
  }

  if (sub === 'create') {
    const name = opt('name'), symbol = opt('symbol')
    if (!name || !symbol) fail('--name and --symbol are required')
    checkMeta() // a bad --website / --twitter / --description fails here, before any wrap / approve round or upload
    const raise = parseNum(fail, 'raise', opt('raise', '15'), 5, 50)
    if (flag('hours')) fail('--hours was removed: a fair-mint sale has no deadline and stays open until it fills')
    if (flag('grad')) fail('--grad is a V3 curve setting (the graduation target, 2.0): a 打新 sale fills at its --raise instead, so leave --grad out')
    const capPct = parseNum(fail, 'cap', opt('cap', '0.5'), 0.25, 1)
    const holdPct = parseNum(fail, 'hold', opt('hold', '60'), 60, 90)
    const mintFeePct = parseNum(fail, 'mint-fee', opt('mint-fee', '1'), 1, 3)
    const exitFeePct = parseNum(fail, 'exit-fee', opt('exit-fee', '1'), 1, 2)
    const devShares = parseIntIn(fail, 'shares', opt('shares', '1'), 1, Math.round(capPct * 200))
    const quote = flag('quote') ? opt('quote') : ctx.wbnb
    const refPool = flag('ref-pool') ? opt('ref-pool') : (defaultRefPool(ctx.chainId, quote) ?? zeroAddress)
    if (!isAddress(quote ?? '') || !isAddress(refPool ?? '')) fail('--quote / --ref-pool must be 0x addresses')
    const cfg = {
      raiseBnb: parseEther(String(raise)), capBps: Math.round(capPct * 100),
      holdBps: Math.round(holdPct * 100), mintFeeBps: Math.round(mintFeePct * 100), exitFeeBps: Math.round(exitFeePct * 100),
    }
    const [ok, reason] = await ctx.read(ctx.pad, PAD_ABI, 'checkConfig', [cfg, BigInt(devShares)])
    if (!ok) fail(`rule out of bounds: ${reason}`)
    let priced
    try { priced = await ctx.read(ctx.pad, PAD_ABI, 'previewCreate', [quote, refPool, cfg.raiseBnb]) } catch (e) {
      return fail('cannot price the raise in this quote', revertOf(e) || { detail: e.shortMessage || e.message })
    }
    const [raiseQuote, sharePrice] = priced
    const sym = await symbolOf(ctx, quote)
    const fee = (sharePrice * BigInt(devShares) * BigInt(cfg.mintFeeBps)) / 10_000n
    const need = sharePrice * BigInt(devShares) + fee
    const me = walletFor(ctx, opt('from'))
    const pre = await fundingStep(ctx, me, quote, need, sym, rawOnly, summarize)
    if (pre) return out(pre.success ? { ...pre, ...notes.skipped() } : pre)
    // logoURI is permanent on-chain: same handling as `gang create` (--logo file upload, other hosts copied to gang.fun).
    // Done after the setup steps so a wrap / approve round does not upload the image twice.
    const createData = (logoURI, metaURI) => encodeFunctionData({
      abi: PAD_ABI, functionName: 'create', args: [name, symbol, logoURI, metaURI, quote, refPool, cfg, BigInt(devShares)],
    })
    // the logo / metadata strings never decide a revert: dry-run without them, so a create that would fail uploads nothing
    const dry = await dryRun(ctx, me, ctx.pad, createData('', ''))
    if (dry) return out({ success: false, step: 'create', ...dry })
    const logo = await resolveLogo()
    const meta = await resolveMeta({ name, symbol, logoURI: logo.logoURI })
    const data = createData(logo.logoURI, meta.metaURI)
    return out(notes.step(ctx, { from: me, to: ctx.pad, data }, {
      step: 'create', chainId: Number(ctx.chainId), name, symbol, logoURI: logo.logoURI, ...(logo.uploaded && { uploaded: true }),
      metaURI: meta.metaURI, metadata: meta.metadata, quote: sym || quote,
      raise: await units(ctx, quote, raiseQuote), sharePrice: await units(ctx, quote, sharePrice),
      capShares: cfg.capBps * 2, minWallets: Math.ceil(10_000 / (cfg.capBps * 2)), holdPct, mintFeePct, exitFeePct, devShares,
      devCost: await units(ctx, quote, need),
      note: 'no deadline: the sale stays open until all 10,000 shares are minted, then launches. Minters can sell shares back at the mint price (minus the exit fee; none after 7 days without progress, i.e. fewer than 10 new shares). The mint fee is the platform\'s and is not returned.',
    }, 'create'))
  }

  if (sub === 'mint') {
    const token = tokenArg(opt, fail)
    const want = parseIntIn(fail, 'shares', opt('shares'), 1, 10_000)
    const sale = await saleOf(ctx, token)
    if (!sale) return notFair(token)
    if (sale.status !== 'minting') {
      return fail(`sale is ${sale.status}, not minting`, { hint: `it launched: buy in the pool with gang buy --token ${token} --amount <quote>${testnet ? ' --testnet' : ''}` })
    }
    const me = walletFor(ctx, opt('from'))
    if (sale.gate !== zeroAddress && (await ctx.read(sale.gate, ERC721_ABI, 'balanceOf', [me])) === 0n) {
      return fail('this wallet holds no Agent ID; fair mint is Agent-only', { wallet: me })
    }
    const [accepted, cost, fee] = await ctx.read(ctx.pad, PAD_ABI, 'previewMint', [token, me, BigInt(want)])
    if (accepted === 0n) return fail('no shares available to this wallet (cap reached or sold out)', { capShares: sale.capShares })
    const minShares = flag('min-shares') ? parseIntIn(fail, 'min-shares', opt('min-shares'), 1, Number(accepted)) : Number(accepted)
    const need = cost + fee
    const fills = sale.sold + Number(accepted) === 10_000
    const extra = {
      step: 'mint', chainId: Number(ctx.chainId), token, shares: Number(accepted), ...(Number(accepted) < want && { truncatedFrom: want }),
      cost: await units(ctx, sale.quote, cost), fee: await units(ctx, sale.quote, fee), feePct: sale.mintFeePct, quote: sale.quoteSymbol,
      soldAfter: sale.sold + Number(accepted), ...(fills && { launches: 'this mint fills the sale and launches the token (higher gas)' }),
      ...(!fills && { minWalletsLeftAfter: Math.ceil((10_000 - sale.sold - Number(accepted)) / sale.capShares) }),
      note: `the ${sale.mintFeePct}% mint fee goes to the platform and is not returned; selling back later pays the mint price minus the exit fee`,
    }
    // WBNB sale: pay native BNB through the router in one tx (it wraps; the position is still this wallet's)
    if (viaRouter(ctx, sale.quote, flag)) {
      const native = await ctx.client.getBalance({ address: me })
      if (native < need + GAS_RESERVE) {
        return fail('not enough BNB for this mint (native BNB must also cover gas)', {
          haveBnb: formatUnits(native, 18), needBnb: formatUnits(need, 18), reserveForGas: formatUnits(GAS_RESERVE, 18), hint: 'add --use-wbnb to pay from WBNB instead',
        })
      }
      const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'fairMintBNB', args: [token, accepted, BigInt(minShares), routerDeadline()] })
      const dry = await dryRun(ctx, me, ctx.router, data, need)
      if (dry) return out({ success: false, step: 'mint', via: 'router', ...dry })
      return out(notes.step(ctx, { from: me, to: ctx.router, data, value: need }, { ...extra, via: 'router', payBnb: formatUnits(need, 18) }, 'buy'))
    }
    const pre = await fundingStep(ctx, me, sale.quote, need, sale.quoteSymbol, rawOnly, summarize)
    if (pre) return out(pre.success ? { ...pre, ...notes.skipped() } : pre)
    const data = encodeFunctionData({ abi: PAD_ABI, functionName: 'mint', args: [token, accepted, BigInt(minShares)] })
    const dry = await dryRun(ctx, me, ctx.pad, data)
    if (dry) return out({ success: false, step: 'mint', ...dry })
    return out(notes.step(ctx, { from: me, to: ctx.pad, data }, extra, 'buy'))
  }

  if (sub === 'withdraw') {
    const token = tokenArg(opt, fail)
    const sale = await saleOf(ctx, token)
    if (!sale) return notFair(token)
    if (sale.status !== 'minting') {
      return fail(`sale is ${sale.status}: withdraw only while minting`, sale.launched ? {
        pair: sale.pair,
        hint: `it launched: sell in the pool with \`gang sell --token ${token} (--amount <tokens> | --all)${testnet ? ' --testnet' : ''}${opt('from') ? ` --from ${opt('from')}` : ''} [--slippage 1] [--to-bnb]\``
          + ' (through GangRouter; minOut from the tax handler\'s previewSellNextBlock)',
      } : {})
    }
    const me = walletFor(ctx, opt('from'))
    const held = await ctx.read(ctx.pad, PAD_ABI, 'positions', [token, me])
    if (!held) return fail('this wallet has no shares in this sale')
    const shares = flag('all') ? Number(held) : parseIntIn(fail, 'shares', opt('shares'), 1, Number(held))
    // a bond posted during the sale already binds: selling shares back takes their tokens out of the creator's wallet
    const guard = ctx.bond && await bondGuard(ctx, {
      token, me, amount: BigInt(shares) * (await ctx.read(ctx.pad, PAD_ABI, 'TOKENS_PER_SHARE')), testnet, breakBond: flag('break-bond'), settleFirst: flag('settle-first'),
    }, rawOnly, summarize)
    if (guard?.refuse) return out({ success: false, step: 'withdraw', wallet: me, ...guard.refuse })
    const [payout, fee] = await ctx.read(ctx.pad, PAD_ABI, 'previewWithdraw', [token, me, BigInt(shares)])
    // the price is fixed, so only the exit fee can move the payout: a mint landing first can restart the 7-day clock
    // and bring a 1–2% fee back. 0.1% below the preview refuses that and nothing else.
    const minPayout = (payout * (10_000n - WITHDRAW_TOLERANCE_BPS)) / 10_000n
    const data = encodeFunctionData({ abi: PAD_ABI, functionName: 'withdraw', args: [token, BigInt(shares), minPayout] })
    const dry = await dryRun(ctx, me, ctx.pad, data)
    if (dry) return out({ success: false, step: 'withdraw', ...dry })
    return out(notes.step(ctx, { from: me, to: ctx.pad, data }, {
      step: 'withdraw', chainId: Number(ctx.chainId), token, shares,
      receive: await units(ctx, sale.quote, payout), minReceive: await units(ctx, sale.quote, minPayout),
      exitFee: await units(ctx, sale.quote, fee), quote: sale.quoteSymbol,
      exitFeePct: sale.exitFeeNowPct, ...guard?.info,
      note: sale.stale
        ? `no progress for 7 days: no exit fee, the full mint price back; the ${sale.mintFeePct}% paid at mint is not returned`
        : `mint price − ${sale.exitFeeNowPct}% exit fee (none after 7 days without 10 new shares); the ${sale.mintFeePct}% paid at mint is not returned`,
    }, 'sell'))
  }

  if (sub === 'buy' || sub === 'sell') {
    // after launch: trade the token in its PancakeSwap pool through GangRouter (the 打新 pool tax applies both ways)
    const token = tokenArg(opt, fail)
    const sale = await saleOf(ctx, token)
    if (!sale) return notFair(token)
    if (!sale.launched || !sale.pair) {
      return fail(`sale is ${sale.status}: gang ${sub} trades the token in its pool after launch`, {
        hint: sub === 'buy' ? `while minting, buy shares with gang mint --token ${token} --shares <n>` : `while minting, sell shares back with gang withdraw --token ${token} (--shares <n> | --all)`,
      })
    }
    const slippage = parseNum(fail, 'slippage', opt('slippage', '1'), 0, 50)
    if (sub === 'sell' && flag('all') === !!opt('amount')) fail('pass exactly one of --amount <tokens> or --all')
    if (sub === 'buy' && !flag('amount')) fail('--amount <quote (or BNB) to spend> required')
    let buyTaxBps, sellTaxBps, handler
    try {
      ;[buyTaxBps, sellTaxBps, handler] = await Promise.all([
        ctx.read(token, TAX_ABI, 'buyTaxBps'), ctx.read(token, TAX_ABI, 'sellTaxBps'), ctx.read(ctx.pad, PAD_ABI, 'taxHandler'),
      ])
    } catch (e) {
      // never guess 0%: the minimum would ignore the tax
      return fail('cannot read the token\'s pool tax rates (buyTaxBps / sellTaxBps) or the tax handler: no minimum is built without them', { token, detail: e.shortMessage || e.message.split('\n')[0], hint: 're-run' })
    }
    const me = walletFor(ctx, opt('from'))
    // a minter still earning: selling past sellableBeforeOut drops it below the hold line and ends the reward for good
    let outWarning = null
    if (sub === 'sell') {
      const shares = await ctx.read(ctx.pad, PAD_ABI, 'positions', [token, me])
      if (shares && !(await ctx.read(handler, HANDLER_ABI, 'isOut', [token, me]))) {
        const [tps, bal] = await Promise.all([ctx.read(ctx.pad, PAD_ABI, 'TOKENS_PER_SHARE'), ctx.read(token, ERC20_ABI, 'balanceOf', [me])])
        const line = (BigInt(shares) * tps * BigInt(Math.round(sale.holdPct * 100))) / 10_000n
        const sellable = bal > line ? bal - line : 0n
        const amount = flag('all') ? bal : parseUnits(parseAmount(fail, 'amount', opt('amount')), 18)
        if (amount <= bal && amount > sellable) {
          outWarning = {
            warning: `WARNING: selling ${formatUnits(amount, 18)} tokens goes past sellableBeforeOut (${formatUnits(sellable, 18)}): this wallet drops below its hold line (${formatUnits(line, 18)} tokens) and loses the holder reward FOR GOOD — buying back does not restore it`,
            sellableBeforeOut: formatUnits(sellable, 18), holdLineTokens: formatUnits(line, 18), balance: formatUnits(bal, 18),
          }
          if (!flag('confirm-out')) {
            return fail(outWarning.warning, {
              ...outWarning, token, wallet: me,
              hint: `sell at most sellableBeforeOut to keep the reward, or re-run with --confirm-out once the user accepts losing it`,
            })
          }
        }
      }
    }
    return out(await poolTrade(ctx, {
      side: sub, token, quote: sale.quote, me, slippage, buyTaxBps: Number(buyTaxBps), sellTaxBps: Number(sellTaxBps), handler,
      amount: sub === 'sell' && flag('all') ? null : parseAmount(fail, 'amount', opt('amount')), all: sub === 'sell' && flag('all'),
      swapBackGas: Number(sellTaxBps) > 0, payBnb: sub === 'buy' && poolPayBnb(ctx, sale.quote, flag), toBnb: flag('to-bnb'),
      base: { kind: 'fair', pair: sale.pair, ...notes.pool, ...(outWarning && { ...outWarning, confirmedOut: true }) },
      ...(sub === 'sell' && { bond: { testnet, breakBond: flag('break-bond'), settleFirst: flag('settle-first') } }),
    }, { rawOnly, summarize, revertOf }))
  }

  if (sub === 'claim') {
    const token = tokenArg(opt, fail)
    const sale = await saleOf(ctx, token)
    if (!sale) return notFair(token)
    const me = walletFor(ctx, opt('from'))
    const vault = await ctx.read(ctx.pad, PAD_ABI, 'dividendVault')
    const r = await dividendOf(ctx, vault, token, me, sale.quote, await poolPriceRaw(ctx, token, sale.pair))
    const unsold = r.creditedUnsoldTokens && Number(r.creditedUnsoldTokens) > 0
    if (r.claimableRaw === 0n) {
      return fail('nothing to claim yet', {
        ...(unsold && { creditedUnsoldEstimate: r.creditedUnsoldEstimate, note: r.note }),
        hint: `gang status --token ${token}${testnet ? ' --testnet' : ''}`,
      })
    }
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'claim', args: [token] })
    return out(step(ctx, { from: me, to: vault, data }, {
      step: 'claim', chainId: Number(ctx.chainId), token, amount: r.claimable, quote: sale.quoteSymbol,
      ...(unsold && { stillCreditedUnsold: r.creditedUnsoldEstimate }),
    }, rawOnly, summarize))
  }

  if (sub === 'tx') {
    const hash = opt('hash')
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) fail('--hash must be a tx hash')
    const r = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    const events = []
    for (const log of r.logs) {
      for (const abi of [PAD_ABI, VAULT_ABI]) {
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
