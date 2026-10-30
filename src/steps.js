import { parseAbi, encodeFunctionData, decodeErrorResult, formatUnits, parseEther } from 'viem'
import { bawError, bawPreview } from './baw.js'

/**
 * Shared by `gang fair` and `gang v3` (each on its own chain via `ctx`: { chainId, client, read, wbnb }): revert decoding,
 * the write step (raw tx or baw preview), quote funding (wrap / approve), flag parsing and token units.
 */
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function decimals() view returns (uint8)',
])
const WBNB_ABI = parseAbi(['function deposit() payable'])

/**
 * GangRouter (gang-launchpad src/router; a proxy, so its address stays): stateless entry in front of the pad. With
 * native BNB it wraps and calls the pad for the caller — no wrap / approve round for WBNB-quoted tokens and sales. A V3
 * buy's cap / graduation refund goes from the pad straight to the caller as WBNB (not BNB); fairMintBNB returns
 * unspent BNB as BNB. The pool* functions trade a graduated / launched token on PancakeSwap (see pool.js):
 * the token / proceeds go to the caller; poolBuy / poolSell pull the quote / token, so approve the router first.
 */
export const ROUTER_ABI = parseAbi([
  'function v3Buy(address token, uint256 quoteIn, uint256 minTokensOut, uint256 deadline) returns (uint256)',
  'function v3BuyBNB(address token, uint256 minTokensOut, uint256 deadline) payable returns (uint256)',
  'function fairMint(address token, uint256 shares, uint256 minShares, uint256 deadline) returns (uint256)',
  'function fairMintBNB(address token, uint256 shares, uint256 minShares, uint256 deadline) payable returns (uint256)',
  'function poolBuyBNB(address token, address quote, uint256 minTokensOut, uint256 deadline) payable returns (uint256 tokensOut)',
  'function poolBuy(address token, address quote, uint256 quoteIn, uint256 minTokensOut, uint256 deadline) returns (uint256)',
  'function poolSell(address token, address quote, uint256 amountIn, uint256 minQuoteOut, uint256 deadline) returns (uint256)',
  'function poolSellForBNB(address token, address quote, uint256 amountIn, uint256 minBnbOut, uint256 deadline) returns (uint256)',
  'function pad() view returns (address)', 'function wbnb() view returns (address)', 'function pancakeRouter() view returns (address)',
  // errors as in gang-launchpad src/router/GangRouter.sol (feat/upgradeable-router)
  'error Expired()', 'error NotDeployed()', 'error UnknownToken()', 'error NotWbnbQuote()', 'error NotEnoughValue()',
  'error OnlyWbnb()', 'error BnbTransferFailed()', 'error ZeroAmount()',
  'error TooLittleReceived(uint256 received, uint256 minimum)',
])
/** What to tell the agent for each router error. */
export const ROUTER_HINTS = {
  Expired: 'the tx landed after its deadline (30 min after the preview): re-run the command for a fresh one',
  TooLittleReceived: 'the pool pays less than the minimum (args: [received, minimum], raw units): the price moved, or the tax chunk sold first took more. Re-run to re-quote, or raise --slippage',
  ZeroAmount: 'the amount is 0 (or nothing arrived from the wallet)',
  NotEnoughValue: 'the BNB sent does not cover the amount',
  UnknownToken: 'the router does not know this token on its pad (the other kind of token, or not a gang token)',
}
/** Router deadline: half an hour, for a preview that is executed a few minutes later. */
export const routerDeadline = () => BigInt(Math.floor(Date.now() / 1000) + 1800)
/** Native BNB kept back for gas on a router call, as `gang buy` keeps for wrap + approve + buy. */
export const GAS_RESERVE = parseEther('0.002')
/** The router path applies: a router on this chain, a WBNB quote, and no --use-wbnb. */
export const viaRouter = (ctx, quote, flag) => !!ctx.router && quote.toLowerCase() === ctx.wbnb.toLowerCase() && !flag('use-wbnb')

/** Token decimals, read once per ctx (18 when the token does not say). */
export async function decimalsOf(ctx, token) {
  ctx.decimals ??= new Map()
  const k = token.toLowerCase()
  if (!ctx.decimals.has(k)) {
    let d = 18
    try { d = Number(await ctx.read(token, ERC20_ABI, 'decimals')) } catch { /* 18 */ }
    ctx.decimals.set(k, d)
  }
  return ctx.decimals.get(k)
}
export const units = async (ctx, token, amount) => formatUnits(amount, await decimalsOf(ctx, token))

/** Revert name (+ the first arg, e.g. a reason string) of a failed call against any of `abis`, or null when it was the RPC. */
export function revertOf(e, abis, hints = {}) {
  const raw = e?.walk?.((x) => typeof x?.data === 'string' && x.data.startsWith('0x'))?.data
  if (raw && raw.length >= 10) {
    for (const abi of abis) {
      try {
        const d = decodeErrorResult({ abi, data: raw })
        return {
          error: d.errorName, ...(d.args?.length && { reason: d.args[0] }),
          ...(d.args?.length > 1 && { args: d.args.map((a) => (typeof a === 'bigint' ? a.toString() : a)) }), hint: hints[d.errorName],
        }
      } catch { /* not this contract */ }
    }
  }
  const named = e?.walk?.((x) => x?.data?.errorName)?.data?.errorName
  if (named) return { error: named, hint: hints[named] }
  if (e?.walk?.((x) => x?.code === 3 || /revert/i.test(x?.details || x?.shortMessage || ''))) return { error: 'execution reverted' }
  return null
}

/**
 * A write step: either the raw tx (--calldata: no baw call; e.g. to sign elsewhere) or a baw preview.
 * Returns the object the command prints.
 */
export function step(ctx, { from, to, data, value = 0n }, extra, rawOnly, summarize) {
  if (rawOnly) {
    return { success: true, ...extra, tx: { chainId: Number(ctx.chainId), from, to, data, value: value.toString() } }
  }
  const p = bawPreview({ from, to, value, data, chainId: ctx.chainId })
  // only an error about the chain itself: a generic network failure is not a reason to fall back to --calldata
  if (!p.success && new RegExp(`binanceChainId|unsupported chain|chain not supported|chain(?:\\s*id)?\\W{0,3}${ctx.chainId}\\b`, 'i')
    .test(JSON.stringify(p.error || ''))) {
    return {
      success: false, ...extra, ...bawError(p.error),
      hint: `the Agentic Wallet may not sign on chain ${ctx.chainId}: re-run with --calldata to get the raw tx`,
    }
  }
  return summarize(p, extra)
}

/**
 * `token` funding for `need` toward `spender`: wrap BNB first (WBNB), then approve. A step object, or null when ready.
 * approveStep names the approve step in the output (`approve-quote` for a quote, `approve` for selling a token).
 */
export async function fundingStep(ctx, { me, token, need, spender, sym, approveStep = 'approve-quote' }, rawOnly, summarize) {
  const bal = await ctx.read(token, ERC20_ABI, 'balanceOf', [me])
  if (bal < need) {
    if (token.toLowerCase() !== ctx.wbnb.toLowerCase()) {
      return { success: false, error: `not enough ${sym || 'quote'}`, have: await units(ctx, token, bal), need: await units(ctx, token, need) }
    }
    const missing = need - bal
    const native = await ctx.client.getBalance({ address: me })
    if (native < missing) {
      return { success: false, error: 'not enough BNB', haveBnb: formatUnits(native, 18), needBnb: formatUnits(missing, 18) }
    }
    return step(ctx, { from: me, to: token, data: encodeFunctionData({ abi: WBNB_ABI, functionName: 'deposit' }), value: missing },
      { step: 'wrap-bnb', wrap: formatUnits(missing, 18), note: 'after executing, re-run the same command' }, rawOnly, summarize)
  }
  if ((await ctx.read(token, ERC20_ABI, 'allowance', [me, spender])) < need) {
    return step(ctx, { from: me, to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, need] }) },
      { step: approveStep, approve: await units(ctx, token, need), ...(approveStep !== 'approve-quote' && { token }), spender, note: 'after executing, re-run the same command' },
      rawOnly, summarize)
  }
  return null
}

export const parseNum = (fail, name, raw, min, max) => {
  const n = Number(raw)
  if (raw == null || !Number.isFinite(n) || n < min || n > max) fail(`--${name} must be a number between ${min} and ${max}`, { got: raw })
  return n
}
export const parseIntIn = (fail, name, raw, min, max) => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer between ${min} and ${max}`, { got: raw })
  return n
}
/** A positive decimal amount flag (e.g. --amount 0.5), as written: callers scale it with the token's decimals. */
export const parseAmount = (fail, name, raw) => {
  if (raw == null || !/^(\d+(\.\d*)?|\.\d+)$/.test(String(raw).trim()) || !(Number(raw) > 0)) {
    fail(`--${name} must be a positive number (e.g. 0.5)`, { got: raw ?? null })
  }
  return String(raw).trim()
}

/**
 * Reference pool `create` uses when --ref-pool is left out: mainnet USDT → Pancake V3 USDT/WBNB 0.01% (the deepest;
 * its 30-min TWAP prices the graduation target / raise). Other quotes need an explicit --ref-pool.
 */
const DEFAULT_REF_POOLS = {
  56: { '0x55d398326f99059ff775485246999027b3197955': '0x172fcD41E0913e95784454622d1c3724f546f849' },
}
export const defaultRefPool = (chainId, quote) => DEFAULT_REF_POOLS[Number(chainId)]?.[String(quote || '').toLowerCase()] || null

/** The shared dividend vault (V3 and 打新). */
export const VAULT_ABI = parseAbi([
  'function pending(address token, address user) view returns (uint256)',
  'function pendingUnits(address token, address user) view returns (uint256)',
  'function shares(address token, address user) view returns (uint256)',
  'function claim(address token) returns (uint256)',
  'error NothingToClaim()', 'error UnknownToken()',
  'event DividendClaimed(address indexed token, address indexed user, uint256 amount)',
])

/**
 * The pool-tax handler of a graduated V3 / launched 打新 token (GangTaxHandler since the merge, one for both kinds; before
 * it TaxHandlerV3 / HolderRewardHandler; all PostGradHandlerBase).
 * The tax is held in the token and sold in chunks: each token has one budget per block, at most 0.5% of the pair's token
 * side as it stood at the block's first chunk, shared by the chunk a taxed sell triggers (≤ 25% of that sell) and the
 * keeper; no chunk sells more than 2% below that block-start price.
 */
export const POOL_HANDLER_ABI = parseAbi([
  'function previewSellNextBlock(address token, uint256 amountIn) view returns (uint256 quoteOut, uint256 chunk)',
  'function previewSell(address token, uint256 amountIn) view returns (uint256 quoteOut, uint256 chunk)',
  'function accruedTax(address token) view returns (uint256)',
  'function maxChunk(address token) view returns (uint256)',
  'function windowOf(address token) view returns (uint64 blockNumber, uint96 used)',
  'function refOf(address token) view returns (uint112 refT, uint112 refQ)',
  'function CHUNK_MAX_BPS() view returns (uint256)',
  'function MAX_PRICE_DROP_BPS() view returns (uint256)',
])

/**
 * The call reverted with no data, or returned nothing ("0x"): the function is not on that contract (an older
 * deployment). An RPC failure (timeout, HTTP error) or a revert with a reason is not that.
 */
export function isMissingFunction(e) {
  if (e?.walk?.((x) => x?.name === 'ContractFunctionZeroDataError' || x?.name === 'AbiDecodingZeroDataError')) return true
  const raw = e?.walk?.((x) => typeof x?.data === 'string')?.data
  if (raw && raw !== '0x') return false
  return !!e?.walk?.((x) => x?.code === 3 || x?.name === 'ExecutionRevertedError')
}

/**
 * What selling `amountIn` of `token` into its pool pays (after the sell tax, the chunk it triggers sold first), for the
 * seller's amountOutMin: `previewSellNextBlock` — the tx lands in a later block, with a fresh chunk budget. Only a
 * handler from before it (no such function) falls back to `previewSell` (this block). null on any other failure (RPC,
 * a revert with a reason) or when neither answers: no quote rather than a wrong one.
 */
export async function poolSellQuote(ctx, handler, token, amountIn) {
  const ask = async (fn) => {
    const [out, chunk] = await ctx.read(handler, POOL_HANDLER_ABI, fn, [token, amountIn])
    return { out, chunk, quotedWith: fn }
  }
  try {
    return await ask('previewSellNextBlock')
  } catch (e) {
    if (!isMissingFunction(e)) return null
  }
  try { return await ask('previewSell') } catch { return null }
}

/**
 * The swap-back state of a graduated token, all read at the latest block:
 * - unsoldTaxTokens: tax held and not sold yet;
 * - budgetPerBlockTokens: the per-block budget a new block opens (CHUNK_MAX_BPS of the pool's token side now);
 * - budgetLeftInLatestBlockTokens: what the latest block's budget still allows — the whole budget when no chunk ran
 *   in it (windowOf is an earlier block), else the budget fixed at that block's first chunk minus what was sold since;
 * - nextChunkTokens (maxChunk): the largest chunk that could be sold in the latest block — the least of the unsold
 *   tax, what the handler holds of it, and the budget left. A sell's own chunk is further capped at 25% of that sell.
 * Handlers from before the per-block budget (one chunk per block) have no windowOf: `budget: 'one chunk per block (older handler)'`.
 */
export async function swapBackState(ctx, handler, token, reserveToken) {
  let blockNumber
  try { blockNumber = await ctx.client.getBlockNumber() } catch { return null }
  const at = (fn, args = []) => ctx.client.readContract({ address: handler, abi: POOL_HANDLER_ABI, functionName: fn, args, blockNumber })
  const [unsold, next, win, ref, chunkBps, dropBps] = await Promise.all([
    at('accruedTax', [token]).catch(() => null),
    at('maxChunk', [token]).catch(() => null),
    at('windowOf', [token]).catch(() => null),
    at('refOf', [token]).catch(() => null),
    at('CHUNK_MAX_BPS').catch(() => 50n),
    at('MAX_PRICE_DROP_BPS').catch(() => null),
  ])
  if (unsold == null) return null
  const base = { unsoldTaxTokens: formatUnits(unsold, 18) }
  if (!win) return { ...base, budget: 'one chunk per block (older handler)' }
  const [winBlock, used] = win
  const budget = (reserveToken * chunkBps) / 10_000n
  let left = budget
  if (winBlock === blockNumber) {
    // a chunk ran in the latest block: its budget was fixed by the reserves at that block's first chunk attempt
    const cap = ref && ref[0] > 0n ? (ref[0] * chunkBps) / 10_000n : budget
    left = used >= cap ? 0n : cap - used
  }
  const drop = dropBps != null ? Number(dropBps) / 100 : 2
  return {
    ...base,
    budgetPerBlockTokens: formatUnits(budget, 18),
    budgetLeftInLatestBlockTokens: formatUnits(left, 18),
    nextChunkTokens: next == null ? null : formatUnits(next, 18),
    latestBlock: Number(blockNumber),
    lastChunkBlock: Number(winBlock) || null,
    ...(dropBps != null && { pausesBelowBlockStartPct: drop }),
    note: `each block, the chunks sold from the held tax (those triggered by sells and the keeper's together) add up to at most ${Number(chunkBps) / 100}% of the pool's token side; `
      + `no chunk is sold while the price is more than ${drop}% below where the block started. Each new block opens a fresh budget. `
      + 'nextChunkTokens is the largest chunk the latest block still allows (unsold tax and budget left, whichever is less); a sell triggers at most 25% of its own amount.',
  }
}

/** Hint for selling a graduated / launched token on PancakeSwap with the minOut of a pool quote (poolSellQuote) as amountOutMin. */
export const POOL_SELL_HINT = '`gang sell` builds this sell through GangRouter (poolSell / --to-bnb poolSellForBNB, minOut as here); '
  + 'or sell on PancakeSwap with swapExactTokensForTokensSupportingFeeOnTransferTokens (the token takes its sell tax in the transfer), passing minOut (poolQuote.minOut / poolSellAll.minOut, set by --slippage) as amountOutMin so the sell reverts rather than fills below it; '
  + 'the quote includes the small chunk of tax the handler sells right before a sell and assumes the tx lands in a new block (previewSellNextBlock). '
  + 'Let the wallet estimate gas, or give at least 750k: a sell that triggers a chunk uses about 660k (about 330k without), and too little gas reverts with SwapBackOutOfGas'

/**
 * `me`'s dividend / holder reward on a V3 or 打新 token from the shared vault: `pending` = settled quote, claimable now; `pendingUnits` = tax
 * already credited to `me` when it was paid (in tax tokens) whose batch is not sold yet — it becomes claimable quote
 * once sold, and is valued here at `priceRaw` (quote wei per token) as an estimate only. Vaults from before the
 * tax-time crediting have no pendingUnits: those report null.
 */
export async function dividendOf(ctx, vault, token, me, quote, priceRaw) {
  const [pending, share, unitsRaw] = await Promise.all([
    ctx.read(vault, VAULT_ABI, 'pending', [token, me]),
    ctx.read(vault, VAULT_ABI, 'shares', [token, me]),
    ctx.read(vault, VAULT_ABI, 'pendingUnits', [token, me]).catch(() => null),
  ])
  return {
    claimable: await units(ctx, quote, pending), claimableRaw: pending,
    dividendShare: formatUnits(share, 18),
    creditedUnsoldTokens: unitsRaw == null ? null : formatUnits(unitsRaw, 18),
    creditedUnsoldEstimate: unitsRaw == null || !priceRaw ? null : await units(ctx, quote, (unitsRaw * priceRaw) / 10n ** 18n),
    ...(unitsRaw > 0n && { note: 'creditedUnsold: tax credited to you when it was paid, claimable once that batch is sold (estimate at the current price)' }),
  }
}
