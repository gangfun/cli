import { createPublicClient, encodeFunctionData, formatUnits, hexToString, isAddress, parseAbi, zeroAddress } from 'viem'
import { revertOf as revertIn, step, units } from './steps.js'
import { atTokenPad, CREATOR_FEE_ABI, creatorFeeShareOf, GANGSWAP_KIND, NOT_ON_MAINNET, PAD3_GEN, padNets, rpcTransport } from './gangpad.js'
import { feesRevertOf, GANGSWAP_FEES_ABI, gangSwapFeeOf, gangSwapFeeView, gangSwapKnownContracts, gangSwapRouterAddresses, gangSwapSet } from './gangswap.js'
import { walletFor } from './fair.js'
import { promoteTermsOf } from './promote.js'
import { floorVerified } from './floor.js'

/**
 * `gang creator-fee` — the GangLaunchpad 2.0 creator fee (docs/SPEC-CURVE-CREATOR-FEE-2026-10-31.md): of the 1% fee on
 * each V3 curve buy and sell, 70% is kept on the pad for the token's creator (`creatorFeeOf`), the rest goes to the
 * platform. The creator claims it with `claimCreatorFee(token, to)`, to any address, before or after graduation, with no
 * deadline. It is the creating wallet's own: it never goes to the tax recipient, a buy-back splitter, a split module or
 * an LP splitter. 打新 sales and 1.0 pads have none (on 1.0 the whole curve fee is the platform's). A token made with
 * promoter terms (gang create --promote) pays part of it to the promoter of each bound wallet: creatorFeeOf is already net of that.
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
const CAP_QUOTE_ABI = parseAbi(['function capQuote() view returns (address)', 'function floorQuote() view returns (address)', 'function floorToken() view returns (address)'])
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
 * distribute. The capped recipient splits its own quote as the tax (the payees' part counted against the cap) and
 * burns any other asset. null: not one of these.
 */
export function payOutCmd(moduleType, at, net = '', { asset, assetSymbol } = {}) {
  const t = String(moduleType ?? '')
  const base = t.startsWith('buyback-burn-') ? 'gang buyback' : t === 'lp-burn-v1' ? 'gang lp'
    : t === 'split-v1' ? 'gang split' : t === 'combo-v1' ? 'gang combo' : t === 'capped-v1' ? 'gang capped' : t === 'floor-v1' ? 'gang floor' : null
  if (!base) return null
  const splitter = base === 'gang buyback' || base === 'gang lp'
  const m = `--module ${at ?? '<module>'}`
  if (base === 'gang capped') {
    return asset
      ? `${base} distribute ${m} --asset ${asset}${net} (anyone) sends ALL of it to 0xdead: ${assetSymbol ?? 'this asset'} is not the module's quote, so it is burned, paid to nobody`
      : `${base} distribute ${m}${net} (anyone) then splits it as the tax: the payees' part is pushed and counted against the cap (so it only uses the cap up sooner), the rest set aside for buy-back and liquidity`
  }
  if (base === 'gang floor') {
    return asset
      ? `${base} distribute ${m} --asset ${asset}${net} (anyone) sends ALL of it to 0xdead: ${assetSymbol ?? 'this asset'} is not the module's quote, so it is burned, paid to nobody`
      : `${base} distribute ${m}${net} (anyone) then splits it as the tax: the payees' part (if the module has payees and their cap is not reached) is pushed and counted against the cap, the rest joins the treasury every holder can redeem`
  }
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
export function claimToModule({ moduleType, at, net = '', bound, quote, quoteSymbol, boundSymbol, capQuote, capSymbol }) {
  const other = !!bound && !!quote && bound.toLowerCase() !== quote.toLowerCase()
  const unbound = !bound || /^0x0{40}$/.test(bound)
  // a capped recipient burns every asset but its quote: unbound, its quote is already fixed (capQuote)
  const burns = moduleType === 'capped-v1' || moduleType === 'floor-v1'
  const noun = moduleType === 'floor-v1' ? 'floor module' : 'capped recipient'
  const burned = burns && !!quote && (unbound ? !!capQuote && capQuote.toLowerCase() !== quote.toLowerCase() : other)
  const payOut = payOutCmd(moduleType, at, net, (other && !unbound) || burned ? { asset: quote, assetSymbol: quoteSymbol } : {})
  if (!payOut) return { payOut: null, warning: null }
  if (burned) return { payOut, warning: `the ${noun}'s quote is ${(unbound ? capSymbol : boundSymbol) ?? (unbound ? capQuote : bound)}, this fee is in ${quoteSymbol ?? quote}: it sends any other asset to 0xdead in full, so a fee claimed there is burned` }
  // its quote unknown (capQuote() unread): never stay silent about a burn that may follow
  if (burns && unbound && !capQuote) {
    return { payOut, warning: `could not read the ${noun}'s quote (${moduleType === 'floor-v1' ? 'floorQuote' : 'capQuote'}): if it is not ${quoteSymbol ?? quote}, this fee's quote, a fee claimed there is burned (it sends any other asset to 0xdead in full). Check gang ${moduleType === 'floor-v1' ? 'floor' : 'capped'} status --module ${at ?? '<module>'}${net} first` }
  }
  if (unbound) return { payOut, warning: 'the module is not bound to a token yet: it pays this out only once it is bound (its launch binds it)' }
  if (!other) return { payOut, warning: null }
  return {
    payOut,
    warning: `the module's own quote is ${boundSymbol ?? bound}, this fee is in ${quoteSymbol ?? quote}: split / distribute of the module's quote leave it where it is`,
  }
}
/**
 * `--to` a contract that says it is a floor module and is not known to be one (`verified`: false, or null when the
 * check could not be read; `hasFactory`: whether the token's pad generation has a floor factory to check against). Pure.
 */
export function unverifiedFloorNote(verified, hasFactory) {
  if (verified === null) return 'could not check whether GangFloorModuleFactory made this contract (RPC error): run the command again before claiming there'
  if (!hasFactory) return 'this contract says it is a floor module, but this token\'s GangLaunchpad generation has no floor factory to check it against: a fee claimed there is in that contract\'s hands, and nothing here confirms it is a treasury holders can redeem'
  return 'this contract says it is a floor module, but GangFloorModuleFactory did not make it: a fee claimed there is in its hands, not in a treasury holders can redeem'
}

/** `--to` a floor module that was not cloned for `token` (or whose token could not be read): what to say. Pure. */
export function floorModuleOfAnother(floorToken, token) {
  if (!floorToken) return 'could not read which token this floor module was cloned for: if it is not this token, the fee goes to another token\'s holders and payees. Check gang floor status --module first'
  if (floorToken.toLowerCase() === String(token).toLowerCase()) return null
  return `this floor module was cloned for another token (${floorToken}), not this one: a fee claimed there goes to that token's payees and holders, and this token's holders get nothing of it`
}
const LAUNCH_TYPES = { buyback: 'buyback-burn-v4', lp: 'lp-burn-v1', split: 'split-v1', combo: 'combo-v1', capped: 'capped-v1', floor: 'floor-v1' }

/** Added to the create's note when the tax recipient is one of the dev's modules (`module`: its name; `kind`: buyback | lp | split | combo | capped). */
export const notThroughModule = (module, { token, at, net = '', kind } = {}) =>
  `This creator fee is yours, the creating wallet's: it does not go through the ${module}, which gets only the recipient's part of the pool tax after graduation.`
  // capped: the fee kept (or claimed anywhere else) is never limited by the cap; claimed into the module it is split as tax
  + (kind === 'capped' ? ' The cap never limits it: it covers only the recipient\'s part of the pool tax.' : '')
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
  const terms = await promoteTermsOf(ctx, token).catch(() => null)
  return {
    padGen,
    creatorFee: {
      sharePct: pctOf(share), creator, ...(terms?.shareBps > 0 && { promoterSharePct: terms.sharePct, promoterNote: `on trades of wallets bound to a promoter, ${terms.sharePct}% of this goes to the promoter; claimable is what is left for the creator` }), claimable: await units(ctx, quote, owed), claimableRaw: owed.toString(),
      ...(owed > 0n && { claim: `${claimCmd(token, net)} (the creator only)` }),
      note: `${pctOf(share)}% of the 1% curve fee of each curve buy and sell is kept for the creator, apart from the pool tax and its recipient; the creator claims it any time`,
    },
  }
}

/**
 * Every 2.0 / 3.0 curve token `creator` created on this network, newest first, with what it can claim: { tokens, totals,
 * scanned }. Read on chain (each such pad's allTokens, in multicall batches), so it works without gang.fun's index.
 */
export async function creatorFeeList(ctx, creator) {
  const tokens = []
  const scanned = []
  let unread = 0 // tokens whose row could not be read
  let gsCtx
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
      // 3.0: a graduated GangSwap token (kind 4) also has the creator's part of its pool fee, on GangSwapFees
      const gradKinds = g.gen === PAD3_GEN && mine.some(({ c }) => c[6]) ? await multi(mine.map(({ t }) => call('kindOf', [t]))) : []
      for (const [i, { t, c }] of mine.entries()) {
        if (owedOf[i].status !== 'success') { unread++; continue }
        const owed = [owedOf[i].result]
        let pool = null
        if (c[6] && gradKinds[i] && gradKinds[i].status !== 'success') unread++
        if (c[6] && Number(gradKinds[i]?.result ?? 0) === GANGSWAP_KIND) {
          // ctx on this pad only for the GangSwap set's addresses
          pool = await gangSwapFeeOf((gsCtx ??= { ...ctx, pad: g.pad }), t, c[10]).catch(() => null)
          if (!pool) unread++
        }
        tokens.push({
          token: t, symbol: syms[2 * i].result ?? null, quote: c[1], quoteSymbol: syms[2 * i + 1].result ?? null, graduated: c[6],
          padGen: g.gen ?? '2.0', claimable: await units(ctx, c[1], owed[0]), claimableRaw: owed[0],
          ...(pool && { kind: 'gangswap', poolRaw: pool.claimable, gangSwapPool: { claimable: await units(ctx, c[1], pool.claimable), contract: pool.fees } }),
        })
      }
    }
  }
  // per quote: what all of them add up to
  const sums = new Map()
  for (const x of tokens) {
    const k = x.quote.toLowerCase()
    sums.set(k, { quote: x.quote, quoteSymbol: x.quoteSymbol, raw: (sums.get(k)?.raw ?? 0n) + x.claimableRaw, pool: (sums.get(k)?.pool ?? 0n) + (x.poolRaw ?? 0n) })
  }
  const totals = await Promise.all([...sums.values()].map(async (s) => ({ quote: s.quoteSymbol ?? s.quote, claimable: await units(ctx, s.quote, s.raw), ...(s.pool > 0n && { gangSwapPool: await units(ctx, s.quote, s.pool) }) })))
  return {
    tokens: tokens.map(({ poolRaw: _p, ...x }) => ({ ...x, claimableRaw: x.claimableRaw.toString() })), totals, scanned,
    ...(unread && { unreadNote: `${unread} token(s) could not be read (RPC); run it again to include them` }),
  }
}

const USAGE = 'usage: gang creator-fee [--token <addr>] [--from <creator>] [--claim [--to <addr>] [--part curve|pool]] [--testnet] — see gang help'

/** Entry for `gang creator-fee`. io: { opt, flag, out, fail, summarize } from index.js. */
export async function runCreatorFee({ opt, flag, out, fail, summarize }) {
  const testnet = flag('testnet')
  const net = testnet ? ' --testnet' : ''
  const rawOnly = flag('calldata')
  if (flag('to') && !flag('claim')) fail('--to goes with --claim (where the claimed fee is sent)')
  if (flag('part') && !flag('claim')) fail('--part goes with --claim (a GangSwap token has two parts: curve | pool)')
  if (flag('part') && !['curve', 'pool'].includes(opt('part'))) fail('--part must be curve or pool', { got: opt('part') ?? null })
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
    const due = r.tokens.filter((x) => x.claimableRaw !== '0' || Number(x.gangSwapPool?.claimable ?? 0) > 0)
    return out({
      success: true, chainId, creator: me, ...r,
      ...(r.scanned.some((s) => s.read < s.tokens) && { scanNote: `only the newest ${MAX_SCAN} tokens of a pad were read` }),
      note: 'GangLaunchpad 2.0 and 3.0 keep 70% of the 1% curve fee of each curve buy and sell for the token\'s creator, less the share of any promoter the creator set (gang create --promote); 1.0 tokens and 打新 sales have none',
      ...(due.length && { next: due.map((x) => claimCmd(x.token, net)) }),
    })
  }

  const token = opt('token')
  if (!isAddress(token ?? '')) fail('--token must be a 0x address', { got: token ?? null })
  const kind = await atTokenPad(ctx, token)
  if (kind === null) return fail('could not read the token\'s kind from GangLaunchpad (kindOf; RPC error)', { token, retry: 'same command again' })
  if (kind === 'none') return fail(`not a GangLaunchpad token on ${testnet ? 'the BSC testnet' : 'BSC mainnet'}${testnet ? '' : ' (add --testnet for a testnet token)'}`, { token, chainId })
  if (kind === 'fair') return fail('a 打新 (fair-mint) sale has no creator fee: only V3 curve trades on GangLaunchpad 2.0 / 3.0 pay one', { token, kind })
  if (kind === 'fly') return fail('a 铸币飞轮 (Mint Flywheel) token has no creator fee: only V3 curve trades on GangLaunchpad 2.0 / 3.0 pay one (its creator gets the dev cut and a share of the pool tax: gang info)', { token, kind })
  const c = await ctx.read(ctx.pad, CURVES_ABI, 'curves', [token])
  const [creator, quote, , , , , graduated] = c
  const symbol = await ctx.read(token, SYMBOL_ABI, 'symbol').catch(() => null)
  const view = await curveCreatorFee(ctx, token, { creator, quote }, net)
  if (!view.creatorFee) {
    return fail(`this token is on GangLaunchpad ${view.padGen}, which has no creator fee: its whole 1% curve fee goes to the platform (the creator fee is on tokens created on 2.0 or 3.0)`,
      { token, padGen: view.padGen, pad: ctx.pad })
  }
  // a GangSwap token (kind 4): the curve part on the pad as any, and after graduation its part of the pool fee on GangSwapFees
  const gs = kind === 'gangswap'
  const pair = c[10]
  const pool = gs ? await gangSwapFeeView(ctx, token, { graduated, pair }, net) : null
  const base = { chainId, token, symbol, graduated, padGen: view.padGen, pad: ctx.pad, ...(gs && { kind }), ...view.creatorFee, ...(pool && { pool }) }

  if (!flag('claim')) return out({ success: true, ...base })
  if (flag('part') && !gs) fail('--part is for GangSwap tokens: this token\'s creator fee is on the pad only, leave --part out', { token, kind })

  const me = walletFor(ctx, opt('from'))
  if (!same(me, creator)) return fail(HINTS.NotCreator, { token, wallet: me, creator })
  const part = opt('part')
  const curveDue = BigInt(view.creatorFee.claimableRaw) > 0n && part !== 'pool'
  const poolDue = gs && BigInt(pool.claimableRaw ?? 0) > 0n && part !== 'curve'
  // a pool part that could not be read is never taken for "nothing there"
  if (gs && pool.error && part !== 'curve' && !curveDue) return fail(pool.error, { token, retry: 'same command again' })
  if (!curveDue && !poolDue) {
    return fail(gs ? `nothing to claim yet${part ? ` in the ${part} part` : ''}: the curve part grows with curve trades, the pool part with GangSwap buys after graduation` : HINTS.ZeroAmount, { token, claimable: view.creatorFee.claimable, ...(gs && { pool }) })
  }
  const to = flag('to') ? opt('to') : me
  if (!isAddress(to ?? '')) fail('--to must be a 0x address (checksummed or all lowercase)', { got: to ?? null })
  if (to === zeroAddress) fail('--to cannot be the zero address')
  if (same(to, ctx.pad)) fail('--to cannot be the pad itself: the fee would stay where it is (the pad refuses it)')
  let toUnchecked = {}
  if (gs) {
    // never into a GangSwap contract or the token: nothing could take it out of there
    const set = await gangSwapSet(ctx, token).catch((e) => fail(`could not read GangSwap's contracts: ${e.message}`, { token, retry: 'same command again' }))
    // another wallet: every known version's contracts too, as far as they can be read
    const known = same(to, me) ? { addresses: [], unread: [] } : await gangSwapKnownContracts(ctx, testnet)
    if (known.unread.length) toUnchecked = { toUnchecked: `--to was not checked against every GangSwap contract: those of ${known.unread.join(', ')} could not be read` }
    const no = [token, pair, ctx.wbnb, ctx.router, ...gangSwapRouterAddresses(testnet), ...Object.values(set), ...known.addresses].find((a) => same(a, to))
    if (no) fail('--to cannot be the token, its pair, WBNB, a GangSwap contract or a router: the fee could not be taken out of there', { got: to })
  }
  const args = [token, to]
  if (curveDue) try {
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
    const capQuote = toType === 'capped-v1' ? await ctx.read(to, CAP_QUOTE_ABI, 'capQuote').catch(() => null)
      : toType === 'floor-v1' ? await ctx.read(to, CAP_QUOTE_ABI, 'floorQuote').catch(() => null) : null
    const sym = (a) => (a && !/^0x0{40}$/.test(a) ? ctx.read(a, SYMBOL_ABI, 'symbol').catch(() => null) : null)
    const [quoteSymbol, boundSymbol, capSymbol] = await Promise.all([sym(quote), sym(bound), sym(capQuote)])
    toModule = claimToModule({ moduleType: toType, at: to, net, bound, quote, quoteSymbol, boundSymbol, capQuote, capSymbol })
    // a floor module serves one token: a fee claimed into another token's module goes to that token's holders and payees
    if (toType === 'floor-v1') {
      // only a module GangFloorModuleFactory made does what a floor module does: nothing is promised about any other
      const verified = await floorVerified(ctx.read, to, ctx.floorFactory ?? null)
      if (verified !== true) {
        toModule = { payOut: 'what this contract does with a fee sent to it is unknown', warning: unverifiedFloorNote(verified, !!ctx.floorFactory) }
      } else {
        const floorToken = await ctx.read(to, CAP_QUOTE_ABI, 'floorToken').catch(() => null)
        const note = floorModuleOfAnother(floorToken, token)
        if (note) toModule = { ...toModule, warning: toModule.warning ? `${note}. Also: ${toModule.warning}` : note }
      }
    }
  }
  const { payOut, warning } = toModule
  // the pool part: its own contract and tx
  const poolStep = async (others = {}) => {
    const f = await gangSwapFeeOf(ctx, token, pair).catch((e) => fail(e.message, { token, retry: 'same command again' }))
    try {
      await ctx.client.simulateContract({ account: me, address: f.fees, abi: GANGSWAP_FEES_ABI, functionName: 'claim', args })
    } catch (e) {
      const r = feesRevertOf(e, HINTS)
      return { success: false, step: 'claim-gangswap-fee', part: 'pool', ...(r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] }) }
    }
    return step(ctx, { from: me, to: f.fees, data: encodeFunctionData({ abi: GANGSWAP_FEES_ABI, functionName: 'claim', args }) }, {
      step: 'claim-gangswap-fee', part: 'pool', chainId, token, symbol, kind, padGen: view.padGen, contract: f.fees, amount: formatUnits(f.claimable, 18), quote: 'WBNB',
      to, ...(!same(to, me) && { toNote: `the fee goes to --to, not to this wallet${payOut ? `: --to is a module (${toType}); ${warning ? `${warning}. ` : ''}${payOut}` : ''}` }),
      ...(warning && { warning }), ...toUnchecked, ...others,
      note: `collects what the pair still holds, then claims the creator's ${f.sharePct}% of the GangSwap fee on buys, in WBNB; it keeps growing with later buys`,
    }, rawOnly, summarize)
  }
  if (!curveDue) return out(await poolStep())
  const curve = step(ctx, { from: me, to: ctx.pad, data }, {
    step: 'claim-creator-fee', ...(gs && { part: 'curve', kind }), chainId, token, symbol, padGen: view.padGen, amount: view.creatorFee.claimable,
    to, ...(!same(to, me) && { toNote: `the fee goes to --to, not to this wallet${payOut ? `: --to is a module (${toType}); ${warning ? `${warning}. ` : ''}${payOut}` : ''}` }),
    ...(warning && { warning }), ...toUnchecked,
    ...(poolDue && !rawOnly && { alsoClaimable: { part: 'pool', amount: pool.claimable, quote: 'WBNB', then: `gang creator-fee --token ${token}${net} --claim --part pool${flag('to') ? ` --to ${to}` : ''}` } }),
    ...(gs && pool.error && part !== 'curve' && { poolError: pool.error }),
    note: 'claims all of it; the fee keeps growing with later curve trades and can be claimed again',
  }, rawOnly, summarize)
  // raw txs: both parts, two independent txs
  if (poolDue && rawOnly && curve.success) {
    const second = await poolStep()
    const row = (s) => ({ step: s.step, part: s.part, amount: s.amount, tx: s.tx })
    return out(second.success ? { ...curve, steps: [row(curve), row(second)], stepsNote: 'two separate claims, each its own tx; tx = the first' } : { ...curve, poolError: second.error })
  }
  return out(curve)
}

