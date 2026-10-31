import { createPublicClient, parseAbi, encodeFunctionData, formatUnits, hexToString, isAddress, maxUint128, zeroAddress } from 'viem'
import { atPad, atTokenPad, GANG_GENS, KIND_UNREAD, gangGens, listedBy, padNets, NOT_ON_MAINNET, rpcTransport } from './gangpad.js'
import { notListed, splitPlan, sweepAsset, sweepPlan, sweepReads } from './buyback.js'
import { walletFor } from './fair.js'
import { parseNum, revertOf as revertIn, step } from './steps.js'

/**
 * `gang lp …` and `gang create … --lp <pct> [--lp-to <addr>]` — GangLiquiditySplitter (dev 税按比例自动加池子,
 * `lp-burn-v1`): a V3 token's tax recipient that splits each payment between liquidity added to the token's PancakeSwap
 * pair, its LP sent to 0xdead (locked for good, like the graduation LP), and the dev's payee (the dev unless it names
 * another address; `gang lp set-payee`). The buy-back splitter's sibling (GangBuybackSplitter v4): the same split, ratio
 * rules, payee and pace; only the chunk differs. GangLiquiditySplitterFactory clones one per token for the dev
 * (`create(bps, salt, payee)`, at `predict(dev, salt)`) and has GangHandlerAdmin list it, so the dev names it as the
 * recipient at create (launch.js does the three steps: clone → create → bind, as for --buyback).
 * The ratio: a raise applies at once, a cut 3 days after it is asked for (then anyone applies it within 7 days, or it
 * lapses). The keeper adds liquidity in chunks (`work`: one per 4 minutes, ≤ 0.5% of the pair's quote reserve, none
 * while the price is > 2% above the pair's 10-minute average): half buys the token, all of it goes back into the pair
 * with the matching quote, and the pair mints the LP to 0xdead. Both pool taxes apply, so part of the other half stays
 * for the next chunk.
 * Gas: a chunk takes ~0.53–0.75M (the deposit lets the tax handler sell a chunk of its tax first). The CLI never sets a
 * gas limit: the wallet / node estimates it; a fixed or trimmed limit can revert.
 * Env: GANG_LP_FACTORY / GANG_TESTNET_LP_FACTORY override the create target's factory (gangpad.js).
 */

// one factory per GangLaunchpad generation (it is bound to one pad): the create target's (GANG_GENS in gangpad.js)
export const MAINNET_LP_FACTORY = GANG_GENS.mainnet[0].lpFactory
export const TESTNET_LP_FACTORY = GANG_GENS.testnet[0].lpFactory
export const LP_TYPE = 'lp-burn-v1'
const BPS = 10_000n
const CHUNK_GAP_S = 4 * 60

const ERRORS = [
  'error ZeroAddress()', 'error NotClone()', 'error NotFactory()', 'error AlreadyInitialized()', 'error BadBps()',
  'error NotDev()', 'error AlreadyBound()', 'error NotBound()', 'error NotCurve()', 'error NotCreator()',
  'error NotRecipient()', 'error NoProposal()', 'error NotDue()', 'error CutLapsed()', 'error NothingOwed()',
  'error NothingToAdd()', 'error AddTooSoon()', 'error NotTradable()', 'error Slippage()', 'error NotSweepable()',
  'error BadPayee()',
]

export const LP_FACTORY_ABI = parseAbi([
  'function create(uint16 lpBps, bytes32 salt, address payee) returns (address splitter)',
  'function predict(address dev, bytes32 salt) view returns (address)',
  'function pad() view returns (address)',
  'error NotAgent()', 'error WrongHandler()',
  'event Created(address indexed dev, address indexed splitter, uint16 lpBps, address payee)',
  ...ERRORS,
])

export const LP_ABI = parseAbi([
  'function moduleType() view returns (bytes32)',
  'function dev() view returns (address)',
  'function payee() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function lpBps() view returns (uint16)',
  'function pendingCut() view returns (bool live, uint16 bps, uint64 at)',
  'function lpLeft() view returns (uint256)',
  'function unsplit() view returns (uint256)',
  'function devOwed() view returns (uint256)',
  'function lastAddAt() view returns (uint64)',
  'function previewAdd() view returns (bool ready, uint256 chunk, uint256 tokensOut)',
  'function previewWork() view returns (bool due, uint256 minOut)',
  'function bind(address token)',
  'function setLpBps(uint16 newBps)',
  'function applyLpBps()',
  'function setPayee(address newPayee)',
  'function split()',
  'function pad() view returns (address)',
  'function releaseDev() returns (uint256)',
  'function addChunk(uint256 minTokensOut) returns (uint256 quoteIn, uint256 tokensIn, uint256 liquidity)',
  'function work(uint256 minOut)',
  'function sweep(address asset)',
  'event Bound(address indexed token, address indexed quote)',
  'event Split(uint256 incoming, uint256 toLp, uint256 toDev)',
  'event DevOwed(uint256 amount)',
  'event DevReleased(uint256 amount)',
  'event Shortfall(uint256 amount)',
  'event LpBpsSet(uint16 oldBps, uint16 newBps)',
  'event LpBpsProposed(uint16 newBps, uint64 at)',
  'event LpBpsProposalCancelled(uint16 newBps)',
  'event LiquidityAdded(uint256 quoteIn, uint256 tokensIn, uint256 liquidity, uint256 left)',
  'event Swept(address indexed asset, uint256 amount)',
  'event PayeeSet(address indexed oldPayee, address indexed newPayee)',
  ...ERRORS,
])
/** gang tx decodes these (the factory's Created and the splitter's events). */
export const LP_EVENT_ABIS = [LP_FACTORY_ABI, LP_ABI]

const ERC20_ABI = parseAbi(['function symbol() view returns (string)'])
const PAD_ABI = parseAbi([
  'function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)',
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
])

export const LP_GAS_NOTE = 'let the wallet estimate the gas limit and do not set or trim it: a chunk takes about 0.53–0.75M gas (the deposit lets the tax handler sell a chunk of its tax first); too low a limit reverts'

export const HINTS = {
  NotAgent: 'only an Agent can create a V3 token, so only an Agent gets an LP splitter',
  NotFactory: 'this LP factory is not allowed on the platform\'s GangHandlerAdmin: it cannot list an LP splitter as a tax recipient. If GANG_LP_FACTORY / GANG_TESTNET_LP_FACTORY is set, unset it to use the built-in factory; otherwise launch without --lp',
  BadBps: 'the LP share is 0–100%',
  BadPayee: 'the payee cannot be the LP splitter itself',
  ZeroAddress: 'the zero address cannot be the payee',
  NotDev: 'only the dev this LP splitter was made for can change its ratio or payee',
  NotCreator: 'the token was not created by this LP splitter\'s dev',
  NotRecipient: 'the token does not pay its tax to this LP splitter',
  NotCurve: 'not a V3 (curve) token on this pad',
  AlreadyBound: 'the LP splitter is bound to a token already',
  NotBound: 'the LP splitter is not bound to a token yet (gang lp bind --token <the token>)',
  NotDue: 'the 3-day notice of this cut has not run yet',
  CutLapsed: 'the cut was not applied within 7 days after its notice and has lapsed: ask for it again',
  NoProposal: 'no cut asked for',
  NothingOwed: 'nothing is owed to the payee',
  NothingToAdd: 'no quote is set aside for the pool yet (lpLeft 0): it fills as the tax arrives',
  AddTooSoon: 'one chunk per 4 minutes: wait until 4 minutes after the last one (lastAddAt)',
  NotTradable: 'the token has not graduated: chunks start once it trades in its PancakeSwap pair',
  Slippage: 'the pool price moved since the preview (fewer tokens than the minimum): run gang lp add again',
}
export const revertOf = (e) => revertIn(e, [LP_ABI, LP_FACTORY_ABI], HINTS)

/** Dry-run a call; { failed } with the revert when it would not pass. */
export async function simulateLp(client, from, address, abi, functionName, args = []) {
  try {
    const { result } = await client.simulateContract({ account: from, address, abi, functionName, args })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

export function lpFactoryAddress(testnet) {
  return gangGens(testnet)[0].lpFactory || null
}

export const lpNotDeployed = (testnet) =>
  `GangLiquiditySplitterFactory is not deployed on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} in this CLI version: set ${testnet ? 'GANG_TESTNET_LP_FACTORY' : 'GANG_LP_FACTORY'} to its address`

/** --lp <pct> / --pct (0–100, the share of the recipient's part added to the pool) in bps. */
export const lpBpsOf = (fail, raw, name = 'lp') => Math.round(parseNum(fail, name, raw, 0, 100) * 100)

const pct = (bps) => Number(bps) / 100
const iso = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null)
// the pad takes 18-decimal quotes only
const q = (x) => formatUnits(x, 18)

/**
 * The splitter's state for printing, from the raw reads (pure: unit-tested). `raw`: { splitter, dev, payee, token, quote,
 * bps, cut: [live, bps, at], left, unsplit, owed, lastAddAt, preview: [ready, chunk, tokensOut] | null,
 * work: [due, minOut] | null, graduated: bool | null, quoteSymbol, now (unix s) }.
 */
export function formatLp(raw) {
  const token = raw.token && raw.token !== zeroAddress ? raw.token : null
  const quote = token && raw.quote && raw.quote !== zeroAddress ? raw.quote : null
  const toDev = String(raw.payee).toLowerCase() === String(raw.dev).toLowerCase()
  const bps = Number(raw.bps)
  const [live, cutBps, cutAt] = raw.cut ?? [false, 0, 0n]
  const [ready, chunk, tokensOut] = raw.preview ?? [false, 0n, 0n]
  const last = Number(raw.lastAddAt ?? 0n)
  const now = Number(raw.now ?? Math.floor(Date.now() / 1000))
  // what lpLeft is once the waiting quote is split (as the contract's _lpAfterSplit, without a shortfall)
  const setAside = BigInt(raw.left) + (BigInt(raw.unsplit) * BigInt(bps)) / BPS
  let waiting = null
  if (!ready) {
    waiting = !token ? 'not bound to a token yet (gang lp bind --token <the token>)'
      : raw.graduated === false ? 'the token has not graduated: chunks start once it trades in its PancakeSwap pair (the pool tax starts then too)'
        : setAside === 0n ? 'nothing set aside for the pool yet: it fills as the tax arrives'
          : last > 0 && now < last + CHUNK_GAP_S ? `one chunk per 4 minutes: the next from ${iso(last + CHUNK_GAP_S)}`
            : 'the price check: a 10-minute average of the pair\'s price (the next call records it, if none is running) and a price no more than 2% above it'
  }
  return {
    splitter: raw.splitter, moduleType: LP_TYPE, dev: raw.dev, payee: raw.payee, token, quote, ...(quote && raw.quoteSymbol && { quoteSymbol: raw.quoteSymbol }),
    lpPct: pct(bps), lpBps: bps,
    pendingCut: live ? { toPct: pct(cutBps), appliesFrom: iso(cutAt), lapsesAfter: iso(Number(cutAt) + 7 * 86400) } : null,
    lpLeft: q(raw.left), unsplit: q(raw.unsplit), devOwed: q(raw.owed),
    lastAddAt: iso(last),
    nextChunk: ready ? { quoteChunk: q(chunk), buyHalf: q(chunk / 2n), tokensBought: formatUnits(tokensOut, 18) } : null,
    ...(waiting && { nextChunkWaitsFor: waiting }),
    ...(raw.work && token && { keeper: { due: !!raw.work[0] } }),
    note: `${pct(bps)}% of each tax payment to this recipient is added to the token's PancakeSwap pair as liquidity whose LP goes to 0xdead (locked for good), the rest goes to ${toDev ? 'the dev' : `the payee ${raw.payee}`}. `
      + 'The keeper adds it in chunks (one per 4 minutes, at most 0.5% of the pair\'s quote reserve, none while the price is more than 2% above its 10-minute average; it waits until at least 0.05% of that reserve is set aside): half buys the token, all of it goes back into the pair with the matching quote. Both pool taxes apply, so part of each chunk\'s quote stays for the next. '
      + 'A raise of the share applies at once, a cut only 3 days after it is asked for; the dev can change the payee at once (gang lp set-payee)',
  }
}

/** The splitter's state when `addr` is a GangLiquiditySplitter (lp-burn-v1); null when it is not. `pad`: to read graduation. */
export async function lpOf(read, addr, { pad } = {}) {
  if (!addr || addr === zeroAddress) return null
  let type
  try { type = await read(addr, LP_ABI, 'moduleType') } catch { return null }
  if (hexToString(type, { size: 32 }).replace(/\0+$/, '') !== LP_TYPE) return null
  const [dev, payee, token, quote, bps, cut, left, unsplit, owed, lastAddAt] = await Promise.all(
    ['dev', 'payee', 'token', 'quote', 'lpBps', 'pendingCut', 'lpLeft', 'unsplit', 'devOwed', 'lastAddAt'].map((f) => read(addr, LP_ABI, f)))
  const bound = token !== zeroAddress
  const [preview, work, graduated, quoteSymbol] = await Promise.all([
    bound ? read(addr, LP_ABI, 'previewAdd').catch(() => null) : null,
    bound ? read(addr, LP_ABI, 'previewWork').catch(() => null) : null,
    bound && pad ? read(pad, PAD_ABI, 'curves', [token]).then((c) => c[6]).catch(() => null) : null,
    bound ? read(quote, ERC20_ABI, 'symbol').catch(() => null) : null,
  ])
  return formatLp({ splitter: addr, dev, payee, token, quote, bps, cut, left, unsplit, owed, lastAddAt, preview, work, graduated, quoteSymbol })
}

function lpCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const SUBS = ['status', 'set', 'set-payee', 'apply', 'bind', 'release', 'split', 'sweep', 'add']
const USAGE = 'usage: gang lp <status|set|set-payee|apply|bind|release|split|sweep|add> --token <addr> (split / sweep: or --module <addr>) [--pct <0-100>] [--to <addr>] [--asset <addr>|wbnb] [--slippage 1] [--testnet] — see gang help'

/** `gang lp <sub>`: the LP splitter of a V3 token (its tax recipient), found from --token. */
export async function runLp(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const rawOnly = flag('calldata')
  let ctx
  try { ctx = lpCtx(testnet) } catch (e) { return fail(e.message) }
  // split / sweep may name the splitter itself (--module), e.g. the --to of a creator-fee claim
  const named = (sub === 'split' || sub === 'sweep') && flag('module')
  if (named && flag('token')) fail('give --token (its tax recipient is the splitter) or --module, not both')
  let token = opt('token')
  const chainId = Number(ctx.chainId)
  let recipient
  if (named) {
    recipient = opt('module')
    if (!isAddress(recipient ?? '')) fail('--module must be an LP splitter address (0x…)', { got: recipient ?? null })
    const pad = await ctx.read(recipient, LP_ABI, 'pad').catch(() => null)
    if (!pad || !atPad(ctx, pad, testnet)) return fail(notListed('LP splitter', testnet), { module: recipient })
  } else {
    if (!isAddress(token ?? '')) fail('--token must be a V3 token address (0x…)', { got: token ?? null })
    if ((await atTokenPad(ctx, token)) === null) return fail(KIND_UNREAD.error, { token: token, retry: KIND_UNREAD.retry }) // else on the pad of the token's generation
    try { recipient = (await ctx.read(ctx.pad, PAD_ABI, 'taxConfigOf', [token]))[3] } catch {
      return fail(`not a V3 token on this pad (${testnet ? 'BSC testnet' : 'BSC mainnet; add --testnet for a testnet token'})`, { token, chainId })
    }
  }
  const s = await lpOf(ctx.read, recipient, { pad: ctx.pad })
  if (!s) {
    return fail(named ? 'not an LP splitter (lp-burn-v1)' : 'this token\'s tax recipient is not an LP splitter (lp-burn-v1)',
      named ? { module: recipient } : { token, recipient: recipient === zeroAddress ? null : recipient })
  }
  if (named) token = s.token
  const tn = testnet ? ' --testnet' : ''
  // the token pays this splitter, which is bound to another token: it adds liquidity only to that one's pair
  const warning = s.token && s.token.toLowerCase() !== token.toLowerCase()
    ? `this token pays its tax to the LP splitter, but it is bound to another token (${s.token}): the liquidity goes to that token's pair` : null
  const me = () => walletFor(ctx, opt('from'))
  const send = async (functionName, args, extra) => {
    const sim = await simulateLp(ctx.client, me(), s.splitter, LP_ABI, functionName, args)
    if (sim.failed) return out({ success: false, step: extra.step, ...sim.failed })
    const data = encodeFunctionData({ abi: LP_ABI, functionName, args })
    // no gas field: the wallet / node estimates it (LP_GAS_NOTE)
    return out(step(ctx, { from: me(), to: s.splitter, data }, { chainId, token, splitter: s.splitter, ...extra }, rawOnly, summarize))
  }

  if (sub === 'status') return out({ success: true, chainId, ...s, ...(s.token === null && { bound: false }), ...(warning && { warning }) })

  if (sub === 'bind') {
    if (s.token) return fail('already bound', { boundTo: s.token, ...(warning && { warning }) })
    return send('bind', [token], { step: 'bind', note: 'anyone may bind (once); the token must be the dev\'s and pay its tax to this splitter. Its pair is where the liquidity goes' })
  }

  if (sub === 'set') {
    if (me().toLowerCase() !== s.dev.toLowerCase()) return fail(HINTS.NotDev, { wallet: me(), dev: s.dev })
    if (!flag('pct')) fail('--pct <0-100> required: the new LP share')
    const bps = lpBpsOf(fail, opt('pct'), 'pct')
    return send('setLpBps', [bps], bps >= s.lpBps
      ? { step: 'set-lp', fromPct: s.lpPct, toPct: bps / 100, note: `applies at once (quote that arrived before is split at the old share first)${s.pendingCut ? ' and cancels the pending cut' : ''}` }
      : {
          step: 'ask-cut', fromPct: s.lpPct, toPct: bps / 100, appliesFromAbout: new Date(Date.now() + 3 * 86400_000).toISOString(),
          note: `a cut waits 3 days (holders see it coming), then anyone runs gang lp apply --token ${token}${tn} within 7 days or it lapses${s.pendingCut ? '; this replaces the cut already asked for' : ''}`,
        })
  }

  if (sub === 'set-payee') {
    if (me().toLowerCase() !== s.dev.toLowerCase()) return fail('only the dev this LP splitter was made for can change its payee', { wallet: me(), dev: s.dev })
    const to = opt('to')
    if (!isAddress(to ?? '') || to === zeroAddress) fail('--to <0x…> required (checksummed or all lowercase): the address the dev\'s part goes to from now on', { got: to ?? null })
    if (to.toLowerCase() === s.splitter.toLowerCase()) return fail(HINTS.BadPayee, { to })
    if (to.toLowerCase() === s.payee.toLowerCase()) return fail('that is the payee already', { payee: s.payee })
    return send('setPayee', [to], {
      step: 'set-payee', fromPayee: s.payee, toPayee: to,
      note: 'applies at once (the dev\'s own share; holders are not affected). Quote that arrived before is split to the current payee first; what is owed goes to the new one',
    })
  }

  if (sub === 'apply') {
    if (!s.pendingCut) return fail(HINTS.NoProposal, { lpPct: s.lpPct })
    if (Date.parse(s.pendingCut.appliesFrom) > Date.now()) return fail(HINTS.NotDue, { appliesFrom: s.pendingCut.appliesFrom })
    return send('applyLpBps', [], { step: 'apply-cut', fromPct: s.lpPct, toPct: s.pendingCut.toPct, note: 'anyone may apply a cut once its notice ran' })
  }

  if (sub === 'split') {
    if (!(await listedBy(ctx, s.splitter))) return fail(notListed('LP splitter', testnet), { module: s.splitter })
    const [waiting, left] = await Promise.all(['unsplit', 'lpLeft'].map((f) => ctx.read(s.splitter, LP_ABI, f)))
    const plan = splitPlan({ unsplit: waiting, bps: s.lpBps, left, payee: s.payee, part: 'liquidity', leftField: 'lpLeft', symbol: s.quoteSymbol ?? null, unbound: !s.token })
    if (plan.error) return fail(plan.error, { splitter: s.splitter, lpLeft: s.lpLeft, devOwed: s.devOwed })
    return send('split', [], {
      step: 'split', ...plan,
      note: `anyone may: splits what arrived since the last split. ${plan.toPayee} goes to the payee now (should that push fail, it is owed: gang lp release --token ${s.token}${tn}); ${plan.setAside} (${s.lpPct}%) is set aside for the pool, which the keeper adds in chunks once the token trades in its pair (each chunk splits first too, so after graduation this runs by itself)`,
    })
  }

  if (sub === 'sweep') {
    if (!(await listedBy(ctx, s.splitter))) return fail(notListed('LP splitter', testnet), { module: s.splitter })
    const asset = sweepAsset(opt, fail, ctx.wbnb)
    const plan = sweepPlan({ asset, ...(await sweepReads(ctx.read, s.splitter, LP_ABI, asset)), payee: s.payee, cmd: 'gang lp' })
    if (plan.error) return fail(plan.error, { splitter: s.splitter, asset })
    return send('sweep', [asset], {
      step: 'sweep', ...plan,
      note: 'anyone may: sends the splitter\'s whole balance of this asset (not its own quote; e.g. a creator fee or another token\'s tax in another quote) to the payee; none of it goes into the pool',
    })
  }

  if (sub === 'release') {
    if (!(Number(s.devOwed) > 0)) return fail(HINTS.NothingOwed)
    return send('releaseDev', [], { step: 'release', amount: s.devOwed, payee: s.payee, note: 'anyone may; the payee gets what a failed push left owed' })
  }

  // add: one chunk by hand (anyone), as the keeper's work does
  if (!s.token) return fail(HINTS.NotBound, { splitter: s.splitter })
  const slippage = parseNum(fail, 'slippage', opt('slippage', '1'), 0, 50)
  const [ready, chunk, tokensOut] = await ctx.read(s.splitter, LP_ABI, 'previewAdd')
  if (ready) {
    // previewAdd prices the buy half after the buy tax; the contract scales the minimum down when the pair got less
    const minOut = (tokensOut * BigInt(Math.round((100 - slippage) * 100))) / BPS
    return send('addChunk', [minOut], {
      step: 'add', quoteChunk: q(chunk), buyHalf: q(chunk / 2n), expectTokensBought: formatUnits(tokensOut, 18),
      minTokensBought: formatUnits(minOut, 18), slippagePct: slippage, lpLeft: s.lpLeft,
      note: `anyone may: splits what arrived, then half of the chunk buys the token, all of it goes back into the pair with the matching quote, and the pair mints the LP to 0xdead (gang tx shows LiquidityAdded). The keeper does the same every few minutes. Gas: ${LP_GAS_NOTE}`,
    })
  }
  // not ready: only a call that records the price observation can pass; a minimum no chunk can meet makes it revert
  // (Slippage) rather than buy unchecked if a chunk became possible before it lands
  const sim = await simulateLp(ctx.client, me(), s.splitter, LP_ABI, 'addChunk', [maxUint128])
  if (sim.failed) return out({ success: false, step: 'add', ...sim.failed, ...(s.nextChunkWaitsFor && { waitsFor: s.nextChunkWaitsFor }), lpLeft: s.lpLeft })
  return send('addChunk', [maxUint128], {
    step: 'record-price', addsLiquidity: false, waitsFor: s.nextChunkWaitsFor,
    note: 'no chunk this time: the call only records the pair\'s price observation (or waits for the 10-minute average / a price no more than 2% above it). It is cheap; the keeper calls it too. If a chunk becomes possible before it lands, it reverts (Slippage) rather than add without a minimum: run gang lp add again then, about 10 minutes after the first observation',
  })
}
