import { createPublicClient, parseAbi, encodeFunctionData, decodeEventLog, formatUnits, parseUnits, isAddress, zeroAddress } from 'viem'
import { decimalsOf, fundingStep as fund, parseAmount, parseIntIn, parseNum, revertOf as revertIn, step, units, GAS_RESERVE } from './steps.js'
import { atTokenPad, GANG_GENS, gangGens, KIND_UNREAD, MERGED_ERRORS_ABI, MERGED_HINTS, NOT_ON_MAINNET, padNets, rpcTransport } from './gangpad.js'
import { bawAddress } from './baw.js'

/**
 * `gang bond …` — GangBond (Agent 押金承诺, gang-launchpad src/gang/GangBond.sol): a creator of a GangLaunchpad token
 * posts a bond in the token's quote and promises its creating address holds at least X tokens. It can be posted any
 * time after create (on the curve / during the 打新 sale too) and binds from then; T is `duration` after the token
 * reaches its PancakeSwap pair (graduation / launch; `start` sets it). Below X, anyone can report it: the reporter gets
 * 1%, the rest buys the token back from its pair in small chunks and burns it. Settle (after T, balance still ≥ X)
 * returns the whole bond to the creator; refund does the same when the pair never came within 30 days of the post.
 * One contract per network, no owner; it only reads the pad.
 *
 * One GangBond per GangLaunchpad generation (it reads one pad): a token's bond is on its own generation's GangBond.
 * Env: GANG_BOND (mainnet), GANG_TESTNET_BOND (testnet) override the create target's (gangpad.js).
 */

// script/DeployGangBond.s.sol, once per generation: the create target's (GANG_GENS in gangpad.js has each one's history)
export const MAINNET_BOND = GANG_GENS.mainnet[0].bond
export const TESTNET_BOND = GANG_GENS.testnet[0].bond

export const BOND_ABI = parseAbi([
  'function post(address token, uint256 amount, uint256 holdAmount, uint64 duration) payable',
  'function topUp(address token, uint256 amount) payable',
  'function raiseHold(address token, uint256 newHoldAmount)',
  'function extend(address token, uint64 by)',
  'function start(address token)',
  'function report(address token)',
  'function requestSettle(address token)',
  'function settle(address token)',
  'function requestRefund(address token)',
  'function refund(address token)',
  'function burnChunk(address token, uint256 minTokensOut) returns (uint256 quoteIn, uint256 burned)',
  'function bondOf(address token) view returns ((address creator, uint64 postedAt, uint32 round, address quote, uint8 state, uint64 deadline, uint64 duration, uint64 requestAt, uint128 amount, uint128 holdAmount, uint128 burnLeft))',
  'function isViolated(address token) view returns (bool)',
  'function isLive(address token) view returns (bool)',
  'function dumpValue(address token) view returns (uint256)',
  'function coverageBps(address token) view returns (uint256)',
  'function historyOf(address creator) view returns (uint32 posted, uint32 honored, uint32 slashed)',
  'function quoteDump(address token, uint256 holdAmount) view returns (uint256)',
  'function previewBurn(address token) view returns (bool ready, uint256 quoteIn, uint256 tokensOut)',
  'function MIN_DURATION() view returns (uint64)', 'function MAX_DURATION() view returns (uint64)',
  'function REPORTER_BPS() view returns (uint256)', 'function MAX_WAIT() view returns (uint64)', 'function REFUND_NOTICE() view returns (uint64)',
  'function SETTLE_DELAY() view returns (uint64)', 'function CHUNK_GAP() view returns (uint64)',
  'event BondPosted(address indexed token, address indexed creator, uint32 round, address quote, uint256 amount, uint256 holdAmount, uint64 duration, uint64 deadline)',
  'event BondStarted(address indexed token, uint32 round, uint64 deadline)',
  'event BondToppedUp(address indexed token, uint32 round, uint256 added, uint256 amount)',
  'event HoldRaised(address indexed token, uint32 round, uint256 holdAmount)',
  'event BondExtended(address indexed token, uint32 round, uint64 duration, uint64 deadline)',
  'event BondReported(address indexed token, uint32 round, address indexed reporter, uint256 balance, uint256 reward, uint256 burnLeft)',
  'event SettleRequested(address indexed token, uint32 round, uint64 settleAt)',
  'event BondSettled(address indexed token, uint32 round, address indexed creator, uint256 amount)',
  'event RefundRequested(address indexed token, uint32 round, uint64 refundAt)',
  'event BondRefunded(address indexed token, uint32 round, address indexed creator, uint256 amount)',
  'event BondBurned(address indexed token, uint32 round, uint256 quoteIn, uint256 tokensBurned, uint256 burnLeft)',
  'error ZeroAddress()', 'error UnknownToken()', 'error NotTradable()', 'error NotCreator()', 'error BondLive()',
  'error NotActive()', 'error ZeroAmount()', 'error BadDuration()', 'error BadHold()', 'error BadValue()',
  'error FeeOnTransferQuote()', 'error NotViolated()', 'error Violated()', 'error NotDue()', 'error NothingToBurn()',
  'error BurnTooSoon()', 'error Slippage()', 'error FlashSwapActive()', 'error AlreadyLive()', 'error AlreadyRequested()', 'error NoRefundRequest()',
  'error NoSettleRequest()',
  'error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)', 'error SafeERC20FailedOperation(address token)',
])

const PAD_ABI = parseAbi([
  'function kindOf(address token) view returns (uint8)',
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function sales(address token) view returns (address creator, uint64 progressAt, uint16 capShares, uint16 holdBps, address quote, uint16 sold, bool launched, uint16 mintFeeBps, uint16 exitFeeBps, address gate, uint128 sharePrice, address pair, address refPool, uint16 markSold)',
])
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'])

const HINTS = {
  NotTradable: 'this needs the token on its PancakeSwap pair (V3 graduated / 打新 launched), and it is not there yet',
  UnknownToken: 'not a GangLaunchpad token (V3 or 打新): bonds cover only those',
  NotCreator: 'only the token\'s creator (curves / sales creator) can post, top up, raise X or extend',
  BondLive: 'this token already has a bond in force (active, or slashed with buy-back still running): one at a time',
  NotActive: 'no active bond on this token (none posted, already settled, refunded or slashed)',
  BadDuration: '--days must be 7–90 (extend: before the pair at most 90 days in all, after it a deadline at most 90 days from now)',
  BadHold: '--hold must be above 0 and at most the creator\'s balance now (raise-hold: not below the current X)',
  BadValue: 'native BNB only for a WBNB-quoted token, exactly the bond amount',
  FeeOnTransferQuote: 'the quote takes a fee on transfer: it cannot be used for a bond',
  NotViolated: 'the creator still holds at least X: nothing to report',
  Violated: 'the creator holds less than X: the bond cannot be settled or refunded, only reported',
  NoSettleRequest: 'ask to settle first (gang bond settle asks; it runs 1 hour later)',
  AlreadyLive: 'the token reached its pair: the bond runs (gang bond start) instead of being refunded',
  AlreadyRequested: 'already requested: a refund runs once its 3-day notice is over, a settle 1 hour after its request',
  NoRefundRequest: 'request the refund first (gang bond refund asks for it; it runs 3 days later)',
  NotDue: 'not due yet: the deadline, the refund notice or the 1-hour settle wait has not passed',
  NothingToBurn: 'no slashed bond with buy-back left on this token',
  BurnTooSoon: 'a chunk was bought for this token less than 4 minutes ago: one chunk per 4 minutes',
  Slippage: 'the buy-back would burn fewer tokens than the minimum: the price moved, re-run',
  FlashSwapActive: 'the token\'s pair is mid flash swap: settle cannot count tokens borrowed from it; send it in its own tx',
}

const STATES = ['none', 'active', 'slashed', 'settled', 'refunded']
const MAX_WAIT = 30 * 86_400 // GangBond.MAX_WAIT
const REFUND_NOTICE = 3 * 86_400 // GangBond.REFUND_NOTICE
const SETTLE_DELAY = 3_600 // GangBond.SETTLE_DELAY
const BPS = 10_000n
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n
const DAY = 86_400
const MAX_UINT = 2n ** 256n - 1n

/** GangBond of the create target on `testnet` / mainnet (env first); null when not deployed there. */
export function bondAddress(testnet) {
  return gangGens(testnet)[0].bond || null
}

function bondCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  // a token's bond is its own generation's (set after atTokenPad); the create target may have none yet
  const bond = bondAddress(testnet)
  if (!net.gens.some((g) => g.bond)) throw new Error(`GangBond is not deployed on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} in this CLI version: set ${testnet ? 'GANG_TESTNET_BOND' : 'GANG_BOND'} to its address`)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, bond, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

/** --from, else the signed-in Agentic Wallet (as gang v3 / gang fair). */
const walletFor = (ctx, from) => {
  if (from) return from
  try { return bawAddress(ctx.chainId) } catch { return bawAddress('56') }
}

const revertOf = (e) => revertIn(e, [BOND_ABI, MERGED_ERRORS_ABI], { ...MERGED_HINTS, ...HINTS })

async function simulate(ctx, from, functionName, args, value = 0n) {
  try {
    const { result } = await ctx.client.simulateContract({ account: from, address: ctx.bond, abi: BOND_ABI, functionName, args, value })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

/** The token as the pad has it: kind, creator, quote, pair and whether it trades on PancakeSwap yet. null when not the pad's. */
async function marketOf(ctx, token) {
  const kind = Number(await ctx.read(ctx.pad, PAD_ABI, 'kindOf', [token]))
  if (kind === 1) {
    const [creator, quote, , , , , graduated, , , , pair] = await ctx.read(ctx.pad, PAD_ABI, 'curves', [token])
    return { kind: 'v3', creator, quote, pair, live: graduated }
  }
  if (kind === 2) {
    const s = await ctx.read(ctx.pad, PAD_ABI, 'sales', [token])
    return { kind: 'fair', creator: s[0], quote: s[4], pair: s[11], live: s[6] }
  }
  return null
}

const symbolOf = async (ctx, token) => { try { return await ctx.read(token, ERC20_ABI, 'symbol') } catch { return null } }
const pctOfBps = (bps) => Number(bps) / 100
const tokens = (x) => formatUnits(x, 18)
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const ceilDiv = (a, b) => (a + b - 1n) / b

/** Coverage tier (bps): ≥ 100% full cover, 50–100% bond, below 50% none. gang.fun colours a tier only for an
 *  allow-listed quote and an X of at least half the creator's balance; every other active bond gets a gray badge. */
const tierOf = (bps) => (bps >= BPS ? 'full' : bps >= 5_000n ? 'bond' : 'none')
const TIER_NOTE = { full: '押金全覆盖: dumping X now loses money (bond ≥ what the sale fetches)', bond: '押金: bond covers 50–100% of what dumping X fetches', none: 'below 50% coverage: a plain gray 押金 badge on gang.fun (bond and coverage still shown)' }

async function nowOf(ctx) {
  return Number((await ctx.client.getBlock()).timestamp)
}

/** The bond and everything around it, formatted; raw fields kept under `_raw` for the commands. */
async function bondView(ctx, token, m) {
  const b = await ctx.read(ctx.bond, BOND_ABI, 'bondOf', [token])
  const state = STATES[Number(b.state)] ?? String(b.state)
  const quote = b.quote === zeroAddress ? m.quote : b.quote
  const [dec, sym, now] = await Promise.all([decimalsOf(ctx, quote), symbolOf(ctx, quote), nowOf(ctx)])
  const q = (x) => formatUnits(x, dec)
  const creator = b.creator === zeroAddress ? m.creator : b.creator
  const [bal, history] = await Promise.all([
    ctx.read(token, ERC20_ABI, 'balanceOf', [creator]),
    ctx.read(ctx.bond, BOND_ABI, 'historyOf', [creator]),
  ])
  const v = {
    token, kind: m.kind, creator, state, round: Number(b.round), quote: sym || quote,
    creatorHistory: { posted: Number(history[0]), honored: Number(history[1]), slashed: Number(history[2]) },
  }
  const pending = state === 'active' && b.deadline === 0n
  const raw = { bond: b, bal, quote, dec, now, pending, live: m.live }
  if (state === 'none') return { ...v, _raw: raw }
  const days = (sec) => Math.round((Number(sec) / DAY) * 10) / 10
  Object.assign(v, {
    bond: q(b.amount), holdTokens: tokens(b.holdAmount), holdPctOfSupply: Number((b.holdAmount * 1_000_000n) / TOTAL_SUPPLY) / 10_000,
    creatorBalance: tokens(bal), headroomTokens: bal >= b.holdAmount ? tokens(bal - b.holdAmount) : `-${tokens(b.holdAmount - bal)}`,
    postedAt: new Date(Number(b.postedAt) * 1000).toISOString(), durationDays: days(b.duration),
    deadline: b.deadline === 0n ? null : new Date(Number(b.deadline) * 1000).toISOString(),
  })
  if (state === 'active') {
    const violated = await ctx.read(ctx.bond, BOND_ABI, 'isViolated', [token])
    const violatedNote = violated && { note: `the creator holds less than X: anyone can report it (gang bond report --token ${token}) and take 1% of the bond` }
    if (pending) {
      // posted before the pair: the promise binds now, the clock starts when the token reaches its pair
      const refundAt = Number(b.postedAt) + MAX_WAIT
      Object.assign(v, {
        phase: 'pending', violated, live: m.live,
        clock: `starts when the token ${m.kind === 'v3' ? 'graduates' : 'launches'}: deadline = that moment + ${days(b.duration)} days`,
        ...(m.live
          ? { note: `the token is on its pair: anyone can start the clock (gang bond start --token ${token}); any other bond write starts it too` }
          : { refundRequestFrom: new Date(refundAt * 1000).toISOString(), coverageNote: 'no coverage before the pair: shown once it trades on PancakeSwap' }),
        ...(b.requestAt !== 0n && !m.live && {
          refundRequested: true, refundRunsAt: new Date(Number(b.requestAt) * 1000).toISOString(),
          refundNote: 'the creator asked for the bond back: it can be withdrawn from refundRunsAt if the token still has no pair; the promise binds until then, and graduation / launch cancels the request',
        }),
        ...violatedNote,
        ...(!violated && !m.live && raw.now >= refundAt && b.requestAt === 0n && { note: `no pair within 30 days of the post and X is held: the creator can ask for the bond back (gang bond refund --token ${token}); it runs 3 days later` }),
      })
      return { ...v, _raw: raw }
    }
    const [dump, cov] = await Promise.all([
      ctx.read(ctx.bond, BOND_ABI, 'dumpValue', [token]),
      ctx.read(ctx.bond, BOND_ABI, 'coverageBps', [token]),
    ])
    const left = Number(b.deadline) - now
    const settleAt = Number(b.requestAt)
    Object.assign(v, {
      phase: 'running', violated, dumpValue: q(dump), coveragePct: cov === MAX_UINT ? null : pctOfBps(cov), tier: tierOf(cov), tierNote: TIER_NOTE[tierOf(cov)],
      toFullCover: dump > b.amount ? q(dump - b.amount) : '0',
      ...(left > 0 ? { secondsLeft: left, daysLeft: Math.round((left / DAY) * 10) / 10 } : { pastDeadline: true }),
      ...violatedNote,
      ...(settleAt !== 0 && { settleRequested: true, settleRunsAt: new Date(settleAt * 1000).toISOString() }),
      ...(!violated && left <= 0 && {
        note: settleAt === 0
          ? `past the deadline and X is held: anyone can settle it in two steps (gang bond settle --token ${token} asks; run it again 1 hour later and the bond goes back to the creator). X must still be held then; until then it can be reported if the balance drops below X`
          : now < settleAt
            ? `settle asked for: it runs from settleRunsAt if X is still held then; until then it can be reported if the balance drops below X`
            : `settle is due: gang bond settle --token ${token} returns the bond to the creator (X must still be held)`,
      }),
    })
    Object.assign(raw, { dump, cov })
  }
  if (state === 'slashed') {
    const [ready, quoteIn, tokensOut] = await ctx.read(ctx.bond, BOND_ABI, 'previewBurn', [token])
    Object.assign(v, {
      burnLeft: q(b.burnLeft), burnDone: b.burnLeft === 0n,
      ...(b.burnLeft > 0n && !m.live && {
        nextChunk: ready ? { quoteToDead: q(quoteIn) } : null,
        nextChunkNote: ready
          ? 'slashed before the pair and still no pair 30 days after the post: gang bond burn --token … sends the rest to 0xdead as quote'
          : `slashed before the pair: the buy-back starts once the token ${m.kind === 'v3' ? 'graduates' : 'launches'}; if it has not by ${new Date((Number(b.postedAt) + MAX_WAIT) * 1000).toISOString()}, the rest goes to 0xdead as quote`,
      }),
      ...(b.burnLeft > 0n && m.live && { nextChunk: ready ? { quoteIn: q(quoteIn), tokensOut: tokens(tokensOut) } : null, nextChunkNote: ready ? 'gang bond burn --token … buys this chunk now' : 'not ready: the first call after a slash records a price observation, then the buy-back waits 10 minutes and skips while the price is more than 2% above its average (after 20 minutes without a call it starts over); at most one chunk per 4 minutes' }),
    })
  }
  return { ...v, _raw: raw }
}

/** --hold: a token amount, or N% of the total supply (1,000,000,000). */
function parseHold(fail, raw) {
  const s = String(raw ?? '').trim()
  if (s.endsWith('%')) {
    const n = Number(s.slice(0, -1))
    if (!(n > 0 && n <= 100)) fail('--hold as a percentage must be above 0 and at most 100 (of the total supply)', { got: raw ?? null })
    return (TOTAL_SUPPLY * BigInt(Math.round(n * 10_000))) / 1_000_000n
  }
  return parseUnits(parseAmount(fail, 'hold', raw), 18)
}

const tokenArg = (opt, fail) => {
  const v = opt('token')
  if (!isAddress(v ?? '')) fail('--token must be a GangLaunchpad token address (0x…)', { got: v ?? null })
  return v
}

/** The pay side of post / topUp: BNB for a WBNB quote (value; --use-wbnb pays WBNB), otherwise approve to GangBond first. */
async function payment(ctx, me, quote, amount, sym, useWbnb, rawOnly, summarize) {
  if (same(quote, ctx.wbnb) && !useWbnb) {
    const native = await ctx.client.getBalance({ address: me })
    if (native < amount + GAS_RESERVE) {
      return { pre: { success: false, error: 'not enough BNB for this bond (native BNB must also cover gas)', haveBnb: formatUnits(native, 18), needBnb: formatUnits(amount, 18), reserveForGas: formatUnits(GAS_RESERVE, 18), hint: 'add --use-wbnb to pay from WBNB instead' } }
    }
    return { value: amount }
  }
  const pre = await fund(ctx, { me, token: quote, need: amount, spender: ctx.bond, sym, approveStep: 'approve-quote' }, rawOnly, summarize)
  return pre ? { pre } : { value: 0n }
}

const CLI_ONLY = 'the CLI refuses sells that would break the bond (gang v3 sell / gang fair sell), but a sell on the PancakeSwap site or another wallet is not stopped: it breaks the bond and anyone can report it'

// notes and follows are for trades and creates (gang.fun matches them to those txs); a bond tx carries none
const NOTE_FLAGS = ['note', 'conf', 'reveal-after', 'follow']

const SUBS = ['post', 'topup', 'raise-hold', 'extend', 'status', 'start', 'report', 'settle', 'refund', 'burn', 'tx']
const USAGE = 'usage: gang bond <post|topup|raise-hold|extend|status|start|report|settle|refund|burn|tx> --token <addr> [--testnet] — see gang help'

/** Entry for `gang bond <sub>`. io: { opt, flag, out, fail, summarize } from index.js. */
export async function runBond(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const noteFlag = NOTE_FLAGS.find((f) => flag(f))
  if (noteFlag) return fail(`--${noteFlag}: gang bond takes no notes or follows (they go on trades and creates); leave it out`)
  const testnet = flag('testnet')
  const net = testnet ? ' --testnet' : ''
  const rawOnly = flag('calldata')
  let ctx
  try { ctx = bondCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)

  if (sub === 'tx') {
    const hash = opt('hash')
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) fail('--hash must be a tx hash')
    const r = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    const events = []
    for (const log of r.logs) {
      // any generation's GangBond (a token's bond is on its own generation's)
      if (!ctx.gens.some((g) => same(log.address, g.bond))) continue
      try {
        const ev = decodeEventLog({ abi: BOND_ABI, data: log.data, topics: log.topics })
        events.push({ event: ev.eventName, ...Object.fromEntries(Object.entries(ev.args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) })
      } catch { /* not a bond event */ }
    }
    return out({ success: true, chainId, hash, status: r.status, block: Number(r.blockNumber), events, explorer: `${ctx.explorer}/tx/${hash}` })
  }

  const token = tokenArg(opt, fail)
  // the token's generation: its pad and its GangBond
  if ((await atTokenPad(ctx, token)) === null) return fail(KIND_UNREAD.error, { token: token, retry: KIND_UNREAD.retry })
  if (!ctx.bond) return fail('this token\'s GangLaunchpad generation has no GangBond in this CLI version', { token, chainId, padGen: ctx.gen })
  const m = await marketOf(ctx, token)
  if (!m) return fail('not a GangLaunchpad token (V3 or 打新) on this network: bonds cover only those', { token, chainId })
  const view = await bondView(ctx, token, m)
  const { _raw: raw, ...pub } = view
  const b = raw.bond
  const qf = (x) => formatUnits(x, raw.dec)
  let wallet = null
  const me = () => (wallet ??= walletFor(ctx, opt('from')))
  const send = (functionName, args, extra, value = 0n) =>
    step(ctx, { from: me(), to: ctx.bond, data: encodeFunctionData({ abi: BOND_ABI, functionName, args }), value }, { chainId, token, bondContract: ctx.bond, ...extra }, rawOnly, summarize)

  if (sub === 'status') {
    // no bond yet on a token before its pair: say a bond can be posted now (the view's own notes win otherwise)
    const before = view.state === 'none' && !m.live
      && { note: `the token is not on PancakeSwap yet (${m.kind === 'v3' ? 'not graduated' : 'not launched'}): its creator can post a bond now; the --days clock starts when it ${m.kind === 'v3' ? 'graduates' : 'launches'}` }
    return out({ success: true, chainId, bondContract: ctx.bond, ...pub, ...before })
  }

  if (sub === 'report') {
    if (view.state !== 'active') return fail(HINTS.NotActive, { ...pub })
    if (!view.violated) return fail(HINTS.NotViolated, { creatorBalance: view.creatorBalance, holdTokens: view.holdTokens })
    const sim = await simulate(ctx, me(), 'report', [token])
    if (sim.failed) return out({ success: false, step: 'report', ...sim.failed })
    const self = same(me(), b.creator)
    const rewardBps = await ctx.read(ctx.bond, BOND_ABI, 'REPORTER_BPS')
    const reward = self ? 0n : (b.amount * rewardBps) / BPS
    return out(send('report', [token], {
      step: 'report', creator: b.creator, creatorBalance: view.creatorBalance, holdTokens: view.holdTokens, bond: view.bond, quote: view.quote,
      reward: qf(reward), rewardPct: self ? 0 : pctOfBps(rewardBps), burnAfter: qf(b.amount - reward),
      note: self ? 'the creator reporting itself gets no reward: the whole bond goes to buy-back' : `you get ${pctOfBps(rewardBps)}% of the bond; the rest buys the token back from its pair in chunks and burns it (gang bond burn)`,
    }))
  }

  if (sub === 'start') {
    if (view.state !== 'active') return fail(HINTS.NotActive, { ...pub })
    if (!raw.pending) return fail('the clock is already running', { deadline: view.deadline })
    if (!m.live) return fail(`the token has not ${m.kind === 'v3' ? 'graduated' : 'launched'} yet: the clock starts when it reaches its pair`, { refundRequestFrom: view.refundRequestFrom })
    const sim = await simulate(ctx, me(), 'start', [token])
    if (sim.failed) return out({ success: false, step: 'start', ...sim.failed })
    return out(send('start', [token], {
      step: 'start', durationDays: view.durationDays, deadlineAbout: new Date((raw.now + Number(b.duration)) * 1000).toISOString(),
      note: 'anyone may start it; the deadline is the block this lands in + the duration',
    }))
  }

  if (sub === 'refund') {
    // creator only, two steps: request (30 days without a pair since the post), then refund after a 3-day notice
    if (view.state !== 'active') return fail(HINTS.NotActive, { ...pub })
    if (!same(me(), b.creator)) return fail('only the creator can ask for its bond back', { wallet: me(), creator: b.creator })
    if (!raw.pending || m.live) return fail(HINTS.AlreadyLive, { deadline: view.deadline })
    if (view.violated) return fail(HINTS.Violated, { creatorBalance: view.creatorBalance, holdTokens: view.holdTokens })
    if (b.requestAt === 0n) {
      const requestAt = Number(b.postedAt) + MAX_WAIT
      if (raw.now < requestAt) return fail('a refund can be asked for only 30 days after the post without a pair', { refundRequestFrom: view.refundRequestFrom, secondsLeft: requestAt - raw.now })
      const sim = await simulate(ctx, me(), 'requestRefund', [token])
      if (sim.failed) return out({ success: false, step: 'request-refund', ...sim.failed })
      return out(send('requestRefund', [token], {
        step: 'request-refund', bond: view.bond, quote: view.quote, refundRunsAbout: new Date((raw.now + REFUND_NOTICE) * 1000).toISOString(),
        note: 'step 1 of 2: starts a 3-day notice (shown on gang.fun). Keep holding X: a breach can still be reported, and if the token graduates / launches meanwhile the request is void and the clock starts. Then run gang bond refund again',
      }))
    }
    if (raw.now < Number(b.requestAt)) return fail('the refund notice is not over yet', { refundRunsAt: view.refundRunsAt, secondsLeft: Number(b.requestAt) - raw.now })
    const sim = await simulate(ctx, me(), 'refund', [token])
    if (sim.failed) return out({ success: false, step: 'refund', ...sim.failed })
    return out(send('refund', [token], { step: 'refund', refund: view.bond, quote: view.quote, note: 'step 2 of 2: no pair after the notice, X held: the bond comes back to you (not counted as honored)' }))
  }

  if (sub === 'settle') {
    if (view.state !== 'active') return fail(HINTS.NotActive, { ...pub })
    if (raw.pending) {
      return fail(m.live ? 'the clock has not started: settle comes duration days after it' : 'the token is not on its pair yet: settle comes after graduation / launch + the duration', {
        durationDays: view.durationDays, hint: m.live ? `gang bond start --token ${token}${net}` : `if there is still no pair 30 days after the post, the creator can ask for the bond back: gang bond refund --token ${token}${net} (it runs 3 days later)`,
      })
    }
    if (raw.now < Number(b.deadline)) return fail(HINTS.NotDue, { deadline: view.deadline, secondsLeft: Number(b.deadline) - raw.now })
    if (view.violated) return fail(HINTS.Violated, { creatorBalance: view.creatorBalance, holdTokens: view.holdTokens, hint: `gang bond report --token ${token}${net}` })
    // two steps, anyone: ask (X held now), then settle 1 hour later (X held again) — so X can't be met for one tx only
    if (b.requestAt === 0n) {
      const sim = await simulate(ctx, me(), 'requestSettle', [token])
      if (sim.failed) return out({ success: false, step: 'request-settle', ...sim.failed })
      return out(send('requestSettle', [token], {
        step: 'request-settle', creator: b.creator, bond: view.bond, quote: view.quote, settleRunsAbout: new Date((raw.now + SETTLE_DELAY) * 1000).toISOString(),
        note: 'step 1 of 2: the bond can be settled 1 hour after this lands, if the creator still holds X then; until then a drop below X can be reported. Then run gang bond settle again',
      }))
    }
    if (raw.now < Number(b.requestAt)) return fail('the settle wait is not over yet', { settleRunsAt: view.settleRunsAt, secondsLeft: Number(b.requestAt) - raw.now })
    const sim = await simulate(ctx, me(), 'settle', [token])
    if (sim.failed) return out({ success: false, step: 'settle', ...sim.failed })
    return out(send('settle', [token], { step: 'settle', creator: b.creator, refund: view.bond, quote: view.quote, note: 'step 2 of 2: the bond goes back to the creator, whoever sends this' }))
  }

  if (sub === 'burn') {
    if (view.state !== 'slashed' || b.burnLeft === 0n) return fail(HINTS.NothingToBurn, { state: view.state, ...(view.burnLeft && { burnLeft: view.burnLeft }) })
    const slippage = parseNum(fail, 'slippage', opt('slippage', '1'), 0, 50)
    const [ready, quoteIn, tokensOut] = await ctx.read(ctx.bond, BOND_ABI, 'previewBurn', [token])
    // not ready: the call only records / waits. If a chunk has become buyable by the time it lands, the max minimum
    // makes it revert (Slippage) instead of buying unchecked: re-run for a priced preview
    const toDead = ready && !m.live
    // the minimum comes from the chunk simulated with no minimum: previewBurn prices the whole quoteIn, so a quote that
    // taxes transfers into the pair (fewer tokens bought) would fail every minimum taken from it
    let expect = tokensOut
    if (ready && !toDead) {
      const dry = await simulate(ctx, me(), 'burnChunk', [token, 0n])
      if (dry.result) expect = dry.result[1]
    }
    const minOut = toDead ? 0n : ready ? (expect * BigInt(Math.round((100 - slippage) * 100))) / BPS : MAX_UINT
    const sim = await simulate(ctx, me(), 'burnChunk', [token, minOut])
    if (sim.failed) return out({ success: false, step: 'burn', ...sim.failed })
    return out(send('burnChunk', [token, minOut], {
      step: 'burn', burnLeft: view.burnLeft, quote: view.quote,
      ...(toDead ? { quoteToDead: qf(quoteIn), note: 'slashed before the pair and still no pair 30 days after the post: the rest goes to 0xdead as quote' }
        : ready ? { chunkQuoteIn: qf(quoteIn), expectBurnTokens: tokens(expect), minBurnTokens: tokens(minOut), slippagePct: slippage }
        : { note: 'no chunk this time: the call records the price observation (first call after a slash) or waits for the 10-minute average / a price no more than 2% above it. It is cheap; the platform keeper also calls it every 5 minutes (one chunk per 4 minutes at most). If a chunk becomes buyable before it lands, it reverts (Slippage) rather than buy without a minimum: re-run then' }),
    }))
  }

  // creator commands (any time after create: on the curve / during the sale too)
  if (!same(me(), m.creator)) return fail(HINTS.NotCreator, { wallet: me(), creator: m.creator })

  if (sub === 'post') {
    if (view.state === 'active' || (view.state === 'slashed' && b.burnLeft > 0n)) return fail(HINTS.BondLive, { ...pub })
    if (!flag('hold')) fail('--hold <tokens or N% of supply> required: the creator\'s balance must stay at least this until the deadline')
    if (flag('amount') === flag('cover')) fail('pass exactly one of --amount <quote> or --cover <coverage %> (e.g. --cover 100 for full cover)')
    const hold = parseHold(fail, opt('hold'))
    const days = parseIntIn(fail, 'days', opt('days'), 7, 90)
    if (hold === 0n) fail('--hold rounds to 0 tokens')
    if (hold > raw.bal) {
      fail('--hold is above the creator\'s balance now', {
        hold: tokens(hold), balance: tokens(raw.bal), ...(!m.live && m.kind === 'v3' && raw.bal === 0n && { hint: `buy on the curve first (gang v3 buy --token ${token}${net}), then bond what you hold` }),
      })
    }
    if (flag('cover') && !m.live) fail('--cover needs the PancakeSwap pair to price X: before graduation / launch give --amount <quote>')
    const dump = m.live ? await ctx.read(ctx.bond, BOND_ABI, 'quoteDump', [token, hold]) : null
    const amount = flag('amount') ? parseUnits(parseAmount(fail, 'amount', opt('amount')), raw.dec)
      : ceilDiv(dump * BigInt(Math.round(parseNum(fail, 'cover', opt('cover'), 1, 1000) * 100)), BPS)
    if (amount === 0n) fail('the bond rounds to 0')
    const duration = BigInt(days * DAY)
    const pay = await payment(ctx, me(), raw.quote, amount, view.quote, flag('use-wbnb'), rawOnly, summarize)
    if (pay.pre) return out(pay.pre)
    const sim = await simulate(ctx, me(), 'post', [token, amount, hold, duration], pay.value)
    if (sim.failed) return out({ success: false, step: 'post', ...sim.failed })
    const cov = !dump ? null : (amount * BPS) / dump
    const until = m.live ? 'the deadline' : `${days} days after the token ${m.kind === 'v3' ? 'graduates' : 'launches'}`
    return out(send('post', [token, amount, hold, duration], {
      step: 'post', bond: qf(amount), quote: view.quote, payWith: pay.value ? 'BNB' : view.quote,
      holdTokens: tokens(hold), holdPctOfSupply: Number((hold * 1_000_000n) / TOTAL_SUPPLY) / 10_000, creatorBalance: tokens(raw.bal), days,
      ...(m.live
        ? {
            deadlineAbout: new Date((raw.now + days * DAY) * 1000).toISOString(),
            dumpValue: qf(dump), coveragePct: cov == null ? null : pctOfBps(cov), tier: cov == null ? 'full' : tierOf(cov),
            toFullCover: dump > amount ? qf(dump - amount) : '0',
          }
        : {
            clock: `starts when the token ${m.kind === 'v3' ? 'graduates' : 'launches'}: deadline = that moment + ${days} days`,
            refundRequestFrom: new Date((raw.now + MAX_WAIT) * 1000).toISOString(),
            coverageNote: 'no coverage before the pair: gang.fun shows the bond amount and X until it trades on PancakeSwap',
          }),
      warning: `from now until settled after ${until}, keep at least ${tokens(hold)} tokens in ${m.creator}: below that anyone can report it, the reporter takes 1% and the rest of the bond buys back and burns the token.`
        + (m.live ? ' There is no early withdrawal.' : ' There is no early withdrawal; only if the token has no pair 30 days after this post can you ask for it back, and it comes back 3 days after asking if the token still has no pair and X is still held.')
        + ` ${CLI_ONLY}`,
    }, pay.value))
  }

  if (view.state !== 'active') return fail(HINTS.NotActive, { ...pub })

  if (sub === 'topup') {
    if (flag('amount') === flag('cover')) fail('pass exactly one of --amount <quote> or --cover <target coverage %>')
    let amount
    if (flag('amount')) amount = parseUnits(parseAmount(fail, 'amount', opt('amount')), raw.dec)
    else {
      if (raw.pending) fail('--cover needs the clock running on the PancakeSwap pair: give --amount <quote>', { phase: 'pending' })
      const target = ceilDiv(raw.dump * BigInt(Math.round(parseNum(fail, 'cover', opt('cover'), 1, 1000) * 100)), BPS)
      if (target <= b.amount) return fail(`the bond already covers ${view.coveragePct}%: nothing to add for --cover ${opt('cover')}`, { bond: view.bond, dumpValue: view.dumpValue })
      amount = target - b.amount
    }
    const pay = await payment(ctx, me(), raw.quote, amount, view.quote, flag('use-wbnb'), rawOnly, summarize)
    if (pay.pre) return out(pay.pre)
    const sim = await simulate(ctx, me(), 'topUp', [token, amount], pay.value)
    if (sim.failed) return out({ success: false, step: 'topup', ...sim.failed })
    const total = b.amount + amount
    const cov = !raw.dump ? null : (total * BPS) / raw.dump
    return out(send('topUp', [token, amount], {
      step: 'topup', add: qf(amount), bondAfter: qf(total), quote: view.quote, payWith: pay.value ? 'BNB' : view.quote,
      dumpValue: view.dumpValue, coveragePct: cov == null ? null : pctOfBps(cov), tier: cov == null ? 'full' : tierOf(cov), deadline: view.deadline,
      note: 'a bond can only grow: nothing comes back before settle',
    }, pay.value))
  }

  if (sub === 'raise-hold') {
    if (!flag('hold')) fail('--hold <tokens or N% of supply> required')
    const hold = parseHold(fail, opt('hold'))
    if (hold < b.holdAmount) fail('--hold is below the current X: X can only go up', { holdTokens: view.holdTokens })
    if (hold > raw.bal) fail('--hold is above the creator\'s balance now', { balance: view.creatorBalance })
    const sim = await simulate(ctx, me(), 'raiseHold', [token, hold])
    if (sim.failed) return out({ success: false, step: 'raise-hold', ...sim.failed })
    const dump = m.live ? await ctx.read(ctx.bond, BOND_ABI, 'quoteDump', [token, hold]) : null
    const cov = !dump ? null : (b.amount * BPS) / dump
    return out(send('raiseHold', [token, hold], {
      step: 'raise-hold', holdBefore: view.holdTokens, holdAfter: tokens(hold), creatorBalance: view.creatorBalance,
      ...(dump != null && { dumpValueAfter: qf(dump), coveragePctAfter: cov == null ? null : pctOfBps(cov) }), deadline: view.deadline,
      note: 'X can only go up; a higher X means dumping it fetches more, so the same bond covers less',
    }))
  }

  if (sub === 'extend') {
    const days = parseIntIn(fail, 'days', opt('days'), 1, 90)
    const by = BigInt(days * DAY)
    if (raw.pending) {
      // before the pair: the duration grows (90 days in all at most)
      if (Number(b.duration) + days * DAY > 90 * DAY) fail('the commitment would be more than 90 days in all', { durationDays: view.durationDays, maxDays: Math.floor((90 * DAY - Number(b.duration)) / DAY) })
    } else if (Number(b.deadline) + days * DAY > raw.now + 90 * DAY) {
      fail('the new deadline would be more than 90 days from now', { deadline: view.deadline, maxDays: Math.floor((raw.now + 90 * DAY - Number(b.deadline)) / DAY) })
    }
    const sim = await simulate(ctx, me(), 'extend', [token, by])
    if (sim.failed) return out({ success: false, step: 'extend', ...sim.failed })
    return out(send('extend', [token, by], {
      step: 'extend', days,
      ...(raw.pending
        ? { durationDaysBefore: view.durationDays, durationDaysAfter: view.durationDays + days, clock: 'starts at graduation / launch' }
        : { deadlineBefore: view.deadline, deadlineAfter: new Date((Number(b.deadline) + days * DAY) * 1000).toISOString(), coveragePct: view.coveragePct }),
    }))
  }

  return fail(USAGE, { got: sub })
}

/**
 * Sell protection for the creator's own sells: gang v3 sell (curve or pool), gang fair sell (pool), gang fair withdraw
 * (shares back to the pad while minting). `p`: { token, me, amount,
 * breakBond, settleFirst, testnet }. Returns null when there is nothing to guard (no GangBond on this network, no active
 * bond, not the creator), else one of:
 * - { refuse: {…} } — the sell would leave less than X before the deadline (no --break-bond), or after the deadline
 *   before settle (no --settle-first): print it as the failure;
 * - { settleStep: {…} } — --settle-first after the deadline: send this step first (ask to settle, or settle once the
 *   1-hour wait is over), then re-run the sell;
 * - { info: {…} } — go on, with these fields added to the preview (headroom after the sell, or the --break-bond warning).
 */
export async function bondGuard(ctx, p, rawOnly, summarize) {
  // the token's generation's GangBond when ctx is on its pad (atTokenPad), else the create target's
  const addr = 'bond' in ctx ? ctx.bond : bondAddress(p.testnet)
  if (!addr) return null
  let b
  try { b = await ctx.read(addr, BOND_ABI, 'bondOf', [p.token]) } catch (e) {
    // never let an unread bond pass a sell that may break it
    if (p.breakBond) return null
    return { refuse: { error: 'cannot read this token\'s GangBond, so the sell is not checked against a bond', bondContract: addr, detail: e.shortMessage || e.message.split('\n')[0], hint: 're-run; --break-bond skips the check' } }
  }
  if (Number(b.state) !== 1 || !same(b.creator, p.me)) return null
  let bal, block, dec
  try {
    ;[bal, block, dec] = await Promise.all([ctx.read(p.token, ERC20_ABI, 'balanceOf', [p.me]), ctx.client.getBlock(), decimalsOf(ctx, b.quote)])
  } catch (e) {
    if (p.breakBond) return null
    return { refuse: { error: 'RPC error while checking the sell against your bond', bondContract: addr, detail: e.shortMessage || e.message.split('\n')[0], hint: 're-run; set GANG_RPC_URL / GANG_TESTNET_RPC_URL if the RPC keeps failing' } }
  }
  const after = bal > p.amount ? bal - p.amount : 0n
  // pending (deadline 0, posted before the pair): the promise binds, nothing is past due
  const pastDeadline = b.deadline !== 0n && Number(block.timestamp) >= Number(b.deadline)
  const base = {
    bondContract: addr, holdTokens: tokens(b.holdAmount), balanceBefore: tokens(bal), balanceAfter: tokens(after),
    bond: formatUnits(b.amount, dec),
    ...(b.deadline === 0n ? { clock: 'starts at graduation / launch' } : { deadline: new Date(Number(b.deadline) * 1000).toISOString() }),
  }
  if (after >= b.holdAmount) {
    return { info: { bondCheck: { ...base, headroomAfter: tokens(after - b.holdAmount), ...(pastDeadline && { note: 'past the deadline: settle the bond (gang bond settle) to get it back; until then it can still be reported if the balance drops below X' }) } } }
  }
  const net = p.testnet ? ' --testnet' : ''
  if (pastDeadline && bal >= b.holdAmount) {
    if (!p.settleFirst) {
      return { refuse: { error: `the bond is past its deadline but not settled: this sell leaves ${tokens(after)} tokens, below X (${tokens(b.holdAmount)}), and anyone could report it before you settle`, ...base, hint: `run gang bond settle --token ${p.token}${net} first (two steps, 1 hour apart), or add --settle-first to this sell` } }
    }
    const now = Number(block.timestamp)
    if (b.requestAt !== 0n && now < Number(b.requestAt)) {
      return { refuse: { error: 'settle is asked for but its 1-hour wait is not over: keep X until it runs, then settle and sell', ...base, settleRunsAt: new Date(Number(b.requestAt) * 1000).toISOString(), secondsLeft: Number(b.requestAt) - now } }
    }
    const fn = b.requestAt === 0n ? 'requestSettle' : 'settle'
    const data = encodeFunctionData({ abi: BOND_ABI, functionName: fn, args: [p.token] })
    const note = fn === 'requestSettle'
      ? 'ask to settle first (step 1 of 2): 1 hour after it lands, settle (the bond comes back to you) and then sell; keep X until then'
      : 'settle first (the bond comes back to you); after executing, re-run the same sell'
    return { settleStep: step(ctx, { from: p.me, to: addr, data }, { step: fn === 'requestSettle' ? 'request-settle' : 'settle', chainId: Number(ctx.chainId), token: p.token, refund: base.bond, ...base, note }, rawOnly, summarize) }
  }
  const lost = formatUnits(b.amount, dec)
  const consequence = `anyone can report it, the reporter takes 1% and the rest of the ${lost} bond buys back and burns the token`
  const warning = bal < b.holdAmount
    ? `the bond is already broken: you hold ${tokens(bal)} tokens, below the bonded X (${tokens(b.holdAmount)}), so ${consequence}. Selling more does not change that; buying back to X before anyone reports does`
    : `this sell leaves ${tokens(after)} tokens, below the bonded X (${tokens(b.holdAmount)}) before the bond is settled: ${consequence}. You lose the whole bond`
  if (!p.breakBond) return { refuse: { error: warning, ...base, maxSellKeepingBond: tokens(bal > b.holdAmount ? bal - b.holdAmount : 0n), hint: 'sell at most maxSellKeepingBond, or add --break-bond once the user accepts losing the bond' } }
  return { info: { bondCheck: { ...base, warning, brokeBond: true } } }
}
