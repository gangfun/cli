import { createPublicClient, encodeFunctionData, hexToString, isAddress, parseAbi, zeroAddress } from 'viem'
import { revertOf as revertIn, step, units } from './steps.js'
import { atTokenPad, CREATOR_FEE_ABI, creatorFeeShareOf, NOT_ON_MAINNET, padNets, rpcTransport } from './gangpad.js'
import { walletFor } from './fair.js'

/**
 * `gang creator-fee` — the GangLaunchpad 2.0 creator fee (docs/SPEC-CURVE-CREATOR-FEE-2026-10-31.md): of the 1% fee on
 * each V3 curve buy and sell, 70% is kept on the pad for the token's creator (`creatorFeeOf`), the rest goes to the
 * platform. The creator claims it with `claimCreatorFee(token, to)`, to any address, before or after graduation, with no
 * deadline. It is the creating wallet's own: it never goes to the tax recipient, a buy-back splitter, a split module or
 * an LP splitter. 打新 sales and 1.0 pads have none (on 1.0 the whole curve fee is the platform's).
 */

const CURVES_ABI = parseAbi([
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function tokenCount() view returns (uint256)',
  'function allTokens(uint256) view returns (address)',
  'function kindOf(address token) view returns (uint8)',
  'error ZeroAmount()', 'error ZeroAddress()', 'error UnknownToken()',
])
const SYMBOL_ABI = parseAbi(['function symbol() view returns (string)'])
const MODULE_TYPE_ABI = parseAbi(['function moduleType() view returns (bytes32)'])
const QUOTE_ABI = parseAbi(['function quote() view returns (address)'])
const ABIS = [CREATOR_FEE_ABI, CURVES_ABI]
const HINTS = {
  NotCreator: 'only the token\'s creator (the wallet that created it) can claim its creator fee; pass that wallet with --from',
  ZeroAmount: 'nothing to claim yet: the creator fee grows with each curve buy and sell',
  ZeroAddress: '--to cannot be the zero address or the pad itself',
  UnknownToken: 'not a V3 curve token of this pad (打新 sales have no creator fee)',
}
const revertOf = (e) => revertIn(e, ABIS, HINTS)

// a scan reads at most this many of a pad's newest tokens, in multicall batches of BATCH
const MAX_SCAN = 5000
const BATCH = 400

export const claimCmd = (token, net = '') => `gang creator-fee --token ${token}${net} --claim`
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const pctOf = (bps) => bps / 100

/** A ctx on the create target of `testnet` / mainnet, with every generation in ctx.gens. */
export function creatorFeeCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

/** What a V3 create on ctx.pad says about the creator fee, or null when that pad has none (1.0). */
export async function createNote(ctx, net = '') {
  let share
  try { share = await creatorFeeShareOf(ctx) } catch {
    return `could not read whether this pad keeps a creator fee (RPC error); gang creator-fee${net} shows it once the token is out`
  }
  if (share == null) return null
  return `${pctOf(share)}% of the 1% curve fee on every curve buy and sell (until graduation) is kept on the pad for you, the creator. Claim it any time, before or after graduation: gang creator-fee${net} lists it, gang creator-fee --token <token>${net} --claim [--to <addr>] claims it.`
}

/**
 * What pays out a fee claimed into a module, by its moduleType(): the buy-back and LP splitters pay their payee only
 * when they split (the keeper's chunks do it after graduation), the split module and the combined recipient on
 * distribute. null: not one of these.
 */
export function payOutCmd(moduleType, at, net = '', { asset, assetSymbol } = {}) {
  const t = String(moduleType ?? '')
  const base = t.startsWith('buyback-burn-') ? 'gang buyback' : t === 'lp-burn-v1' ? 'gang lp'
    : t === 'split-v1' ? 'gang split' : t === 'combo-v1' ? 'gang combo' : null
  if (!base) return null
  const splitter = base === 'gang buyback' || base === 'gang lp'
  const m = `--module ${at ?? '<module>'}`
  // a fee in another quote than the module's own: split / distribute of the bound quote never moves it
  if (asset) {
    return splitter
      ? `${base} sweep ${m} --asset ${asset}${net} (anyone) sends all of it to the payee (${assetSymbol ?? 'this asset'} is not split: no ${base === 'gang lp' ? 'pool' : 'buy-back'} share)`
      : `${base} distribute ${m} --asset ${asset}${net} (anyone) pays the payees their shares of it`
  }
  return `${base} ${splitter ? 'split' : 'distribute'} ${m}${net} (anyone) then pays ${splitter ? 'the payee its part and sets the rest aside' : 'the payees their shares'}`
    + (splitter ? '; after graduation each keeper chunk splits first, so it also goes out with the next chunk' : '')
}

/**
 * The claim's --to note when --to is a module (pure: unit-tested): `bound` is its quote() (zero: not bound yet),
 * `quote` the token's. { payOut, warning }: a fee in another quote is not moved by split / distribute.
 */
export function claimToModule({ moduleType, at, net = '', bound, quote, quoteSymbol, boundSymbol }) {
  const other = !!bound && !!quote && bound.toLowerCase() !== quote.toLowerCase()
  const unbound = !bound || /^0x0{40}$/.test(bound)
  const payOut = payOutCmd(moduleType, at, net, other && !unbound ? { asset: quote, assetSymbol: quoteSymbol } : {})
  if (!payOut) return { payOut: null, warning: null }
  if (unbound) return { payOut, warning: 'the module is not bound to a token yet: it pays this out only once it is bound (its launch binds it)' }
  if (!other) return { payOut, warning: null }
  return {
    payOut,
    warning: `the module's own quote is ${boundSymbol ?? bound}, this fee is in ${quoteSymbol ?? quote}: split / distribute of the module's quote leave it where it is`,
  }
}
const LAUNCH_TYPES = { buyback: 'buyback-burn-v4', lp: 'lp-burn-v1', split: 'split-v1', combo: 'combo-v1' }

/** Added to the create's note when the tax recipient is one of the dev's modules (`module`: its name; `kind`: buyback | lp | split | combo). */
export const notThroughModule = (module, { token, at, net = '', kind } = {}) =>
  `This creator fee is yours, the creating wallet's: it does not go through the ${module}, which gets only the recipient's part of the pool tax after graduation.`
  + (at ? ` To put it into the ${module} anyway, claim it there: gang creator-fee --token ${token ?? '<token>'}${net} --claim --to ${at}` : '')
  + (at && kind && LAUNCH_TYPES[kind] ? `; ${payOutCmd(LAUNCH_TYPES[kind], at, net)}` : '')

/**
 * The creator fee of a V3 curve `token` on ctx.pad (ctx already on the token's generation) for info / status:
 * { padGen, creatorFee } — creatorFee null on a 1.0 pad.
 */
export async function curveCreatorFee(ctx, token, { creator, quote }, net = '') {
  let share, owed
  try {
    share = await creatorFeeShareOf(ctx)
    if (share != null) owed = await ctx.read(ctx.pad, CREATOR_FEE_ABI, 'creatorFeeOf', [token])
  } catch (e) {
    // an RPC error leaves the field out of this answer rather than failing the whole info / status
    return { padGen: ctx.gen, creatorFee: { error: `could not read the creator fee (${e.shortMessage || e.message.split('\n')[0]})`, retry: `gang creator-fee --token ${token}${net}` } }
  }
  const padGen = ctx.gen ?? (share == null ? '1.0' : '2.0')
  if (share == null) return { padGen, creatorFee: null }
  return {
    padGen,
    creatorFee: {
      sharePct: pctOf(share), creator, claimable: await units(ctx, quote, owed), claimableRaw: owed.toString(),
      ...(owed > 0n && { claim: `${claimCmd(token, net)} (the creator only)` }),
      note: `${pctOf(share)}% of the 1% curve fee of each curve buy and sell is kept for the creator, apart from the pool tax and its recipient; the creator claims it any time`,
    },
  }
}

/**
 * Every 2.0 curve token `creator` created on this network, newest first, with what it can claim: { tokens, totals,
 * scanned }. Read on chain (each 2.0 pad's allTokens, in multicall batches), so it works without gang.fun's index.
 */
export async function creatorFeeList(ctx, creator) {
  const tokens = []
  const scanned = []
  let unread = 0 // tokens whose row could not be read
  for (const g of ctx.gens) {
    const share = await creatorFeeShareOf(ctx, g.pad)
    if (share == null) continue
    const n = Number(await ctx.read(g.pad, CURVES_ABI, 'tokenCount'))
    const take = Math.min(n, MAX_SCAN)
    scanned.push({ padGen: g.gen ?? '2.0', pad: g.pad, tokens: n, read: take })
    const call = (functionName, args) => ({ address: g.pad, abi: functionName === 'creatorFeeOf' ? CREATOR_FEE_ABI : CURVES_ABI, functionName, args })
    // one eth_call per batch (viem would split it into 1 KB calls), and a row that fails is skipped, not the whole scan
    const multi = (contracts, allowFailure = true) => ctx.client.multicall({ contracts, allowFailure, batchSize: 0 })
    for (let from = 0; from < take; from += BATCH) {
      const idx = Array.from({ length: Math.min(BATCH, take - from) }, (_, i) => BigInt(n - 1 - from - i))
      const addrs = await multi(idx.map((i) => call('allTokens', [i])), false)
      const curves = await multi(addrs.map((t) => call('curves', [t])))
      unread += curves.filter((c) => c.status !== 'success').length
      const mine = addrs.map((t, i) => ({ t, c: curves[i].result })).filter(({ c }) => c && same(c[0], creator))
      if (!mine.length) continue
      const owedOf = await multi(mine.map(({ t }) => call('creatorFeeOf', [t])))
      const syms = await multi(mine.flatMap(({ t, c }) => [{ address: t, abi: SYMBOL_ABI, functionName: 'symbol' }, { address: c[1], abi: SYMBOL_ABI, functionName: 'symbol' }]))
      for (const [i, { t, c }] of mine.entries()) {
        if (owedOf[i].status !== 'success') { unread++; continue }
        const owed = [owedOf[i].result]
        tokens.push({
          token: t, symbol: syms[2 * i].result ?? null, quote: c[1], quoteSymbol: syms[2 * i + 1].result ?? null, graduated: c[6],
          padGen: g.gen ?? '2.0', claimable: await units(ctx, c[1], owed[0]), claimableRaw: owed[0],
        })
      }
    }
  }
  // per quote: what all of them add up to
  const sums = new Map()
  for (const x of tokens) {
    const k = x.quote.toLowerCase()
    sums.set(k, { quote: x.quote, quoteSymbol: x.quoteSymbol, raw: (sums.get(k)?.raw ?? 0n) + x.claimableRaw })
  }
  const totals = await Promise.all([...sums.values()].map(async (s) => ({ quote: s.quoteSymbol ?? s.quote, claimable: await units(ctx, s.quote, s.raw) })))
  return {
    tokens: tokens.map((x) => ({ ...x, claimableRaw: x.claimableRaw.toString() })), totals, scanned,
    ...(unread && { unreadNote: `${unread} token(s) could not be read (RPC); run it again to include them` }),
  }
}

const USAGE = 'usage: gang creator-fee [--token <addr>] [--from <creator>] [--claim [--to <addr>]] [--testnet] — see gang help'

/** Entry for `gang creator-fee`. io: { opt, flag, out, fail, summarize } from index.js. */
export async function runCreatorFee({ opt, flag, out, fail, summarize }) {
  const testnet = flag('testnet')
  const net = testnet ? ' --testnet' : ''
  const rawOnly = flag('calldata')
  if (flag('to') && !flag('claim')) fail('--to goes with --claim (where the claimed fee is sent)')
  if (flag('claim') && !flag('token')) fail('--claim needs --token <addr>: one token per claim (gang creator-fee lists them)')
  let ctx
  try { ctx = creatorFeeCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)

  if (flag('from') && !isAddress(opt('from') ?? '')) fail('--from must be a 0x address (checksummed or all lowercase)', { got: opt('from') ?? null })
  if (!flag('token')) {
    const me = walletFor(ctx, opt('from'))
    const r = await creatorFeeList(ctx, me)
    if (!r.scanned.length) {
      return out({
        success: true, chainId, creator: me, tokens: [], totals: [],
        note: `GangLaunchpad 2.0 is not on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} in this CLI version yet: tokens created on 1.0 have no creator fee (their whole 1% curve fee is the platform's)`,
      })
    }
    const due = r.tokens.filter((x) => x.claimableRaw !== '0')
    return out({
      success: true, chainId, creator: me, ...r,
      ...(r.scanned.some((s) => s.read < s.tokens) && { scanNote: `only the newest ${MAX_SCAN} tokens of a pad were read` }),
      note: 'GangLaunchpad 2.0 keeps 70% of the 1% curve fee of each curve buy and sell for the token\'s creator; 1.0 tokens and 打新 sales have none',
      ...(due.length && { next: due.map((x) => claimCmd(x.token, net)) }),
    })
  }

  const token = opt('token')
  if (!isAddress(token ?? '')) fail('--token must be a 0x address', { got: token ?? null })
  const kind = await atTokenPad(ctx, token)
  if (kind === null) return fail('could not read the token\'s kind from GangLaunchpad (kindOf; RPC error)', { token, retry: 'same command again' })
  if (kind === 'none') return fail(`not a GangLaunchpad token on ${testnet ? 'the BSC testnet' : 'BSC mainnet'}${testnet ? '' : ' (add --testnet for a testnet token)'}`, { token, chainId })
  if (kind === 'fair') return fail('a 打新 (fair-mint) sale has no creator fee: only V3 curve trades on GangLaunchpad 2.0 pay one', { token, kind })
  const c = await ctx.read(ctx.pad, CURVES_ABI, 'curves', [token])
  const [creator, quote, , , , , graduated] = c
  const symbol = await ctx.read(token, SYMBOL_ABI, 'symbol').catch(() => null)
  const view = await curveCreatorFee(ctx, token, { creator, quote }, net)
  if (!view.creatorFee) {
    return fail(`this token is on GangLaunchpad ${view.padGen}, which has no creator fee: its whole 1% curve fee goes to the platform (the creator fee is on tokens created on 2.0)`,
      { token, padGen: view.padGen, pad: ctx.pad })
  }
  const base = { chainId, token, symbol, graduated, padGen: view.padGen, pad: ctx.pad, ...view.creatorFee }

  if (!flag('claim')) return out({ success: true, ...base })

  const me = walletFor(ctx, opt('from'))
  if (!same(me, creator)) return fail(HINTS.NotCreator, { token, wallet: me, creator })
  if (BigInt(view.creatorFee.claimableRaw) === 0n) return fail(HINTS.ZeroAmount, { token, claimable: view.creatorFee.claimable })
  const to = flag('to') ? opt('to') : me
  if (!isAddress(to ?? '')) fail('--to must be a 0x address (checksummed or all lowercase)', { got: to ?? null })
  if (to === zeroAddress) fail('--to cannot be the zero address')
  if (same(to, ctx.pad)) fail('--to cannot be the pad itself: the fee would stay where it is (the pad refuses it)')
  const args = [token, to]
  try {
    await ctx.client.simulateContract({ account: me, address: ctx.pad, abi: CREATOR_FEE_ABI, functionName: 'claimCreatorFee', args })
  } catch (e) {
    const r = revertOf(e)
    return out({ success: false, step: 'claim-creator-fee', ...(r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] }) })
  }
  const data = encodeFunctionData({ abi: CREATOR_FEE_ABI, functionName: 'claimCreatorFee', args })
  // --to one of the platform's modules: say what pays it out from there (and warn when its quote is another one)
  const toType = same(to, me) ? null : await ctx.read(to, MODULE_TYPE_ABI, 'moduleType').then((t) => hexToString(t, { size: 32 }).replace(/\0+$/, '')).catch(() => null)
  let toModule = { payOut: null, warning: null }
  if (toType && payOutCmd(toType, to)) {
    const bound = await ctx.read(to, QUOTE_ABI, 'quote').catch(() => null)
    const sym = (a) => (a && !/^0x0{40}$/.test(a) ? ctx.read(a, SYMBOL_ABI, 'symbol').catch(() => null) : null)
    const [quoteSymbol, boundSymbol] = await Promise.all([sym(quote), sym(bound)])
    toModule = claimToModule({ moduleType: toType, at: to, net, bound, quote, quoteSymbol, boundSymbol })
  }
  const { payOut, warning } = toModule
  return out(step(ctx, { from: me, to: ctx.pad, data }, {
    step: 'claim-creator-fee', chainId, token, symbol, padGen: view.padGen, amount: view.creatorFee.claimable,
    to, ...(!same(to, me) && { toNote: `the fee goes to --to, not to this wallet${payOut ? `: --to is a module (${toType}); ${warning ? `${warning}. ` : ''}${payOut}` : ''}` }),
    ...(warning && { warning }),
    note: 'claims all of it; the fee keeps growing with later curve trades and can be claimed again',
  }, rawOnly, summarize))
}

