import { createPublicClient, encodeFunctionData, formatUnits, hexToString, isAddress, parseAbi, zeroAddress } from 'viem'
import { walletFor } from './fair.js'
import { atTokenPad, KIND_UNREAD, NOT_ON_MAINNET, PAD3_GEN, padNets, rpcTransport } from './gangpad.js'
import { revertOf as revertIn, step } from './steps.js'

/**
 * The opening base of a GangLaunchpad 3.0 curve token (base-v1, docs/SPEC-BASE-VAULT-V2-2026-11-12.md): at create the
 * creator pays exactly previewBaseCost(gradBnb, baseBps) in BNB and the pad buys 5% or 10% of the supply as the curve's
 * first trade, for a per-token GangBaseVault. The vault never trades; after graduation anyone's first release() starts
 * the clock, then it releases linearly to the creator (fixed). A token that never graduates keeps its base locked.
 *
 * `gang create … --base <5|10> --base-vest <30|90|180>` (v3.js builds it with the pieces here) and `gang base
 * status|release`. The pad says whether it has the base (baseVaultImpl); an older pad (mainnet before its upgrade) has
 * no such function and the CLI refuses the flag.
 */

export const BASE_TYPE = 'base-v1'
const TAX = '(uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)'
export const BASE_PAD_ABI = parseAbi([
  `function createWithBase(string name, string symbol, string logoURI, string metaURI, ${TAX} tax, uint256 gradBnb, (uint16 baseBps, uint32 vestDays) base) payable returns (address token)`,
  'function baseVaultImpl() view returns (address)',
  'function baseVaultOf(address token) view returns (address)',
  'function baseOf(address token) view returns (uint256)',
  'function previewBaseCost(uint256 gradBnb, uint16 baseBps) view returns (uint256)',
  'error BaseNotOpen()', 'error BadBaseConfig()', 'error WrongBaseVaultImpl()', 'error BaseBuyRefused()', 'error BadMsgValue()',
  'event BaseVaultImplSet(address indexed impl)',
  'event BaseCreated(address indexed token, address indexed vault, uint256 tokens, uint256 cost, uint16 baseBps, uint32 vestDays)',
])
export const BASE_VAULT_ABI = parseAbi([
  'function pad() view returns (address)',
  'function token() view returns (address)',
  'function creator() view returns (address)',
  'function startAt() view returns (uint64)',
  'function duration() view returns (uint64)',
  'function total() view returns (uint256)',
  'function released() view returns (uint256)',
  'function releasable() view returns (uint256)',
  'function moduleType() view returns (bytes32)',
  'function release() returns (uint256 amount)',
  'error NotPad()', 'error AlreadyInitialized()', 'error BadInit()', 'error NotGraduated()', 'error NothingToRelease()', 'error Reentered()',
  'event Initialized(address indexed token, address indexed creator, uint32 vestDays)',
  'event Began(uint64 startAt, uint256 total)',
  'event Released(address indexed creator, uint256 amount, uint256 releasedTotal)',
])
/** What `gang tx` decodes a base create's and a base vault's logs with. */
export const BASE_EVENT_ABIS = [BASE_PAD_ABI, BASE_VAULT_ABI]
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function locked() view returns (bool)',
  'function symbol() view returns (string)',
])

export const HINTS = {
  BaseNotOpen: 'this pad has the opening base but it is closed (no vault implementation set): drop --base',
  BadBaseConfig: '--base 5 takes --base-vest 30 / 90 / 180, --base 10 only 90 / 180; a dividend token takes no base',
  BadMsgValue: 'the BNB sent is not exactly the base cost the pad asks (previewBaseCost): build the create again',
  BaseBuyRefused: 'the pad refused the base buy (never expected from a create): report it to gang',
  NotGraduated: 'the token has not graduated: the base stays locked until it does (and for good if it never does)',
  NothingToRelease: 'nothing has vested since the last release: try again later (gang base status shows when)',
}
export const revertOf = (e) => revertIn(e, [BASE_PAD_ABI, BASE_VAULT_ABI], HINTS)

/** Base size (bps of the supply) → the release periods offered (spec §4.2; Pad3Module._baseOffered). */
export const BASE_OFFERED = { 500: [30, 90, 180], 1000: [90, 180] }
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n
const POOL_TOKENS = 200_000_000 // what graduation puts in the pair beside the graduation amount
const VIRTUAL_TOKEN = 1_066_666_666.666_666_7 // CurveLogic3.VIRTUAL_TOKEN, in whole tokens
const CURVE_SUPPLY = 800_000_000

export const BASE_USAGE = '--base <5|10> --base-vest <30|90|180>: the % of the supply bought for your base vault at create (5 or 10) and the days it is released over after graduation (5%: 30 / 90 / 180; 10%: 90 / 180)'
export const BASE_NO_BOND = 'GangBond does not constrain the base: a bond checks only the creator wallet\'s balance, and the vault keeps refilling that wallet as it releases, so a bond on a base token says nothing about what you do with the base (and a bond lasts 90 days at most). Do not present a bond as a promise about the base'
export const BASE_LOST = 'If the token never graduates, the base stays locked in the vault for good and the BNB you paid for it stays in the curve: there is no refund, cancel or early release'

/** { baseBps, vestDays } from --base / --base-vest, or { error }. */
export function parseBase(base, vest) {
  if (base == null || !/^(5|10)%?$/.test(String(base).trim())) return { error: BASE_USAGE, got: base ?? null }
  const baseBps = Number(String(base).trim().replace('%', '')) * 100
  if (vest == null) return { error: `--base needs --base-vest <days>: ${baseBps === 500 ? '30, 90 or 180' : '90 or 180'} (the release period after graduation, fixed for good)` }
  const vestDays = Number(String(vest).trim())
  if (!BASE_OFFERED[baseBps].includes(vestDays)) {
    return { error: baseBps === 1000 && vestDays === 30 ? 'a 10% base is released over 90 or 180 days, not 30 (30 days is for a 5% base)' : `--base-vest for a ${baseBps / 100}% base must be ${BASE_OFFERED[baseBps].join(', ')} (days)`, got: vest }
  }
  return { baseBps, vestDays }
}

/**
 * Whether `ctx.pad` has the opening base: { open: true, impl } / { open: false, why } / { unread } (RPC error). An older
 * pad has no baseVaultImpl (a revert without data); 0 = closed.
 */
export async function baseSupport(ctx) {
  if (ctx.gen !== PAD3_GEN) return { open: false, why: `GangLaunchpad ${ctx.gen ?? ctx.pad} has no opening base (3.0 only)` }
  let impl
  try { impl = await ctx.read(ctx.pad, BASE_PAD_ABI, 'baseVaultImpl') } catch (e) {
    if (missingRead(e)) return { open: false, why: `GangLaunchpad 3.0 on ${ctx.chainId === '97' ? 'the BSC testnet' : 'BSC mainnet'} has no opening base yet (the pad is not upgraded for it)` }
    return { unread: e.shortMessage || e.message.split('\n')[0] }
  }
  if (impl.toLowerCase() === zeroAddress) return { open: false, why: 'the opening base is closed on this pad (no vault implementation set)' }
  return { open: true, impl }
}

/** A call that hit a contract without the function (no data back), never a node's internal error (-32603). */
export function missingRead(e) {
  if (e?.walk?.((x) => x?.code === -32603)) return false
  if (e?.walk?.((x) => x?.name === 'ContractFunctionZeroDataError')) return true
  const r = e?.walk?.((x) => x?.name === 'ContractFunctionRevertedError')
  return !!r && !r.data && (!r.raw || r.raw === '0x')
}

const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d

/**
 * The numbers of spec §2 for one base, from the graduation target `gradBnb` (BNB), the size and period and the cost
 * the pad asks (wei). Pool figures are the constant-product pair graduation makes (200M tokens + gradBnb), before the
 * PancakeSwap fee and any tax.
 */
export function basePayoff({ gradBnb, baseBps, vestDays, cost, creatorFeeShareBps = 7000 }) {
  const g = Number(gradBnb)
  const b = (baseBps / 10_000) * 1e9 // tokens
  const costBnb = Number(formatUnits(cost, 18))
  const gradPrice = g / POOL_TOKENS
  const atGradPrice = b * gradPrice
  const minimum = (g * b) / (POOL_TOKENS + b) // released and sold into the pair with no other buyer
  const endPrice = (POOL_TOKENS / (POOL_TOKENS + b)) ** 2
  const vq = g / 3
  const baseNet = (vq * b) / (VIRTUAL_TOKEN - b)
  const fee = costBnb / 100
  return {
    costBnb: formatUnits(cost, 18),
    tokens: `${b / 1e6}M (${baseBps / 100}% of the supply)`,
    feeIncluded: `1% curve fee included (${r(fee, 6)} BNB); ${creatorFeeShareBps / 100}% of it is credited back to you as the creator fee (gang creator-fee --claim), so you pay about ${r((fee * (10_000 - creatorFeeShareBps)) / 10_000, 6)} BNB of fee`,
    averagePrice: `about 1/${r(atGradPrice / costBnb, 1)} of the graduation price`,
    worthAtGraduation: `${r(atGradPrice, 4)} BNB at the graduation price (${r(atGradPrice / g, 2)} × the ${g} BNB target)`,
    poolShare: `${r((b / POOL_TOKENS) * 100, 1)}% of the tokens the PancakeSwap pair gets at graduation`,
    youGet: {
      minimum: `about ${r(minimum, 3)} BNB: every release sold at once and no other buyer in the pool (the price then ends at ${Math.round(endPrice * 100)}% of the graduation price). The worst case for holders and the least you get, not a cap`,
      atGraduationPrice: `${r(atGradPrice, 4)} BNB if the price stays at the graduation price`,
      higher: 'more if the price is higher, with no upper limit',
      daysToRecoverCost: `about ${r((costBnb * vestDays) / atGradPrice, 1)} days of release, sold at the graduation price, pay back the cost; after that the base carries no risk for you`,
      releasedPerDay: `${r((b / vestDays / POOL_TOKENS) * 100, 2)}% of the pair's tokens a day (${r(b / vestDays / 1e6, 3)}M tokens)`,
    },
    othersPay: {
      startPrice: `the curve starts ${r((VIRTUAL_TOKEN / (VIRTUAL_TOKEN - b)) ** 2, 2)}× higher than without a base`,
      averageToGraduation: `buyers who take the curve to graduation pay ${r(((1 - baseNet / g) / ((CURVE_SUPPLY - b) / CURVE_SUPPLY) - 1) * 100, 1)}% more on average`,
    },
    figures: 'computed from the curve and the pair graduation makes, before the PancakeSwap fee and any tax',
  }
}

/** The release schedule in words. */
export const scheduleLine = (vestDays) => `after graduation, the first gang base release (anyone may call it) starts the clock; from then on the base is released linearly over ${vestDays} days to the creator's wallet — fixed for good, nobody can change the period or the wallet. The time between graduation and that first call does not count: calling it late only delays your own release`

/** The tax line of a base create: the creator is usually its own tax recipient (a base token takes no dividend). */
export function baseTaxLine({ taxed, sellTaxPct, platformTaxPct, selfRecipient }) {
  if (!taxed) return null
  return selfRecipient
    ? `you are this token's tax recipient: of the ${sellTaxPct}% sell tax you pay selling released base in the pool, all but the platform's ${platformTaxPct}% of volume comes back to you (a base token has no dividend), so you keep the figures above less about ${platformTaxPct}% of what you sell, and less the PancakeSwap fee (0.25%) and slippage, which none of these figures include`
    : `the ${sellTaxPct}% sell tax on what you sell of the base goes to the recipient (${platformTaxPct}% of volume to the platform), not to you: the figures above are before it, and before the PancakeSwap fee (0.25%) and slippage`
}

function baseCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const tok = (x) => formatUnits(x, 18)
const pctOf = (x) => Number((x * 1_000_000n) / TOTAL_SUPPLY) / 10_000
const iso = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null)

/**
 * The token's base vault as the pad and the vault say, at one block: null when the token has none, { error } when it
 * cannot be read. `now` (seconds) is that block's time. Unreleased is by time (total − what has vested), not the
 * vault's balance: anyone can push a release out (spec §10).
 */
export async function baseOf(ctx, token) {
  if (ctx.gen !== PAD3_GEN) return null
  let vault
  try { vault = await ctx.read(ctx.pad, BASE_PAD_ABI, 'baseVaultOf', [token]) } catch (e) {
    if (missingRead(e)) return null // a pad before the base: no token of it has one
    throw e
  }
  if (vault.toLowerCase() === zeroAddress) return null
  // written once at create: the rest is read at one block, so the time and the vault's numbers agree
  const block = await ctx.client.getBlock()
  const at = { blockNumber: block.number }
  const read = (address, abi, functionName, args = []) => ctx.client.readContract({ address, abi, functionName, args, ...at })
  const [bought, vPad, vToken, creator, startAt, duration, total, released, releasable, type, balance, locked] = await Promise.all([
    read(ctx.pad, BASE_PAD_ABI, 'baseOf', [token]),
    ...['pad', 'token', 'creator', 'startAt', 'duration', 'total', 'released', 'releasable', 'moduleType'].map((f) => read(vault, BASE_VAULT_ABI, f)),
    read(token, ERC20_ABI, 'balanceOf', [vault]), read(token, ERC20_ABI, 'locked'),
  ])
  const now = block.timestamp
  const kind = (() => { try { return hexToString(type, { size: 32 }).replace(/\0+$/, '') } catch { return null } })()
  const ours = vPad.toLowerCase() === ctx.pad.toLowerCase() && vToken.toLowerCase() === token.toLowerCase() && kind === BASE_TYPE
  const started = startAt > 0n
  const vested = !started ? 0n : now - startAt >= duration ? total : (total * (now - startAt)) / duration
  // by time (spec §10): before the start, the whole base bought at create (tokens sent in later are not the base)
  const unreleased = started ? (total > vested ? total - vested : 0n) : bought
  const days = Number(duration / 86_400n)
  return {
    vault, claims: kind, ...(ours ? {} : { warning: 'the vault the pad names does not say it is this token\'s base-v1 vault of this pad: report it to gang' }),
    creator, recipient: creator, baseTokens: tok(bought), basePct: pctOf(bought), vestDays: days,
    graduated: !locked, started,
    startAt: started ? iso(startAt) : 'not started',
    ...(started && { endsAt: iso(startAt + duration), elapsedDays: Math.min(days, Number((now - startAt) / 864n) / 100) }),
    total: started ? tok(total) : null,
    released: tok(released), releasable: tok(releasable),
    vestedSoFar: tok(vested), unreleased: tok(unreleased), unreleasedPct: pctOf(unreleased), inVault: tok(balance),
    note: !started
      ? locked
        ? `locked until graduation. Then the first gang base release starts a ${days}-day linear release to the creator. ${BASE_LOST.replace('you paid', 'the creator paid')}`
        : `graduated, release not started: the first gang base release (anyone may call it) starts the clock; nothing moves in that call`
      : vested >= total && now - startAt >= duration
        ? balance === 0n
          ? 'fully released: the vault is empty (gang base release has nothing to send)'
          : 'the release period is over: gang base release sends the vault\'s whole balance to the creator'
        : `releasing linearly to the creator until ${iso(startAt + duration)}; unreleased is counted by time (total − vested so far), not from the vault's balance`,
    bond: BASE_NO_BOND,
    raw: { bought, startAt, duration, total, released, releasable, balance, locked, now },
  }
}

const SUBS = ['status', 'release']
const USAGE = 'usage: gang base <status|release> --token <addr> [--testnet] [--calldata] [--from <addr>] — see gang help'

/** `gang base <sub>`: a 3.0 curve token's opening base vault. */
export async function runBase(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  let ctx
  try { ctx = baseCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)
  const tn = testnet ? ' --testnet' : ''
  const token = opt('token')
  if (!isAddress(token ?? '')) return fail('--token must be a 3.0 curve token address (0x…)', { got: token ?? null })
  const kind = await atTokenPad(ctx, token)
  if (kind === null) return fail(KIND_UNREAD.error, { token, retry: KIND_UNREAD.retry })
  if (kind !== 'v3') return fail(`not a V3 curve token on a GangLaunchpad (${testnet ? 'BSC testnet' : 'BSC mainnet; add --testnet for a testnet token'})`, { token, chainId, ...(kind && kind !== 'none' && { kind }) })
  let s
  try { s = await baseOf(ctx, token) } catch (e) {
    return fail('could not read the token\'s base vault (RPC error)', { token, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' })
  }
  if (!s) return fail('this token has no opening base (it was not created with --base)', { token, pad: ctx.pad, padGen: ctx.gen })
  const { raw, ...shown } = s
  if (sub === 'status') {
    return out({
      success: true, chainId, token, pad: ctx.pad, ...shown,
      ...(raw.locked ? {} : !s.started ? { next: `gang base release --token ${token}${tn}` } : raw.releasable > 0n ? { next: `gang base release --token ${token}${tn}` } : {}),
    })
  }

  // release: anyone; the tokens always go to the creator
  if (s.warning) return fail(s.warning, { vault: s.vault })
  if (raw.locked) return fail(HINTS.NotGraduated, { token, vault: s.vault })
  if (s.started && raw.releasable === 0n) return fail(HINTS.NothingToRelease, { token, vault: s.vault, releasedSoFar: s.released, ...(s.endsAt && { endsAt: s.endsAt }) })
  const me = walletFor(ctx, opt('from'))
  let sim
  try { await ctx.client.simulateContract({ account: me, address: s.vault, abi: BASE_VAULT_ABI, functionName: 'release' }) } catch (e) {
    const rv = revertOf(e)
    sim = rv ? { reverted: true, ...rv } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] }
  }
  if (sim) return out({ success: false, step: 'base-release', ...sim })
  const data = encodeFunctionData({ abi: BASE_VAULT_ABI, functionName: 'release' })
  const mine = String(me).toLowerCase() === s.creator.toLowerCase()
  return out(step(ctx, { from: me, to: s.vault, data }, {
    step: 'base-release', chainId, token, vault: s.vault, creator: s.creator,
    ...(s.started
      ? { amount: s.releasable, note: `sends what has vested and was not sent yet (about ${s.releasable} tokens now; a little more by the time it lands) to the creator ${s.creator}${mine ? ' (you)' : ', not to the wallet that calls'}` }
      : { amount: '0', starts: true, note: `starts the ${s.vestDays}-day release now: the vault records its balance (${s.inVault} tokens) as the total and sends nothing in this call; from then on the creator ${s.creator}${mine ? ' (you)' : ''} can release what has vested` }),
  }, flag('calldata'), summarize))
}
