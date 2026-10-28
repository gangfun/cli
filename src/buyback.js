import { createPublicClient, http, parseAbi, encodeFunctionData, formatUnits, hexToString, isAddress, zeroAddress } from 'viem'
import { padNets, NOT_ON_MAINNET } from './gangpad.js'
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
 * Env: GANG_SPLITTER_FACTORY / GANG_TESTNET_SPLITTER_FACTORY override the built-in factory addresses.
 */

// BSC 56, factory v2 (payee; docs/MAINNET-BUYBACK-SPLITTER-2026-10-28.md). v1 was 0x6bcd…8546 (2-argument create)
export const MAINNET_SPLITTER_FACTORY = '0x93467Cb38B9Cb7f6EF3b67d2226Eb8b77ca58F2f'
export const TESTNET_SPLITTER_FACTORY = '0x08b9E2Cf5F666b55F262239b19e25de25b8ba87D'
/** The factory's clones; v1 (mainnet's first factory, 0x6bcd…8546) pays the dev, v2 its payee. */
export const BUYBACK_TYPE = 'buyback-burn-v2'
const BUYBACK_TYPES = ['buyback-burn-v1', BUYBACK_TYPE]

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
}
const revertOf = (e) => revertIn(e, [SPLITTER_ABI, FACTORY_ABI], HINTS)

export function splitterFactoryAddress(testnet) {
  return (testnet ? process.env.GANG_TESTNET_SPLITTER_FACTORY || TESTNET_SPLITTER_FACTORY
    : process.env.GANG_SPLITTER_FACTORY || MAINNET_SPLITTER_FACTORY) || null
}

export const notDeployed = (testnet) =>
  `GangBuybackSplitterFactory is not deployed on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} in this CLI version: set ${testnet ? 'GANG_TESTNET_SPLITTER_FACTORY' : 'GANG_SPLITTER_FACTORY'} to its address`

/** --buyback <pct> (0–100, the share of the recipient's part bought back) in bps. */
export const buybackBpsOf = (fail, raw) => Math.round(parseNum(fail, 'buyback', raw, 0, 100) * 100)

const pct = (bps) => Number(bps) / 100
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
  const client = createPublicClient({ chain: net.chain, transport: http(net.rpc) })
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

const SUBS = ['status', 'set', 'set-payee', 'apply', 'bind', 'release']
const USAGE = 'usage: gang buyback <status|set|set-payee|apply|bind|release> --token <addr> [--pct <0-100>] [--to <addr>] [--testnet] — see gang help'

/** `gang buyback <sub>`: the splitter of a V3 token (its tax recipient), found from --token. */
export async function runBuyback(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const rawOnly = flag('calldata')
  let ctx
  try { ctx = buybackCtx(testnet) } catch (e) { return fail(e.message) }
  const token = opt('token')
  if (!isAddress(token ?? '')) fail('--token must be a V3 token address (0x…)', { got: token ?? null })
  let recipient
  try { recipient = (await ctx.read(ctx.pad, PAD_ABI, 'taxConfigOf', [token]))[3] } catch {
    return fail('not a V3 token on this pad', { token, chainId: Number(ctx.chainId) })
  }
  const s = await splitterOf(ctx.read, recipient)
  if (!s) return fail('this token\'s tax recipient is not a buy-back splitter', { token, recipient: recipient === zeroAddress ? null : recipient })
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
    if (!s.payeeChangeable) return fail('this splitter (buyback-burn-v1) has no payee: it pays the dev; only splitters from the current factory (v2) can name another address')
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

  // release
  if (!(Number(s.devOwed) > 0)) return fail(HINTS.NothingOwed)
  return send('releaseDev', [], { step: 'release', amount: s.devOwed, payee: s.payee, note: 'anyone may; the payee gets what a failed push left owed' })
}
