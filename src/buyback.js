import { createPublicClient, parseAbi, encodeFunctionData, formatUnits, hexToString, isAddress, zeroAddress } from 'viem'
import { atPad, atTokenPad, GANG_GENS, KIND_UNREAD, gangGens, listedBy, padNets, NOT_ON_MAINNET, rpcTransport } from './gangpad.js'
import { walletFor } from './fair.js'
import { parseNum, revertOf as revertIn, step } from './steps.js'

/**
 * `gang buyback …` and `gang create … --buyback <pct> [--buyback-to <addr>]` — GangBuybackSplitter (dev 税按比例回购
 * 销毁): a V3 token's tax recipient that splits each payment between a buy-back in the token's PancakeSwap pool, sent to
 * 0xdead, and the dev's payee (the dev unless it names another address; v2 splitters only, `gang buyback set-payee`).
 * GangBuybackSplitterFactory clones one per token for the dev (`create(bps, salt, payee)`, at `predict(dev, salt)`) and has
 * GangHandlerAdmin list it, so the dev names it as the recipient at create (launch.js does the three steps: clone →
 * create → bind). A dev who doesn't
 * want it leaves --buyback out: the tax goes to their own address as before.
 * The ratio: a raise applies at once, a cut 3 days after it is asked for (then anyone applies it within 7 days, or it
 * lapses). The keeper buys back in chunks (≤ 0.5% of the pool's quote side, never > 2% above the 10-minute average).
 * Env: GANG_SPLITTER_FACTORY / GANG_TESTNET_SPLITTER_FACTORY override the create target's factory (gangpad.js).
 */

// one factory per GangLaunchpad generation (it is bound to one pad): the create target's (GANG_GENS in gangpad.js)
export const MAINNET_SPLITTER_FACTORY = GANG_GENS.mainnet[0].splitterFactory
export const TESTNET_SPLITTER_FACTORY = GANG_GENS.testnet[0].splitterFactory
/** The factories' clones; v1 (mainnet's first factory, 0x6bcd…8546) pays the dev, v2 and later their payee; v3 buys at
 *  most one chunk per 4 minutes (GangBond audit H-1); v4 (GangLaunchpad 2.0's factory) prices a chunk on what the pair
 *  received (re-review L-1). Same calls from v2 on. */
const BUYBACK_TYPES = ['buyback-burn-v1', 'buyback-burn-v2', 'buyback-burn-v3', 'buyback-burn-v4']

export const FACTORY_ABI = parseAbi([
  'function create(uint16 buybackBps, bytes32 salt, address payee) returns (address splitter)',
  'function predict(address dev, bytes32 salt) view returns (address)',
  'function pad() view returns (address)',
  'error NotAgent()',
  'error NotFactory()',
  'error BadBps()',
])

export const SPLITTER_ABI = parseAbi([
  'function moduleType() view returns (bytes32)',
  'function dev() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function buybackBps() view returns (uint16)',
  'function pendingCut() view returns (bool live, uint16 bps, uint64 at)',
  'function buybackLeft() view returns (uint256)',
  'function unsplit() view returns (uint256)',
  'function devOwed() view returns (uint256)',
  'function previewBurn() view returns (bool ready, uint256 quoteIn, uint256 tokensOut)',
  'function bind(address token)',
  'function setBuybackBps(uint16 newBps)',
  'function applyBuybackBps()',
  'function releaseDev() returns (uint256)',
  'function split()',
  'function sweep(address asset)',
  'function pad() view returns (address)',
  'function payee() view returns (address)',
  'function setPayee(address newPayee)',
  'error NotDev()',
  'error BadBps()',
  'error AlreadyBound()',
  'error NotCurve()',
  'error NotCreator()',
  'error NotRecipient()',
  'error NoProposal()',
  'error NotDue()',
  'error CutLapsed()',
  'error NothingOwed()',
  'error NotBound()',
  'error NotSweepable()',
])

const PAD_ABI = parseAbi([
  'function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)',
])

const HINTS = {
  NotAgent: 'only an Agent can create a V3 token, so only an Agent gets a buy-back splitter',
  NotFactory: 'this factory is not allowed on the platform\'s GangHandlerAdmin (any more): it cannot list a splitter',
  NotDev: 'only the dev this splitter was made for can change its ratio',
  NotCreator: 'the token was not created by this splitter\'s dev',
  NotRecipient: 'the token does not pay its tax to this splitter',
  AlreadyBound: 'the splitter is bound to a token already',
  NotDue: 'the 3-day notice of this cut has not run yet',
  CutLapsed: 'the cut was not applied within 7 days after its notice and has lapsed: ask for it again',
  NoProposal: 'no cut asked for',
  NothingOwed: 'nothing is owed to the dev',
  NotBound: 'the splitter is not bound to a token yet',
  NotSweepable: 'sweep never moves the splitter\'s own quote: gang buyback split splits it',
}
const revertOf = (e) => revertIn(e, [SPLITTER_ABI, FACTORY_ABI], HINTS)

export function splitterFactoryAddress(testnet) {
  return gangGens(testnet)[0].splitterFactory || null
}

export const notDeployed = (testnet) =>
  `GangBuybackSplitterFactory is not deployed on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} in this CLI version: set ${testnet ? 'GANG_TESTNET_SPLITTER_FACTORY' : 'GANG_SPLITTER_FACTORY'} to its address`

/** --buyback <pct> (0–100, the share of the recipient's part bought back) in bps. */
export const buybackBpsOf = (fail, raw) => Math.round(parseNum(fail, 'buyback', raw, 0, 100) * 100)

const pct = (bps) => Number(bps) / 100
const SYMBOL_ABI = parseAbi(['function symbol() view returns (string)'])
const ASSET_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)'])

/** --asset <addr>|wbnb of a sweep (required). */
export function sweepAsset(opt, fail, wbnb) {
  const a = opt('asset')
  if (/^wbnb$/i.test(a ?? '')) return wbnb
  if (!isAddress(a ?? '') || a === zeroAddress) fail('--asset <addr>|wbnb required: the asset to send to the payee (any but the splitter\'s own quote)', { got: a ?? null })
  return a
}

/**
 * `sweep` of a buy-back / LP splitter, from the raw reads (pure: unit-tested): the splitter's whole balance of `asset`
 * goes to the payee (the contract refuses its own quote and an unbound splitter). { error } when it can't.
 */
export function sweepPlan({ asset, quote, balance, decimals = 18, symbol, payee, cmd }) {
  if (!quote || /^0x0{40}$/.test(quote)) return { error: 'the splitter is not bound to a token yet: sweep works once it is bound (its launch binds it)' }
  if (asset.toLowerCase() === quote.toLowerCase()) return { error: `that is the splitter's own quote: sweep never moves it; ${cmd} split splits it (the payee's part now, the rest set aside)` }
  if (BigInt(balance) === 0n) return { error: `the splitter holds no ${symbol ?? asset}: nothing to sweep` }
  return { asset, assetSymbol: symbol ?? null, amount: formatUnits(BigInt(balance), Number(decimals)), payee }
}

/** The reads behind sweepPlan: the splitter's quote and its balance of `asset`. */
export async function sweepReads(read, splitter, abi, asset) {
  const [quote, balance, decimals, symbol] = await Promise.all([
    read(splitter, abi, 'quote'), read(asset, ASSET_ABI, 'balanceOf', [splitter]),
    read(asset, ASSET_ABI, 'decimals').catch(() => 18), read(asset, ASSET_ABI, 'symbol').catch(() => null),
  ])
  return { quote, balance, decimals, symbol }
}

/** A module named by --module that no GangLaunchpad pad of this network owns, or that its GangHandlerAdmin never listed. */
export const notListed = (what, net) =>
  `not one of the platform's ${what}s: no GangLaunchpad pad${net ? ' on the BSC testnet' : ''} lists it (GangHandlerAdmin moduleOf), so the CLI will not call it`

/**
 * `split` of a buy-back / LP splitter, from the raw reads (pure: unit-tested): what arrived since the last split
 * (`unsplit`), the share set aside (`bps`, for `part`: the buy-back or the liquidity) and the payee's part, pushed now.
 * { error } when nothing waits to be split.
 */
export function splitPlan({ unsplit, bps, left, payee, part, leftField, symbol, unbound }) {
  const waiting = BigInt(unsplit)
  if (waiting === 0n) {
    return {
      error: unbound ? 'nothing to split: the splitter is not bound to a token yet, so it has no quote'
        : `nothing waits to be split: no quote arrived since the last split${BigInt(left) > 0n ? ` (${leftField} ${formatUnits(BigInt(left), 18)} is already set aside)` : ''}`,
    }
  }
  const setAside = (waiting * BigInt(bps)) / 10_000n
  const toPayee = waiting - setAside
  return {
    quote: symbol, splitting: formatUnits(waiting, 18), toPayee: formatUnits(toPayee, 18), payee,
    setAside: formatUnits(setAside, 18), setAsideFor: part, [`${leftField}After`]: formatUnits(BigInt(left) + setAside, 18),
  }
}
const iso = (s) => new Date(Number(s) * 1000).toISOString()

/** The splitter's state when `addr` is a GangBuybackSplitter; null when it is not (an EOA, a partner, another module). */
export async function splitterOf(read, addr) {
  if (!addr || addr === zeroAddress) return null
  let type
  try { type = await read(addr, SPLITTER_ABI, 'moduleType') } catch { return null }
  const moduleType = hexToString(type, { size: 32 }).replace(/\0+$/, '')
  if (!BUYBACK_TYPES.includes(moduleType)) return null
  const [dev, token, bps, cut, left, unsplit, owed, burn] = await Promise.all(
    ['dev', 'token', 'buybackBps', 'pendingCut', 'buybackLeft', 'unsplit', 'devOwed', 'previewBurn'].map((f) => read(addr, SPLITTER_ABI, f)))
  // v1 has no payee: it pays the dev
  const hasPayee = moduleType !== 'buyback-burn-v1'
  const payee = hasPayee ? await read(addr, SPLITTER_ABI, 'payee') : dev
  const toDev = payee.toLowerCase() === dev.toLowerCase()
  // the pad takes 18-decimal quotes only
  const q = (x) => formatUnits(x, 18)
  return {
    splitter: addr, moduleType, dev, payee, payeeChangeable: hasPayee, token: token === zeroAddress ? null : token, buybackPct: pct(bps), buybackBps: Number(bps),
    pendingCut: cut[0] ? { toPct: pct(cut[1]), appliesFrom: iso(cut[2]), lapsesAfter: iso(Number(cut[2]) + 7 * 86400) } : null,
    buybackLeft: q(left), unsplit: q(unsplit), devOwed: q(owed),
    nextChunk: burn[0] ? { quoteIn: q(burn[1]), tokensBurned: formatUnits(burn[2], 18) } : null,
    note: `${pct(bps)}% of each tax payment to this recipient is bought back in the pool and burned (0xdead), the rest goes to ${toDev ? 'the dev' : `the payee ${payee}`}; a raise applies at once, a cut only 3 days after it is asked for${hasPayee ? '; the dev can change the payee at once (gang buyback set-payee)' : ''}`,
  }
}

function buybackCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

/** Dry-run a call; { failed } with the revert when it would not pass. */
export async function simulateCall(client, from, address, abi, functionName, args = []) {
  try {
    const { result } = await client.simulateContract({ account: from, address, abi, functionName, args })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

const SUBS = ['status', 'set', 'set-payee', 'apply', 'bind', 'release', 'split', 'sweep']
const USAGE = 'usage: gang buyback <status|set|set-payee|apply|bind|release|split|sweep> --token <addr> (split / sweep: or --module <addr>) [--pct <0-100>] [--to <addr>] [--asset <addr>|wbnb] [--testnet] — see gang help'

/** `gang buyback <sub>`: the splitter of a V3 token (its tax recipient), found from --token. */
export async function runBuyback(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const rawOnly = flag('calldata')
  let ctx
  try { ctx = buybackCtx(testnet) } catch (e) { return fail(e.message) }
  // split / sweep may name the splitter itself (--module), e.g. the --to of a creator-fee claim
  const named = (sub === 'split' || sub === 'sweep') && flag('module')
  if (named && flag('token')) fail('give --token (its tax recipient is the splitter) or --module, not both')
  let token = opt('token')
  let recipient
  if (named) {
    recipient = opt('module')
    if (!isAddress(recipient ?? '')) fail('--module must be a buy-back splitter address (0x…)', { got: recipient ?? null })
    const pad = await ctx.read(recipient, SPLITTER_ABI, 'pad').catch(() => null)
    if (!pad || !atPad(ctx, pad, testnet)) return fail(notListed('buy-back splitter', testnet), { module: recipient })
  } else {
    if (!isAddress(token ?? '')) fail('--token must be a V3 token address (0x…)', { got: token ?? null })
    if ((await atTokenPad(ctx, token)) === null) return fail(KIND_UNREAD.error, { token: token, retry: KIND_UNREAD.retry }) // else on the pad of the token's generation
    try { recipient = (await ctx.read(ctx.pad, PAD_ABI, 'taxConfigOf', [token]))[3] } catch {
      return fail('not a V3 token on this pad', { token, chainId: Number(ctx.chainId) })
    }
  }
  const s = await splitterOf(ctx.read, recipient)
  if (!s) {
    return fail(named ? 'not a buy-back splitter (buyback-burn-v1 … v4)' : 'this token\'s tax recipient is not a buy-back splitter',
      named ? { module: recipient } : { token, recipient: recipient === zeroAddress ? null : recipient })
  }
  if (named) token = s.token
  const chainId = Number(ctx.chainId)
  const me = () => walletFor(ctx, opt('from'))
  const send = async (functionName, args, extra) => {
    const sim = await simulateCall(ctx.client, me(), s.splitter, SPLITTER_ABI, functionName, args)
    if (sim.failed) return out({ success: false, step: functionName, ...sim.failed })
    const data = encodeFunctionData({ abi: SPLITTER_ABI, functionName, args })
    return out(step(ctx, { from: me(), to: s.splitter, data }, { chainId, token, splitter: s.splitter, ...extra }, rawOnly, summarize))
  }

  if (sub === 'status') return out({ success: true, chainId, ...s, ...(s.token === null && { bound: false }) })

  if (sub === 'bind') {
    if (s.token) return fail('already bound', { boundTo: s.token })
    return send('bind', [token], { step: 'bind', note: 'anyone may bind; the token must be the dev\'s and pay its tax to this splitter' })
  }

  if (sub === 'set') {
    if (me().toLowerCase() !== s.dev.toLowerCase()) return fail(HINTS.NotDev, { wallet: me(), dev: s.dev })
    if (!flag('pct')) fail('--pct <0-100> required: the new buy-back share')
    const bps = Math.round(parseNum(fail, 'pct', opt('pct'), 0, 100) * 100)
    return send('setBuybackBps', [bps], bps >= s.buybackBps
      ? { step: 'set-buyback', fromPct: s.buybackPct, toPct: bps / 100, note: `applies at once${s.pendingCut ? ' and cancels the pending cut' : ''}` }
      : {
          step: 'ask-cut', fromPct: s.buybackPct, toPct: bps / 100, appliesFromAbout: new Date(Date.now() + 3 * 86400_000).toISOString(),
          note: `a cut waits 3 days (holders see it coming), then anyone runs gang buyback apply --token ${token}${testnet ? ' --testnet' : ''} within 7 days or it lapses${s.pendingCut ? '; this replaces the cut already asked for' : ''}`,
        })
  }

  if (sub === 'set-payee') {
    if (!s.payeeChangeable) return fail('this splitter (buyback-burn-v1) has no payee: it pays the dev; only splitters from later factories (v2, v3) can name another address')
    if (me().toLowerCase() !== s.dev.toLowerCase()) return fail('only the dev this splitter was made for can change its payee', { wallet: me(), dev: s.dev })
    const to = opt('to')
    if (!isAddress(to ?? '') || to === zeroAddress) fail('--to <0x…> required (checksummed or all lowercase): the address the dev\'s part goes to from now on', { got: to ?? null })
    if (to.toLowerCase() === s.payee.toLowerCase()) return fail('that is the payee already', { payee: s.payee })
    return send('setPayee', [to], {
      step: 'set-payee', fromPayee: s.payee, toPayee: to,
      note: 'applies at once (the dev\'s own share; holders are not affected). Quote that arrived before is split to the current payee first; what is owed goes to the new one',
    })
  }

  if (sub === 'apply') {
    if (!s.pendingCut) return fail(HINTS.NoProposal, { buybackPct: s.buybackPct })
    if (Date.parse(s.pendingCut.appliesFrom) > Date.now()) return fail(HINTS.NotDue, { appliesFrom: s.pendingCut.appliesFrom })
    return send('applyBuybackBps', [], { step: 'apply-cut', fromPct: s.buybackPct, toPct: s.pendingCut.toPct, note: 'anyone may apply a cut once its notice ran' })
  }

  if (sub === 'split') {
    if (!(await listedBy(ctx, s.splitter))) return fail(notListed('buy-back splitter', testnet), { module: s.splitter })
    const [waiting, left, quote] = await Promise.all(['unsplit', 'buybackLeft', 'quote'].map((f) => ctx.read(s.splitter, SPLITTER_ABI, f)))
    const symbol = quote === zeroAddress ? null : await ctx.read(quote, SYMBOL_ABI, 'symbol').catch(() => null)
    const plan = splitPlan({ unsplit: waiting, bps: s.buybackBps, left, payee: s.payee, part: 'buy-back', leftField: 'buybackLeft', symbol, unbound: !s.token })
    if (plan.error) return fail(plan.error, { splitter: s.splitter, buybackLeft: s.buybackLeft, devOwed: s.devOwed })
    const ref = `--token ${s.token}${testnet ? ' --testnet' : ''}`
    return send('split', [], {
      step: 'split', ...plan,
      note: `anyone may: splits what arrived since the last split. ${plan.toPayee} goes to the payee now (should that push fail, it is owed: gang buyback release ${ref}); ${plan.setAside} (${s.buybackPct}%) is set aside for the buy-back, which the keeper spends in chunks once the token trades in its pool (each chunk splits first too, so after graduation this runs by itself)`,
    })
  }

  if (sub === 'sweep') {
    if (!(await listedBy(ctx, s.splitter))) return fail(notListed('buy-back splitter', testnet), { module: s.splitter })
    const asset = sweepAsset(opt, fail, ctx.wbnb)
    const plan = sweepPlan({ asset, ...(await sweepReads(ctx.read, s.splitter, SPLITTER_ABI, asset)), payee: s.payee, cmd: 'gang buyback' })
    if (plan.error) return fail(plan.error, { splitter: s.splitter, asset })
    return send('sweep', [asset], {
      step: 'sweep', ...plan,
      note: 'anyone may: sends the splitter\'s whole balance of this asset (not its own quote; e.g. a creator fee or another token\'s tax in another quote) to the payee; none of it is bought back',
    })
  }

  // release
  if (!(Number(s.devOwed) > 0)) return fail(HINTS.NothingOwed)
  return send('releaseDev', [], { step: 'release', amount: s.devOwed, payee: s.payee, note: 'anyone may; the payee gets what a failed push left owed' })
}
