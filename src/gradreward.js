import { createPublicClient, encodeFunctionData, isAddress, parseAbi, parseUnits } from 'viem'
import { walletFor } from './fair.js'
import { atTokenPad, KIND_UNREAD, NOT_ON_MAINNET, PAD3_GEN, padNets, rpcTransport } from './gangpad.js'
import { missingRead } from './base.js'
import { revertOf as revertIn, step, units } from './steps.js'

/**
 * 冲毕业奖励, the graduation reward of a GangLaunchpad 3.0 curve token (docs/SPEC-GRAD-REWARD-2026-11-17.md §13). The
 * creator seeds a reward pool at create, in the token's quote (`gang create … --grad-reward <amount>`). The pad keeps
 * the last N counted curve buys. A buy counts when the Agent gate is on and it actually spends at least minBuy; the buy
 * that graduates the token always counts. A curve sell takes that wallet's earlier entries out. At graduation the
 * newest valid entry gets lastBps of the pool on top; all valid entries, the newest included, split the rest by what
 * each actually spent. Buyers claim for 180 days, then the rest is swept back to the creator. A token that does not
 * graduate: the creator may ask for the pool back after refundAfter, and takes it only after a public 7-day notice,
 * within 3 days (else the request lapses); a graduation during the notice pays as usual.
 *
 * The pool is the creator's own money, paid by a fixed public rule; buyers buy the token as on any curve.
 *
 * A GangSwap curve token (kind 4) takes one too (createGangSwapWithGradReward, gangswap.js): the same rules, always in
 * WBNB, without a carry or a promoter share.
 */

const TAX = '(uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)'
const CFG = '(uint128 seed, uint96 minBuy, uint8 entries, uint16 lastBps, uint16 carryBps, uint32 refundAfter, uint16 promoteBps, uint32 promoteWindow)'
const VIEW = '(uint8 state, uint128 pot, uint96 minBuy, uint8 entries, uint16 lastBps, uint16 carryBps, uint32 refundAfter, uint40 createdAt, uint40 refundAt, uint40 gradAt, uint64 seq, address countdown, uint128 claimed, uint128 carryOwed, bool settled, uint16 valid, uint128 validSpent, bool refundPending)'
export const GRAD_PAD_ABI = parseAbi([
  `function createWithGradReward(string name, string symbol, string logoURI, string metaURI, address quote, address refPool, ${TAX} tax, uint256 gradBnb, ${CFG} cfg) returns (address token)`,
  'function gradRewardDeps() view returns (bool open, address handlerAdmin, address countdownFactory)',
  `function gradReward(address token) view returns (${VIEW})`,
  'function gradEntries(address token) view returns (address[] buyers, uint64[] seqs, uint96[] spent, bool[] valid)',
  'function gradClaimable(address token, address wallet) view returns (uint256)',
  'function agentGateEnabled() view returns (bool)',
  'function claimGradReward(address token) returns (uint256 amount)',
  'function settleGradReward(address token)',
  'function sweepGradReward(address token)',
  'function retryCarry(address token)',
  'function requestGradRefund(address token)',
  'function cancelGradRefund(address token)',
  'function gradRefund(address token) returns (uint256 amount)',
  'error GradNotOpen()', 'error BadGradConfig()', 'error BadCountdown()', 'error NotGradState()', 'error RefundNotDue()',
  'error AlreadyClaimed()', 'error NothingToClaim()', 'error SweepNotDue()', 'error NoCarryOwed()', 'error CarryGasLow()',
  'event GradRewardSet(address indexed token, uint256 seed, uint256 minBuy, uint8 entries, uint16 lastBps, uint16 carryBps, uint32 refundAfter, address countdown)',
  'event GradEntry(address indexed token, address indexed buyer, uint64 seq, uint256 spent, uint256 tokens)',
  'event GradDisqualified(address indexed token, address indexed wallet, uint64 seq)',
  'event GradRewardBooked(address indexed token, uint256 pot, uint256 carry, uint64 seq)',
  'event GradSettled(address indexed token, uint256 valid, uint64 lastSeq, uint256 lastShare, uint256 restPay, uint256 validSpent)',
  'event GradClaimed(address indexed token, address indexed wallet, uint256 amount)',
  'event GradSwept(address indexed token, address indexed to, uint256 amount)',
  'event RefundRequested(address indexed token, uint256 executableAt, uint256 expiresAt)',
  'event RefundCancelled(address indexed token)',
  'event Refunded(address indexed token, address indexed dev, uint256 amount)',
  'event CarrySent(address indexed token, address indexed module, uint256 amount)',
  'event CarryOwed(address indexed token, address indexed module, uint256 amount)',
  'event GradRewardDepsSet(bool open, address handlerAdmin, address countdownFactory)',
])
/** What `gang tx` decodes the graduation reward's logs with. */
export const GRAD_EVENT_ABIS = [GRAD_PAD_ABI]

export const HINTS = {
  GradNotOpen: 'the graduation reward is closed on this pad: drop --grad-reward',
  BadGradConfig: '--grad-reward out of bounds: a seed above 0, --gr-min-buy above 0, --gr-entries 1–20, --gr-last 0–50, --gr-refund-days 30–180, --gr-carry 0–50',
  BadCountdown: 'the tax recipient is a countdown reward module made for another token or quote (or a carry was asked without one)',
  NotGradState: 'the reward is not in the state this needs (on the curve for a refund; graduated for a claim, a settle or a sweep)',
  RefundNotDue: 'a refund needs: --gr-refund-days passed since the create to ask; then a 7-day public notice; then 3 days to take it, after which the request lapses',
  AlreadyClaimed: 'this wallet already claimed its graduation reward for this token',
  NothingToClaim: 'this wallet has no valid entry in the list: it was not among the last buys counted, or it sold on the curve after its buys',
  SweepNotDue: 'the unclaimed rest can be swept 180 days after graduation',
  NoCarryOwed: 'no carry is owed to the countdown module',
  CarryGasLow: 'too little gas for the countdown module\'s receiveCarry: send the tx with more gas',
}
export const revertOf = (e) => revertIn(e, [GRAD_PAD_ABI], HINTS)

export const STATES = ['none', 'on the curve', 'graduated: claims open', 'refunded to the creator', 'closed']
export const MAX_ENTRIES = 20
export const DEFAULTS = { entries: 10, lastPct: 30, refundDays: 90, carryPct: 20 }
// in BNB, converted into the quote at the pad's own rate (graduation amount ÷ target)
export const DEFAULT_MIN_BUY_BNB = '0.01'
export const MIN_SEED_BNB = '0.1'
export const NOTICE_DAYS = 7
export const WINDOW_DAYS = 3
export const CLAIM_DAYS = 180

export const GRAD_FLAGS = ['grad-reward', 'gr-min-buy', 'gr-entries', 'gr-last', 'gr-refund-days', 'gr-carry']
export const GRAD_USAGE = '--grad-reward <seed> [--gr-min-buy <amount>] [--gr-entries <1-20>] [--gr-last <0-50>] [--gr-refund-days <30-180>] [--gr-carry <0-50>, with --countdown-reward]: the reward pool you put in at create (in the token\'s quote), the least a buy must spend to count, how many of the last buys share it, the % the graduating buy gets on top, the days before you may ask for the pool back, and (with --countdown-reward) the % of the pool carried into the token\'s countdown reward at graduation (default 20)'
export const GRAD_ALONE = 'a --grad-reward create goes alone or with --countdown-reward only: no chained dev buy, GangBond or buy-back / split / LP / combined / floor / capped recipient, no --base, no --vault. A dev buy is its own gang buy after the create lands'
export const RULE = 'the reward pool is the creator\'s own money, paid to the last buys before graduation by a fixed public rule (by what each spent); buyers pay only the usual curve price and 1% fee and get the tokens they buy'

/** The --grad-reward / --gr-* flags, checked: { seed, minBuy, entries, lastBps, refundDays } (amounts as typed), or { error }. */
export function parseGradReward(opt, flag) {
  const num = (s) => /^(\d+(\.\d*)?|\.\d+)$/.test(String(s ?? '').trim())
  const seed = opt('grad-reward')
  if (!num(seed) || !(Number(seed) > 0)) return { error: `--grad-reward needs the seed: a positive amount of the token's quote (e.g. --grad-reward 0.5). ${GRAD_USAGE}`, got: seed ?? null }
  let minBuy = null
  if (flag('gr-min-buy')) {
    minBuy = opt('gr-min-buy')
    if (!num(minBuy) || !(Number(minBuy) > 0)) return { error: '--gr-min-buy must be a positive amount of the quote (the least a buy must actually spend to count)', got: minBuy ?? null }
  }
  const int = (name, def, lo, hi, what) => {
    if (!flag(name)) return { v: def }
    const n = Number(opt(name))
    if (!Number.isInteger(n) || n < lo || n > hi) return { error: `--${name} must be an integer between ${lo} and ${hi} (${what})`, got: opt(name) ?? null }
    return { v: n }
  }
  const e = int('gr-entries', DEFAULTS.entries, 1, MAX_ENTRIES, 'how many of the last counted buys share the pool')
  if (e.error) return e
  const l = int('gr-last', DEFAULTS.lastPct, 0, 50, '% of the payout the graduating buy gets on top')
  if (l.error) return l
  const r = int('gr-refund-days', DEFAULTS.refundDays, 30, 180, 'days after the create before you may ask for the pool back')
  if (r.error) return r
  const c = int('gr-carry', null, 0, 50, '% of the pool carried into the token\'s countdown reward at graduation')
  if (c.error) return c
  return { seed: String(seed).trim(), minBuy: minBuy && String(minBuy).trim(), entries: e.v, lastBps: l.v * 100, refundDays: r.v, carryBps: c.v == null ? null : c.v * 100 }
}

/** Whether `ctx.pad` takes a graduation reward now: { open: true } / { open: false, why } / { unread }. */
export async function gradSupport(ctx) {
  if (ctx.gen !== PAD3_GEN) return { open: false, why: `GangLaunchpad ${ctx.gen ?? ctx.pad} has no graduation reward (3.0 only)` }
  let deps
  try { deps = await ctx.read(ctx.pad, GRAD_PAD_ABI, 'gradRewardDeps') } catch (e) {
    if (missingRead(e)) return { open: false, why: `GangLaunchpad 3.0 on ${ctx.chainId === '97' ? 'the BSC testnet' : 'BSC mainnet'} has no graduation reward yet (the pad is not upgraded for it)` }
    return { unread: e.shortMessage || e.message.split('\n')[0] }
  }
  if (!deps[0]) return { open: false, why: 'the graduation reward is closed on this pad' }
  return { open: true, countdownFactory: deps[2] }
}

/** Why a carry can't be asked of this pad (its countdown factory is not this CLI's), or null. */
export const carryClosed = (padFactory, cliFactory) => (cliFactory && String(padFactory ?? '').toLowerCase() === cliFactory.toLowerCase()
  ? null
  : `--gr-carry: the pad has not opened the graduation reward's carry into the countdown reward yet (its countdown factory is ${padFactory ?? 'unset'}, this CLI's is ${cliFactory ?? 'none'}): add --gr-carry 0 to launch both without a carry`)

/**
 * Before a --countdown-reward launch clones its module (gas, and the metadata fixed for good): what the create would
 * refuse later about its --grad-reward, as { error, ...details }, or null.
 */
export async function gradLaunchCheck(read, pad, testnet, gr, cliFactory) {
  let deps
  try { deps = await read(pad, GRAD_PAD_ABI, 'gradRewardDeps') } catch (e) {
    if (missingRead(e)) return { error: `GangLaunchpad 3.0 on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} has no graduation reward yet (the pad is not upgraded for it): drop --grad-reward`, pad }
    return { error: 'could not check the pad for the graduation reward (RPC error)', pad, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' }
  }
  if (!deps[0]) return { error: 'the graduation reward is closed on this pad: drop --grad-reward', pad }
  const carryBps = gr.carryBps ?? DEFAULTS.carryPct * 100
  const closed = carryBps > 0 ? carryClosed(deps[2], cliFactory) : null
  return closed ? { error: closed, pad } : null
}

/** What a refused reward create says about money an earlier run may have set aside for it. */
export const fundsNote = (pad, sym = 'WBNB') => `this run moves nothing. If an earlier run ${sym === 'WBNB' ? 'wrapped BNB or ' : ''}approved the pad, that ${sym} is still in this wallet and yours, and the approval stays until you change it. This CLI has no ${sym === 'WBNB' ? 'unwrap or ' : ''}revoke command: in your wallet app, ${sym === 'WBNB' ? 'call withdraw(amount) on the WBNB contract for BNB, and ' : ''}set the ${sym} approval of ${pad} to 0 (approve(pad, 0))`

/** The create preview's note when the pad may already take more than the seed (the CLI approves only when it is short); null otherwise. */
export const allowanceNote = (allowance, seed, shown, sym, pad) => (allowance <= seed ? null : {
  current: allowance >= 2n ** 128n ? `unlimited (${sym})` : `${shown.allowance} ${sym}`, seed: `${shown.seed} ${sym}`,
  note: `this wallet's ${sym} approval of the pad is already larger than the seed, so no approval was built and it is left as it is. The create takes only ${shown.seed} ${sym}; ${allowance >= 2n ** 128n ? 'the approval may stay unlimited' : 'the rest of the approval stays'}. To reset it, in your wallet app set the ${sym} approval of ${pad} to 0 after the create (approve(pad, 0)), or to exactly the seed before it: this CLI has no revoke command`,
})

/** `amountBnb` (a decimal string) in the quote, at the rate the curve's graduation amount fixes (gradAmt ÷ target BNB). */
export const bnbInQuote = (amountBnb, gradAmt, targetBnb) =>
  (parseUnits(String(amountBnb), 18) * gradAmt) / parseUnits(String(targetBnb), 18)

const iso = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null)
const pctOf = (bps) => Number(bps) / 100

/** What the create preview says about the reward (pure; amounts as display strings). */
export function gradCreateView({ seed, minBuy, sym, entries, lastBps, refundDays, targetBnb, seedFloorNote, gateOn, carryBps = 0, toModule = false, gangSwap = false }) {
  const last = pctOf(lastBps)
  const carry = pctOf(carryBps)
  const pool = carry > 0 ? `the payout (the pool less the ${carry}% carry)` : 'the pool'
  const rest = toModule ? 'to the token\'s countdown reward module (its reward pool)' : 'back to you'
  return {
    pool: `${seed} ${sym}`, payWithThisTx: `${seed} ${sym}, pulled from this wallet in the create (approve the pad for it first)`,
    minBuy: `${minBuy} ${sym}`, entries, lastPct: last, refundDays,
    who: `the last ${entries} curve buys that each actually spend at least ${minBuy} ${sym} (after a wallet-cap or graduation cut); the buy that graduates the token at ${targetBnb} BNB counts whatever it spends. Only while the pad's Agent gate is on (${gateOn ? 'it is on now' : 'IT IS OFF NOW: no buy would count until gang turns it back on'}): with it off, no buy counts`,
    ...(carry > 0 && { carryPct: carry, carry: `at graduation ${carry}% of the pool goes into this token's countdown reward module, as its reward pool (through the module's receiveCarry; the pad found the module from the token's tax recipient, nobody types its address). If the module takes less (it refuses, or the gas runs short), the rest is owed and anyone resends it with gang grad-reward retry-carry. The last buys share the rest` }),
    split: last > 0
      ? `at graduation the buy that graduates it gets ${last}% of ${pool} on top; then all ${entries} entries, it included, split the rest by what each spent (a wallet with several entries adds them up)`
      : `at graduation all ${entries} entries split ${pool} by what each spent (a wallet with several entries adds them up)`,
    sells: 'a curve sell takes out every entry that wallet has so far; a later buy of the same wallet counts again',
    claims: `buyers claim with gang grad-reward claim for ${CLAIM_DAYS} days after graduation; then anyone sweeps the unclaimed rest (and the rounding dust) ${rest}`,
    refund: `if the token does not graduate: ${refundDays} days after the create you may ask for the pool back (gang grad-reward refund-request). The request is public for ${NOTICE_DAYS} days; a graduation in that time pays the buyers as usual. Then you have ${WINDOW_DAYS} days to take it (gang grad-reward refund), after which the request lapses and must be made again`,
    rule: RULE,
    ...(gangSwap && { gangSwap: 'the seed stays in the pad apart from the raise: it is never part of the GangSwap pool or its buy-back. No countdown module and no promoter share: what nobody claims goes back to you' }),
    ...(!gangSwap && { risks: 'anyone watching the curve can time the last buys, and one person with several Agent IDs can fill several entries: weighting by spend means many small entries earn no more than one large one, but a push into a full list still crowds out the oldest entries. A higher --gr-min-buy and more --gr-entries make that harder' }),
    ...(seedFloorNote && { seedFloor: seedFloorNote }),
    warning: `PERMANENT: ${seed} ${sym} leaves this wallet in the create. You get it back only through the refund above (if the token does not graduate)${toModule ? '' : ' or as the unclaimed rest 180 days after graduation'}. The size, the rules and the numbers never change`,
  }
}

/**
 * The token's reward as the pad says (null: none). `me`: a wallet to report its entries and claim for. All amounts in
 * the quote's units.
 */
export async function gradOf(ctx, token, quote, me = null) {
  if (ctx.gen !== PAD3_GEN) return null
  let v
  try { v = await ctx.read(ctx.pad, GRAD_PAD_ABI, 'gradReward', [token]) } catch (e) {
    if (missingRead(e)) return null
    throw e
  }
  if (Number(v.state) === 0) return null
  const [ent, gated, block] = await Promise.all([
    ctx.read(ctx.pad, GRAD_PAD_ABI, 'gradEntries', [token]), ctx.read(ctx.pad, GRAD_PAD_ABI, 'agentGateEnabled'), ctx.client.getBlock(),
  ])
  const u = (x) => units(ctx, quote, x)
  const [buyers, seqs, spent, valid] = ent
  const list = await Promise.all(buyers.map(async (b, i) => ({ buyer: b, seq: Number(seqs[i]), spent: await u(spent[i]), valid: valid[i], ...(me && b.toLowerCase() === me.toLowerCase() && { you: true }) })))
  const now = Number(block.timestamp)
  const state = Number(v.state)
  const refundAt = Number(v.refundAt)
  const claimable = me && state === 2 ? await ctx.read(ctx.pad, GRAD_PAD_ABI, 'gradClaimable', [token, me]) : 0n
  return {
    state: STATES[state] ?? String(state), pool: await u(v.pot), minBuy: await u(v.minBuy), entries: Number(v.entries), lastPct: pctOf(v.lastBps),
    ...(Number(v.carryBps) > 0 && { carryPct: pctOf(v.carryBps) }),
    ...(v.countdown !== '0x0000000000000000000000000000000000000000' && { countdown: v.countdown, restGoesTo: 'the token\'s countdown reward module (the rest after the claim window, or the whole payout if no entry is valid)' }),
    counted: Number(v.seq), gateOn: gated, list,
    createdAt: iso(v.createdAt), refundAskableAt: iso(Number(v.createdAt) + Number(v.refundAfter)),
    ...(refundAt > 0 && state === 1 && {
      refund: v.refundPending
        ? { requestedAt: iso(refundAt), takeableFrom: iso(refundAt + NOTICE_DAYS * 86400), lapsesAt: iso(refundAt + (NOTICE_DAYS + WINDOW_DAYS) * 86400), note: 'the creator asked for the pool back: if the token graduates before the creator takes it, the buyers are paid as usual' }
        : { lapsed: true, note: 'a refund request lapsed: the creator would have to ask again (a fresh 7-day notice)' },
    }),
    ...(state >= 2 && Number(v.gradAt) > 0 && { graduatedAt: iso(v.gradAt), sweepableAt: iso(Number(v.gradAt) + CLAIM_DAYS * 86400), claimed: await u(v.claimed) }),
    ...(v.carryOwed > 0n && { carryOwed: await u(v.carryOwed) }),
    ...(v.settled && { validEntries: Number(v.valid) }),
    ...(me && { wallet: me, ...(state === 2 && { claimable: await u(claimable) }) }),
    raw: { state, settled: v.settled, countdown: v.countdown, pot: v.pot, minBuy: v.minBuy, lastBps: Number(v.lastBps), refundAt, refundPending: v.refundPending, refundAfter: Number(v.refundAfter), createdAt: Number(v.createdAt), gradAt: Number(v.gradAt), carryOwed: v.carryOwed, claimable, now, gated, buyers, valid },
  }
}

/**
 * What a curve buy preview says about the reward: whether it would count, the pool, and what the list looks like.
 * `spent`: what the buy actually spends (fee included, after a cut); `graduates`: it is the graduating buy.
 */
export async function gradBuyLine(ctx, token, quote, sym, me, spent, graduates) {
  let g
  try { g = await gradOf(ctx, token, quote, me) } catch (e) {
    return { error: 'could not read the token\'s graduation reward (RPC error): whether this buy counts is unknown', detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' }
  }
  if (!g || g.raw.state !== 1) return null
  const counts = g.raw.gated && (spent >= g.raw.minBuy || graduates)
  const why = !g.raw.gated ? 'the Agent gate is off now: no buy counts'
    : counts ? (graduates ? 'this buy graduates the token: it counts, and gets the graduating buy\'s share on top' : `it spends at least the ${g.minBuy} ${sym} minimum`)
      : `it spends less than the ${g.minBuy} ${sym} minimum`
  const asOf = 'as the curve stands now: a buy landing first can change it (e.g. who graduates the token)'
  return {
    counts, why, asOf, pool: `${g.pool} ${sym}`, entries: g.entries, lastPct: g.lastPct, countedSoFar: g.counted,
    note: `${g.entries} entries share the pool at graduation by what each spent${g.lastPct > 0 ? `, the graduating buy ${g.lastPct}% on top` : ''}. Selling on the curve before graduation takes this wallet's entries out. ${RULE}`,
    ...(g.refund && { refund: g.refund }),
    more: `gang grad-reward status --token ${token}${ctx.chainId === '97' ? ' --testnet' : ''}`,
  }
}

/** What a curve sell preview warns about: the seller's valid entries it takes out (null: nothing to say). */
export async function gradSellLine(ctx, token, quote, sym, me) {
  let g
  try { g = await gradOf(ctx, token, quote, me) } catch (e) {
    return { warning: 'could not read the token\'s graduation reward (RPC error): if it has one, this sell takes out your entries in its list. Re-run before you sell to see them', detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' }
  }
  if (!g || g.raw.state !== 1) return null
  const mine = g.list.filter((x) => x.you && x.valid).length
  if (!mine) return null
  return { warning: `this sell takes out your ${mine} entr${mine === 1 ? 'y' : 'ies'} in the graduation reward list (pool ${g.pool} ${sym}): only a later buy of yours would count again`, entriesLost: mine }
}

function gradCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const CURVE_ABI = parseAbi(['function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function symbol() view returns (string)'])

const SUBS = ['status', 'claim', 'settle', 'sweep', 'retry-carry', 'refund-request', 'refund-cancel', 'refund']
const USAGE = 'usage: gang grad-reward <status|claim|settle|sweep|retry-carry|refund-request|refund-cancel|refund> --token <addr> [--testnet] [--calldata] [--from <addr>] — see gang help'
const FN = {
  claim: 'claimGradReward', settle: 'settleGradReward', sweep: 'sweepGradReward', 'retry-carry': 'retryCarry',
  'refund-request': 'requestGradRefund', 'refund-cancel': 'cancelGradRefund', refund: 'gradRefund',
}

/** `gang grad-reward <sub>`: a 3.0 curve token's graduation reward. */
export async function runGradReward(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  let ctx
  try { ctx = gradCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)
  const tn = testnet ? ' --testnet' : ''
  const token = opt('token')
  if (!isAddress(token ?? '')) return fail('--token must be a 3.0 curve token address (0x…)', { got: token ?? null })
  const kind = await atTokenPad(ctx, token)
  if (kind === null) return fail(KIND_UNREAD.error, { token, retry: KIND_UNREAD.retry })
  const gs = kind === 'gangswap' // a GangSwap curve token: the same reward, no carry
  if (kind !== 'v3' && !gs) return fail(`not a V3 curve token on a GangLaunchpad (${testnet ? 'BSC testnet' : 'BSC mainnet; add --testnet for a testnet token'})`, { token, chainId, ...(kind && kind !== 'none' && { kind }) })
  let creator, quote
  try { [creator, quote] = await ctx.read(ctx.pad, CURVE_ABI, 'curves', [token]) } catch (e) {
    return fail('could not read the token\'s curve (RPC error)', { token, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' })
  }
  const sym = await ctx.read(quote, CURVE_ABI, 'symbol').catch(() => 'quote')
  let me = null
  try { me = walletFor(ctx, opt('from')) } catch { /* status works without a wallet */ }
  let g
  try { g = await gradOf(ctx, token, quote, me) } catch (e) {
    return fail('could not read the token\'s graduation reward (RPC error)', { token, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' })
  }
  if (!g) return fail('this token has no graduation reward (it was not created with --grad-reward)', { token, pad: ctx.pad, padGen: ctx.gen, ...(gs && { kind }) })
  const { raw, ...shown } = g
  const isCreator = me && me.toLowerCase() === creator.toLowerCase()
  if (sub === 'status') {
    const next = raw.state === 2 && raw.claimable > 0n ? `gang grad-reward claim --token ${token}${tn}`
      : raw.state === 2 && raw.now >= raw.gradAt + CLAIM_DAYS * 86400 ? `gang grad-reward sweep --token ${token}${tn}`
        : raw.carryOwed > 0n ? `gang grad-reward retry-carry --token ${token}${tn}` : null
    return out({ success: true, chainId, token, ...(gs && { kind }), pad: ctx.pad, quote: sym, creator, ...shown, rule: RULE, ...(next && { next }) })
  }

  if (!me) return fail('no wallet: sign in to baw, or pass --from <addr> with --calldata')
  // what each write needs, said before the simulation (which says it too, with the pad's own error)
  const dest = raw.countdown && raw.countdown !== '0x0000000000000000000000000000000000000000' ? `the token's countdown reward module ${raw.countdown}` : `the creator ${creator}`
  const closed = raw.state === 4 ? 'the reward is closed: the claim window is over (or no entry was valid) and the rest was sent on'
    : raw.state === 3 ? 'the creator took the pool back (the token did not graduate in time): there is nothing to claim' : null
  const lapsesAt = raw.refundAt + (NOTICE_DAYS + WINDOW_DAYS) * 86400
  const need = {
    claim: () => closed ?? (raw.state !== 2 ? HINTS.NotGradState : raw.claimable === 0n ? 'nothing to claim for this wallet: it already claimed, or it has no valid entry in the list (not among the last buys counted, or it sold on the curve after its buys)' : null),
    settle: () => closed ?? (raw.state !== 2 ? HINTS.NotGradState : raw.settled ? 'already settled: the entries are counted (claims read them)' : null),
    sweep: () => closed ?? (raw.state !== 2 ? HINTS.NotGradState : raw.now < raw.gradAt + CLAIM_DAYS * 86400 ? HINTS.SweepNotDue : null),
    'retry-carry': () => (gs ? 'a GangSwap token has no countdown module: there is never a carry to resend' : raw.carryOwed === 0n ? HINTS.NoCarryOwed : null),
    'refund-request': () => (!isCreator ? 'only the token\'s creator may ask for the pool back' : raw.state !== 1 ? HINTS.NotGradState
      : raw.now < raw.createdAt + raw.refundAfter ? `too early: the pool can be asked back from ${g.refundAskableAt}` : raw.refundPending ? 'a refund request is already running' : null),
    'refund-cancel': () => (!isCreator ? 'only the token\'s creator may cancel its refund request' : !raw.refundPending ? 'no refund request is running' : null),
    refund: () => (!isCreator ? 'only the token\'s creator takes the pool back' : raw.state !== 1 ? HINTS.NotGradState
      : !raw.refundPending ? 'no running refund request: ask first (gang grad-reward refund-request), then wait the 7-day notice'
        : raw.now < raw.refundAt + NOTICE_DAYS * 86400 ? `the 7-day notice runs until ${iso(raw.refundAt + NOTICE_DAYS * 86400)}` : null),
  }[sub]()
  if (need) return fail(need, { token, state: g.state })
  const fn = FN[sub]
  try { await ctx.client.simulateContract({ account: me, address: ctx.pad, abi: GRAD_PAD_ABI, functionName: fn, args: [token] }) } catch (e) {
    const rv = revertOf(e)
    return out({ success: false, step: `grad-reward-${sub}`, ...(rv ? { reverted: true, ...rv } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] }) })
  }
  const data = encodeFunctionData({ abi: GRAD_PAD_ABI, functionName: fn, args: [token] })
  const note = {
    claim: `pays this wallet ${g.claimable} ${sym}: all its valid entries in the list, once`,
    settle: `counts the valid entries once (the first claim does this too); with none, the payout goes to ${dest}`,
    sweep: `closes the reward: the unclaimed rest goes to ${dest}; no claim after this`,
    'retry-carry': `sends the owed ${g.carryOwed} ${sym} to the countdown reward module again`,
    'refund-request': `starts a public ${NOTICE_DAYS}-day notice: a graduation in that time pays the buyers as usual. Then you have ${WINDOW_DAYS} days to take the pool (gang grad-reward refund), else the request lapses`,
    'refund-cancel': 'cancels the running refund request: the reward stays as it is',
    refund: `takes the whole pool (${g.pool} ${sym}) back to you and ends the reward for good: a later graduation pays nobody. Send it before ${iso(lapsesAt)}: the request lapses then, and the tx would revert`,
  }[sub]
  return out(step(ctx, { from: me, to: ctx.pad, data }, {
    step: `grad-reward-${sub}`, chainId, token, ...(gs && { kind }), quote: sym, pool: g.pool, ...(sub === 'claim' && { amount: g.claimable }), ...(sub === 'refund' && { lapsesAt: iso(lapsesAt) }), note,
  }, flag('calldata'), summarize))
}

