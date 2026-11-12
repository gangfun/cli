import { createPublicClient, parseAbi, encodeFunctionData, formatUnits, getAddress, hexToString, isAddress, maxUint256, numberToHex, parseUnits, zeroAddress } from 'viem'
import { atPad, atTokenPad, GANG_GENS, gangGens, KIND_UNREAD, padNets, NOT_ON_MAINNET, rpcTransport } from './gangpad.js'
import { walletFor } from './fair.js'
import { fundingStep, parseAmount, parseNum, poolSellQuote, revertOf as revertIn, step } from './steps.js'
import { parseSplitSpec } from './split.js'
import { COMBO_GAS_NOTE } from './combo.js'
import { capUnits, parseCapShare, payeeAmounts, quoteUnits } from './capped.js'
import { bondGuard } from './bond.js'
import { callBondGuard } from './callbond.js'

/**
 * `gang floor …` and `gang create … --floor [--redeem-fee <pct>] [--tax-cap <amount> [--tax-cap-share <pct>] [--split <addr>:<pct>,…]]`
 * — GangFloorModule (底价赎回, `floor-v1`): one V3 token's tax recipient that keeps the tax as a treasury. Of each payment
 * of the bound quote, `payBps` goes to 0–10 payees at fixed shares until they have been credited `capAmount` in all (the
 * capped recipient's rule); the rest — once the cap is reached, or with no payees, all of it — stays in the module. Any
 * holder may `redeem`: its tokens go to 0xdead and it takes `amount × treasury ÷ floorSupply` of the quote, less
 * `redeemFeeBps` that stays in the treasury. floorSupply = total supply − what 0xdead holds. No buy-back, no liquidity, no
 * swap. A redemption never calls a payee: the payees' part of what arrived is counted against the cap and set aside
 * (`payeesPending`) for the next split.
 * The token is fixed when the module is cloned (`floorToken`, its CREATE2 address before it exists): `bind` only checks
 * it. So a launch computes the token's address first (the final name, symbol, metadata URI, tax rates), clones the
 * module for it, then creates the token with the same salt (launch.js; vanity.js `fixed`).
 * A module is a floor module only when GangFloorModuleFactory listed it (GangHandlerAdmin.moduleOf): a contract that
 * merely answers `floor-v1` is not one, and this CLI builds no redemption against it (docs/SPEC-FLOOR-MODULE-2026-11-11.md §6).
 * Env: GANG_FLOOR_FACTORY / GANG_TESTNET_FLOOR_FACTORY (gangpad.js).
 */

export const MAINNET_FLOOR_FACTORY = GANG_GENS.mainnet[0].floorFactory ?? null
export const TESTNET_FLOOR_FACTORY = GANG_GENS.testnet[0].floorFactory ?? null
export const FLOOR_TYPE = 'floor-v1'
const BPS = 10_000
const MAX_REDEEM_FEE_BPS = 500
const DEFAULT_REDEEM_FEE_BPS = 200
const DEAD = '0x000000000000000000000000000000000000dEaD'

const ERRORS = [
  'error ZeroAddress()', 'error NotClone()', 'error NotFactory()', 'error AlreadyInitialized()', 'error BadBps()',
  'error BadPayees()', 'error BadShares()', 'error BadPayee()', 'error DuplicatePayee()', 'error BadIndex()',
  'error NotPayee()', 'error AlreadyBound()', 'error NotBound()', 'error WrongToken()', 'error NotCurve()',
  'error NotCreator()', 'error NotRecipient()', 'error NothingOwed()', 'error NotTradable()', 'error Slippage()',
  'error PushStarved()', 'error BadCap()', 'error WrongQuote()', 'error BadQuote()', 'error ZeroAmount()', 'error BadTo()',
  'error NothingToRedeem()', 'error NothingForRecipient()',
]

export const FLOOR_FACTORY_ABI = parseAbi([
  'function create(address token, address floorQuote, uint256 capAmount, uint16 payBps, uint16 redeemFeeBps, address[] payees, uint16[] shares, bytes32 salt) returns (address module)',
  'function predict(address dev, bytes32 salt) view returns (address)',
  'function pad() view returns (address)',
  'function admin() view returns (address)',
  'function vanityEnabled() view returns (bool)',
  'error NotAgent()', 'error WrongHandler()', 'error NoVanityDeployer()', 'error BadToken()',
  'event Created(address indexed dev, address indexed module, address indexed token, address floorQuote, uint256 capAmount, uint16 payBps, uint16 redeemFeeBps, address[] payees, uint16[] shares)',
  ...ERRORS,
])

export const FLOOR_ABI = parseAbi([
  'function moduleType() view returns (bytes32)',
  'function pad() view returns (address)',
  'function dev() view returns (address)',
  'function floorToken() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function floorQuote() view returns (address)',
  'function gangQuote() view returns (address)',
  'function capAmount() view returns (uint256)',
  'function paidTotal() view returns (uint256)',
  'function payBps() view returns (uint16)',
  'function redeemFeeBps() view returns (uint16)',
  'function capLeft() view returns (uint256)',
  'function capReached() view returns (bool)',
  'function payeesOf() view returns (address[] payees, uint16[] shares)',
  'function treasuryHeld() view returns (uint256)',
  'function treasury() view returns (uint256)',
  'function payeesPending() view returns (uint256)',
  'function floorSupply() view returns (uint256)',
  'function floorPrice() view returns (uint256)',
  'function previewRedeem(uint256 amount) view returns (uint256 quoteOut, uint256 fee)',
  'function owedOf(address asset, uint256 index) view returns (uint256)',
  'function owedTotal(address asset) view returns (uint256)',
  'function unsplit() view returns (uint256)',
  'function undistributed(address asset) view returns (uint256)',
  'function keeperServes(address q) view returns (bool)',
  'function previewWork() view returns (bool due, uint256 minOut)',
  'function lastPaidAt() view returns (uint64)',
  'function bind(address token)',
  'function split()',
  'function distribute(address asset) returns (uint256 incoming)',
  'function release(address asset, uint256 index, uint256 maxAmount) returns (uint256 amount)',
  'function setPayee(uint256 index, address newPayee)',
  'function redeem(uint256 amount, uint256 minQuoteOut, address to) returns (uint256 quoteOut)',
  'function work(uint256 minOut)',
  'event Bound(address indexed token, address indexed quote)',
  'event Split(uint256 incoming, uint256 toTreasury, uint256 toPayees)',
  'event CapReached(uint256 capAmount)',
  'event Redeemed(address indexed holder, address indexed to, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 treasuryAfter, uint256 supplyAfter)',
  'event Distributed(address indexed asset, uint256 incoming, uint256 toDead)',
  'event PayeeOwed(address indexed asset, uint256 indexed index, uint256 amount)',
  'event PayeeReleased(address indexed asset, uint256 indexed index, uint256 amount)',
  'event PayeeChanged(uint256 indexed index, address indexed oldPayee, address indexed newPayee)',
  'event Shortfall(address indexed asset, uint256 amount)',
  ...ERRORS,
])
/** gang tx decodes these (the factory's Created and the module's Split / Redeemed; the rest share capped's topics). */
export const FLOOR_EVENT_ABIS = [FLOOR_FACTORY_ABI, FLOOR_ABI]

const ADMIN_ABI = parseAbi(['function moduleOf(address module) view returns (address)'])
const PAD_ABI = parseAbi([
  'function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)',
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function taxHandler() view returns (address)',
  'function PLATFORM_TAX_BPS() view returns (uint256)',
])
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)',
])

const DEAD_GAS_NOTE = 'let the wallet estimate the gas limit and do not lower it: the transfer to 0xdead needs about 365k gas left before it (a lower limit reverts PushStarved: nothing moves)'

export const HINTS = {
  NotAgent: 'only an Agent can create a V3 token, so only an Agent gets a floor module',
  NotFactory: 'this floor factory is not allowed on the platform\'s GangHandlerAdmin: it cannot list a floor module as a tax recipient. If GANG_FLOOR_FACTORY / GANG_TESTNET_FLOOR_FACTORY is set, unset or fix it; otherwise launch without --floor',
  NoVanityDeployer: 'this pad does not create its tokens at an address known in advance (its CREATE2 deployer is not on): a floor module is cloned for one token address, so --floor is not available here yet',
  BadToken: 'the token address a floor module is cloned for must end in abcd and have no token at it yet: the launch computes it; run it again (or add --restart)',
  BadCap: '--tax-cap must be above 0 when payees take a share, and left out when they don\'t',
  BadBps: '--tax-cap-share is 0.01–100% of the recipient\'s part, and --redeem-fee 0–5%',
  BadPayees: 'with --tax-cap: 1–10 payees (--split), one share each; without it: no payees',
  BadShares: 'each payee share at least 0.01% (1 bps) of the payees\' part, all adding up to 100% of it',
  BadPayee: 'a payee cannot be the floor module itself',
  DuplicatePayee: 'that address is a payee already (each address holds at most one slot)',
  ZeroAddress: 'the zero address cannot be a payee, the quote, or where a redemption is paid',
  BadIndex: 'no payee slot with that index (gang floor status lists them, from 0; a module without payees has none)',
  NotPayee: 'only the current payee of a slot can move it to another address',
  AlreadyBound: 'the floor module is bound to its token already',
  NotBound: 'the floor module is not bound to its token yet (gang floor bind --token <the token>): nothing is split or redeemed before that',
  WrongToken: 'a floor module serves only the token it was cloned for (floorToken): this is another token',
  NotCurve: 'the token the floor module was cloned for is not created yet (or is not a V3 curve token on this pad)',
  NotCreator: 'the token at the module\'s address was not created by the module\'s dev',
  NotRecipient: 'the token does not pay its tax to this floor module',
  WrongQuote: 'the token\'s quote is not the floor module\'s quote (floorQuote): it can never be bound',
  BadQuote: 'the treasury\'s quote must be WBNB, GANG or a quote in the pad\'s QuoteRegistry: a launch with --floor needs one of those as its quote',
  NothingForRecipient: 'the token gives all of its tax to the holders\' dividend (--dividend 100): nothing would ever reach the floor module, so it can\'t be bound',
  NothingOwed: 'nothing is owed to that slot (gang floor status shows what each slot is owed). If a split just paid it, there is nothing left to release',
  NotTradable: 'the token has not graduated: redemptions start once it trades in its PancakeSwap pair (the pool tax, which fills the treasury, starts then too)',
  Slippage: 'the redemption would pay less than the minimum asked: the treasury per token only falls when the quote itself is taken from the module (a freezable quote); run gang floor redeem again to see what it pays now',
  NothingToRedeem: 'this amount redeems for nothing: the treasury is empty, or the amount is too small',
  ZeroAmount: '--amount must be above 0',
  BadTo: '--to cannot be the floor module itself',
  PushStarved: `the tx's gas limit was too low for the payee pushes: ${COMBO_GAS_NOTE}`,
}
export const revertOf = (e) => revertIn(e, [FLOOR_ABI, FLOOR_FACTORY_ABI], HINTS)

/** Dry-run a call; { failed } with the revert when it would not pass. */
export async function simulateFloor(client, from, address, abi, functionName, args = []) {
  try {
    const { result } = await client.simulateContract({ account: from, address, abi, functionName, args })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

/** The create target's floor factory (a launch clones its floor module there), or null when not deployed. */
export function floorFactoryAddress(testnet) {
  return gangGens(testnet)[0].floorFactory || null
}

export const floorNotDeployed = (testnet) => (testnet
  ? 'GangFloorModuleFactory (the floor module, --floor) is not deployed on the BSC testnet in this CLI version: set GANG_TESTNET_FLOOR_FACTORY to its address, or launch without --floor'
  : 'GangFloorModuleFactory (the floor module, --floor) is not deployed on BSC mainnet in this CLI version: set GANG_FLOOR_FACTORY to its address, or launch without --floor')

export const PERMANENT_NOTE = 'PERMANENT: the token it serves, the quote, the redemption fee, the cap, the payees\' % and the payees and their shares are fixed for good — nobody (not you, not the platform) can change them later; a payee can only move its own slot to another address (gang floor set-payee)'
export const FLOOR_NOTE = 'What the floor is: the treasury per token, in the quote — anyone can give up tokens for it at any time after graduation. What it is not: a price promise. It starts at 0 (the curve pays no tax), grows only with pool volume, and is usually far below the market price: redeeming tokens bought above it is a loss. It is never lowered by a redemption (with a fee, each one raises it); only a quote that is itself frozen or taken from the module can lower it'
export const OTHER_ASSETS_NOTE = 'any other asset sent to it (not the token\'s quote) cannot count in the treasury: all of it goes to 0xdead when it is distributed (gang floor distribute --asset <addr>, anyone), never to holders or payees; one that cannot be sent there stays in the module'
export const UNCHECKED_NOTE = 'could not check whether GangFloorModuleFactory made this module (RPC error): nothing is shown or built until it is known — run the same command again'
export const UNVERIFIED_NOTE = 'this contract says it is a floor module, but GangFloorModuleFactory did not make it (GangHandlerAdmin.moduleOf): its numbers are its own claims, and this CLI builds no redemption or other call against it'

// ---- the launch's flags

const PCT_RE = /^(\d{1,3})(?:\.(\d{1,2}))?$/
const pctBps = (raw) => {
  const m = PCT_RE.exec(String(raw ?? '').trim())
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null
}
const FEE_USAGE = '--redeem-fee is the % of each redemption that stays in the treasury for the holders who remain: 0 to 5, at most 2 decimals (left out: 2)'
const FLOOR_SPLIT_NOTE = 'with --floor, --split lists the payees of the capped part (it needs --tax-cap), their shares adding up to 100 (of that part)'

/** --redeem-fee → { redeemFeeBps } (0–500) or { error }. Left out: 2%. */
export function parseRedeemFee(raw) {
  if (raw === undefined) return { redeemFeeBps: DEFAULT_REDEEM_FEE_BPS }
  const bps = pctBps(raw)
  if (bps === null || bps > MAX_REDEEM_FEE_BPS) return { error: FEE_USAGE, got: raw ?? null }
  return { redeemFeeBps: bps }
}

/** A payee's share (bps of the payees' part) as a % of the recipient's whole part, until the cap. */
const ofRecipient = (share, payBps) => Math.round((Number(share) * Number(payBps)) / 1e2) / 1e4

/**
 * A floor launch's flags → { payBps, redeemFeeBps, payees, shares, list, capped } or { error, … }, checked as
 * GangFloorModule.initialize checks them. `cap`: whether --tax-cap is given (its amount needs the quote's decimals:
 * capped.js capUnits); `capShare` / `split` / `redeemFee`: the raw flags (undefined when absent); `me`: the creating
 * wallet. Without --tax-cap there are no payees: all of the recipient's part is the treasury.
 */
export function parseFloorSpec({ cap = false, capShare, split, redeemFee } = {}, me) {
  const fee = parseRedeemFee(redeemFee)
  if (fee.error) return fee
  if (!cap) {
    if (capShare !== undefined) return { error: '--tax-cap-share goes with --tax-cap <amount>: with --floor alone nobody takes a share, all of the recipient\'s part is the treasury' }
    if (split !== undefined) return { error: '--split goes with --tax-cap <amount>: with --floor alone there are no payees, all of the recipient\'s part is the treasury', hint: FLOOR_SPLIT_NOTE }
    return { payBps: 0, redeemFeeBps: fee.redeemFeeBps, payees: [], shares: [], list: [], capped: false }
  }
  const share = parseCapShare(capShare)
  if (share.error) return share
  let spec
  if (split === undefined) {
    if (!isAddress(me ?? '')) return { error: 'the capped part goes to your wallet: sign in with baw, or give --from (or name the payees with --split)' }
    spec = { payees: [getAddress(me)], shares: [BPS], list: [{ index: 0, payee: getAddress(me), pct: 100, you: true }] }
  } else {
    spec = parseSplitSpec(split, me)
    if (spec.error) return { ...spec, hint: spec.hint ? `${spec.hint}. ${FLOOR_SPLIT_NOTE}` : FLOOR_SPLIT_NOTE }
  }
  return {
    payBps: share.payBps, redeemFeeBps: fee.redeemFeeBps, payees: spec.payees, shares: spec.shares, capped: true,
    list: spec.list.map(({ pct: p, ...x }) => ({ ...x, pctOfPayees: p, pctOfRecipientUntilCap: ofRecipient(spec.shares[x.index], share.payBps) })),
  }
}

// ---- the contract's math (pure: unit-tested to the wei)

/** _partsOf: how `incoming` of the bound quote splits with `paid` already credited against `capAmount`. */
export function partsOf(incoming, paid, capAmount, payBps) {
  let toPayees = (BigInt(incoming) * BigInt(payBps)) / 10_000n
  const left = BigInt(capAmount) - BigInt(paid)
  if (toPayees > left) toPayees = left
  return { toPayees, toTreasury: BigInt(incoming) - toPayees }
}

/** _quoteFor: what `amount` tokens redeem for against `held` over `supply`, and the fee left in the treasury. */
export function quoteFor(amount, held, supply, redeemFeeBps) {
  if (BigInt(supply) === 0n) return { quoteOut: 0n, fee: 0n }
  const gross = (BigInt(amount) * BigInt(held)) / BigInt(supply)
  const fee = (gross * BigInt(redeemFeeBps)) / 10_000n
  return { quoteOut: gross - fee, fee }
}

/**
 * How much of the pool's volume reaches the treasury, in % of volume (spec §1): (tax − platform tax) × (1 − dividend) ×
 * (1 − pay share), until the cap and after it. Buys pay the buy tax and sells the sell tax: `low` / `high` when they differ.
 */
export function treasuryShare({ buyTaxPct, sellTaxPct, platformTaxPct = 0.5, dividendPct = 0, payBps = 0 }) {
  const at = (tax, pay) => Math.max(0, Math.round((tax - platformTaxPct) * (1 - dividendPct / 100) * (1 - pay / BPS) * 1e4) / 1e4)
  const of = (pay) => {
    const [a, b] = [at(buyTaxPct, pay), at(sellTaxPct, pay)]
    return a === b ? { pctOfVolume: a } : { pctOfVolume: { buys: a, sells: b } }
  }
  const after = of(0)
  return {
    ...(Number(payBps) > 0 && { untilCap: of(Number(payBps)) }), afterCap: after,
    how: `(tax − ${platformTaxPct}% platform) × (1 − ${dividendPct}% dividend)${Number(payBps) > 0 ? ` × (1 − ${Number(payBps) / 100}% to the payees, until the cap)` : ''}, of pool volume after graduation. While no holder has 10,000+ tokens the holders' part falls back to the recipient, so a little more arrives`,
  }
}

/** The floor module's terms as one line, for a launch preview and a re-run's refusal. */
export function floorLine({ cap, symbol, payBps, redeemFeeBps, payees, shares }) {
  const fee = `a redemption leaves ${Number(redeemFeeBps) / 100}% of what it takes in the treasury`
  if (!payees.length) return `all of it stays in the treasury that holders can redeem; ${fee}`
  const who = payees.map((x, i) => `${x}: ${Number(shares[i]) / 100}% of it`).join(', ')
  const until = Number(payBps) === BPS ? `all of it to ${who}` : `${Number(payBps) / 100}% to ${who}, the rest to the treasury`
  return `until the payees have been credited ${cap} ${symbol ?? 'of the quote'} in all: ${until}. From then on all of it stays in the treasury that holders can redeem; ${fee}`
}

const iso = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null)
/**
 * The treasury per whole token, as text: `treasury` (quote wei) over `supply` (token wei, 18 decimals), less `feeBps`.
 * Computed here with 6 more digits than the contract's floorPrice(), which rounds to the quote's smallest unit per
 * whole token (0 for a small treasury in a quote with few decimals).
 */
const perToken = (treasury, supply, quoteDecimals, feeBps = 0) => {
  if (BigInt(supply ?? 0n) === 0n) return '0'
  // 6 digits past the quote's own decimals: enough to see a floor under one unit of it, without a tail of noise
  const scaled = (BigInt(treasury ?? 0n) * 10n ** 24n * BigInt(BPS - feeBps)) / (BigInt(supply) * BigInt(BPS))
  return formatUnits(scaled, quoteDecimals + 6)
}

/**
 * The module's state for printing, from the raw reads (pure: unit-tested). `raw`: { module, verified, dev, floorToken,
 * token, quote, floorQuote, quoteSymbol, quoteDecimals, capAmount, paidTotal, payBps, redeemFeeBps, payees, shares,
 * treasuryHeld, treasury, payeesPending, floorSupply, floorPrice, unsplit, lastPaidAt, keeperServesQuote, work: [due,
 * minOut] | null, graduated: bool | null, tokenExists: bool, assets: [{ asset, symbol, decimals, undistributed,
 * owedTotal, owed: bigint[] | null }] }. `ref`: how later commands name it.
 */
export function formatFloor(raw, ref) {
  const token = raw.token && raw.token !== zeroAddress ? raw.token : null
  const quote = token && raw.quote && raw.quote !== zeroAddress ? raw.quote : null
  const isQuote = (a) => !!quote && a.toLowerCase() === quote.toLowerCase()
  const dec = raw.quoteDecimals ?? 18
  const fq = (x) => formatUnits(BigInt(x ?? 0n), dec)
  const payBps = Number(raw.payBps), feeBps = Number(raw.redeemFeeBps)
  const capAmount = BigInt(raw.capAmount), paid = BigInt(raw.paidTotal)
  const hasPayees = raw.payees.length > 0
  const left = capAmount - paid
  const reached = left <= 0n
  const dev = String(raw.dev).toLowerCase()
  const payees = raw.payees.map((payee, index) => ({
    index, payee, pctOfPayees: Number(raw.shares[index]) / 100, pctOfRecipientUntilCap: ofRecipient(raw.shares[index], payBps),
    bps: Number(raw.shares[index]), ...(payee.toLowerCase() === dev && { isDev: true }),
  }))
  const unsplit = BigInt(raw.unsplit ?? 0n)
  const pending = partsOf(unsplit, paid, capAmount, payBps)
  const sym = raw.quoteSymbol || raw.floorQuote
  const next = []
  const assets = []
  for (const a of raw.assets ?? []) {
    const owedTotal = a.owedTotal ?? 0n
    const undistributed = a.undistributed ?? 0n
    if (!isQuote(a.asset) && undistributed === 0n && owedTotal === 0n) continue
    const f = (x) => formatUnits(x, a.decimals ?? 18)
    const owed = owedTotal > 0n && a.owed
      ? a.owed.map((x, index) => ({ index, payee: raw.payees[index], amount: f(x) })).filter((_, i) => a.owed[i] > 0n) : []
    const burns = !!token && !isQuote(a.asset) && undistributed > 0n
    assets.push({
      asset: a.asset, symbol: a.symbol ?? null, ...(isQuote(a.asset) && { boundQuote: true }),
      undistributed: f(undistributed), owedTotal: f(owedTotal), ...(owed.length && { owed }), ...(burns && { burns: true }),
    })
    if (burns && raw.verified === true) next.push(`gang floor distribute ${ref} --asset ${a.asset} (BURNS all of it: sends it to 0xdead, paid to nobody; only if that is wanted)`)
    for (const o of owed) if (raw.verified === true) next.push(`gang floor release ${ref} --asset ${a.asset} --index ${o.index}`)
  }
  const pendingPay = BigInt(raw.payeesPending ?? 0n) + pending.toPayees
  const ok = raw.verified === true
  if (token && ok && pendingPay > 0n) next.unshift(`gang floor distribute ${ref} (pushes the payees' ${fq(pendingPay)} ${sym})`)
  if (!token && ok) next.unshift(raw.tokenExists ? `gang floor bind ${String(ref).replace(/^--module \S+/, `--token ${raw.floorToken}`)}` : 'nothing yet: the token it was cloned for is not created')
  if (token && ok && raw.graduated && BigInt(raw.treasury ?? 0n) > 0n) next.push(`gang floor redeem ${ref} --amount <tokens>`)

  const [due] = raw.work ?? [false, 0n]
  const state = raw.verified === null ? 'unchecked' : !ok ? 'unverified' : !token ? 'unbound' : raw.graduated === false ? 'before-graduation' : 'live'
  const stateLine = {
    unchecked: UNCHECKED_NOTE,
    unverified: UNVERIFIED_NOTE,
    unbound: raw.tokenExists
      ? 'Not bound yet: the token it was cloned for exists, anyone can bind it (gang floor bind). Nothing is split or redeemed before that'
      : 'Not bound yet: the token it was cloned for does not exist. Whatever reaches the module waits; it can never serve another token',
    'before-graduation': 'The token has not graduated: the pool tax that fills the treasury starts at graduation, and so do redemptions',
    live: BigInt(raw.treasury ?? 0n) === 0n ? 'The treasury is empty so far: it fills with the pool tax' : `Each token redeems for ${perToken(raw.treasury, raw.floorSupply, dec)} ${sym} before the ${feeBps / 100}% fee`,
  }[state]
  const capLine = !hasPayees ? 'No payees: all of the recipient\'s part is the treasury'
    : reached ? `The cap is reached: the payees were credited ${fq(capAmount)} ${sym} in all, and every payment now stays in the treasury`
      : `${fq(paid)} of the ${fq(capAmount)} ${sym} cap credited to the payees so far, ${fq(left)} left`
  return {
    module: raw.module, moduleType: FLOOR_TYPE, verified: raw.verified === null ? null : ok, state, dev: raw.dev, floorToken: raw.floorToken,
    token, quote, quoteSymbol: raw.quoteSymbol ?? null, floorQuote: raw.floorQuote, quoteDecimals: dec,
    ...(raw.quoteDecimalsUnread && { decimalsNote: 'the quote\'s decimals could not be read: amounts assume 18' }),
    treasury: fq(raw.treasury ?? 0n), floorSupply: formatUnits(BigInt(raw.floorSupply ?? 0n), 18),
    floorPerToken: perToken(raw.treasury, raw.floorSupply, dec), redeemFeePct: feeBps / 100, redeemFeeBps: feeBps,
    redeemPerTokenAfterFee: perToken(raw.treasury, raw.floorSupply, dec, feeBps),
    ...(hasPayees
      ? { cap: { amount: fq(capAmount), paid: fq(paid), left: fq(left), reached, progressPct: capAmount > 0n ? Number((paid * 10_000n) / capAmount) / 100 : 0 }, payPct: payBps / 100, payBps, payees }
      : { cap: null, payPct: 0, payBps: 0, payees: [] }),
    permanent: true,
    unsplit: fq(unsplit),
    ...(unsplit > 0n && { unsplitGoes: { toPayees: fq(pending.toPayees), toTreasury: fq(pending.toTreasury) } }),
    payeesPending: fq(raw.payeesPending ?? 0n),
    lastPaidAt: iso(raw.lastPaidAt ?? 0n),
    keeper: { servesQuote: token ? !!raw.keeperServesQuote : null, due: !!due },
    assets,
    ...(next.length && { next }),
    floor: FLOOR_NOTE,
    note: `${stateLine}. ${capLine}. ${PERMANENT_NOTE}. The treasury needs no keeper; a redemption pushes no payee — what it sets aside for them is pushed by the next gang floor distribute (anyone) or the keeper`,
  }
}

/** Reads `asset`'s side of the module; null when it is not an ERC20 the module can read. */
async function assetRaw(read, module, asset, n) {
  let undistributed, owedTotal
  try {
    [undistributed, owedTotal] = await Promise.all([
      read(module, FLOOR_ABI, 'undistributed', [asset]), read(module, FLOOR_ABI, 'owedTotal', [asset]),
    ])
  } catch { return null }
  const [symbol, decimals, owed] = await Promise.all([
    read(asset, ERC20_ABI, 'symbol').catch(() => null),
    read(asset, ERC20_ABI, 'decimals').then(Number).catch(() => 18),
    owedTotal > 0n && n > 0 ? Promise.all(Array.from({ length: n }, (_, i) => read(module, FLOOR_ABI, 'owedOf', [asset, BigInt(i)]))) : null,
  ])
  return { asset, symbol, decimals, undistributed, owedTotal, owed }
}

/**
 * Whether `module` was made by `factory` (GangHandlerAdmin.moduleOf): the only thing that makes a contract a floor
 * module. null when it could not be read (RPC): never treated as verified, and never reported as "not made by it".
 */
export async function floorVerified(read, module, factory) {
  if (!factory) return false
  try {
    const admin = await read(factory, FLOOR_FACTORY_ABI, 'admin')
    return (await read(admin, ADMIN_ABI, 'moduleOf', [module])).toLowerCase() === factory.toLowerCase()
  } catch { return null }
}

const LISTING_ABI = parseAbi([
  'function taxHandler() view returns (address)', 'function isListed(address recipient) view returns (bool)',
  'function owner() view returns (address)',
])
/** A module kind as every one of the platform's modules names itself: `split-v1`, `buyback-burn-v4`, `floor-v1`. */
const KIND_RE = /^[a-z][a-z0-9-]*-v\d+$/

/**
 * The node ran the call and the contract reverted: JSON-RPC code 3 (or -32000, as older nodes send it) whose message
 * is "execution reverted" (any case; alone or with a reason after a colon), with no data or real revert data (a
 * selector and more). NOT a node's own failure: an internal error (-32603), a gateway's message that only mentions a revert, "gas
 * required exceeds allowance", a rate limit dressed as code 3, data that is not revert data.
 */
function revertedCall(e) {
  // the node's own error (viem wraps a -32000 in a class that keeps the code and the message but drops the data)
  const x = e?.walk?.((y) => y?.name === 'RpcRequestError' && typeof y.code === 'number') ?? null
  if (!x || (x.code !== 3 && x.code !== -32000)) return false
  if (!/^execution reverted(:|$)/i.test(String(x.details ?? x.message ?? '').trim())) return false
  const data = x.data && typeof x.data === 'object' ? x.data.data : x.data
  return data == null || data === '0x' || (typeof data === 'string' && /^0x([0-9a-fA-F]{2}){4,}$/.test(data))
}

/**
 * Is `recipient` — an address someone typed as the tax recipient of a token created on `pad` — a floor module?
 * → { floor: true, by } | { floor: false } | { unlisted: true } | { unread: <detail> }.
 * A token that names a floor module by hand lands at another address than the one the module was cloned for, and its
 * tax is stuck there for good. So "no" is said only on the chain's own evidence, and whatever a node leaves unanswered
 * is `unread` (the caller builds nothing and asks to run again), never "no".
 * Every read is at ONE block (the latest one the node names): a node that does not have that block fails the read, so
 * a node behind the chain can't answer "no code" or "not listed" for a module cloned seconds ago. The reads whose
 * answer can be "no" (the registries, the code, moduleType()) go to the node raw: only a hex string is an answer —
 * `null`, an empty string or a missing result is the node's silence, not the contract's.
 *  1. The pad takes a recipient that is not the creator only when its tax handler lists it (CurveLogic3.checkTax). Not
 *     listed at that block: `unlisted` — the create is refused whatever the address is.
 *  2. The floor `factory` (the create target's; null where there is none) has its modules recorded by the
 *     GangHandlerAdmin it was built over (factory.admin(), fixed for good; moduleOf, written in the clone's tx): a
 *     floor module, whoever owns the handler by now.
 *  3. The handler's owner (that admin, or a later one) records which factory listed a module. Listed by a factory: one
 *     of the platform's modules, and every one of those names its kind (moduleType(): `split-v1`, `floor-v1`, …).
 *     `floor-v1` (a floor factory this CLI does not know): a floor module. Another kind: not one. No answer, or an
 *     answer that is no kind's name: `unread`.
 *  4. Listed by no factory (the platform listed it by hand: a partner's treasury): a wallet (no code at that block) is
 *     not a module. A contract is asked moduleType(): `floor-v1` → a floor module; any other word (or more than a
 *     word), an empty return, or a revert (revertedCall) → not one; a piece of a word, or no answer → `unread`.
 */
export async function typedFloorModule({ client, pad }, recipient, factory) {
  try {
    const blockNumber = await client.getBlockNumber()
    const block = numberToHex(blockNumber)
    const at = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber })
    /** The node's own word, raw: a hex string, or the failure. */
    const hex = async (method, params) => {
      const r = await client.request({ method, params: [...params, block] })
      if (typeof r !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(r)) throw new Error(`the node gave no result for ${method}`)
      return r
    }
    /** moduleOf(recipient) on `admin`: the factory, the zero address, or null when `admin` keeps no such record. */
    const listedBy = async (admin) => {
      let r
      try { r = await hex('eth_call', [{ to: admin, data: encodeFunctionData({ abi: ADMIN_ABI, functionName: 'moduleOf', args: [recipient] }) }]) } catch (e) {
        if (!revertedCall(e)) throw e
        return null
      }
      if (r === '0x') return null // not a contract, or one whose fallback returns nothing
      if (r.length !== 66 || !/^0x0{24}/.test(r)) throw new Error('moduleOf answered something that is not an address')
      return getAddress(`0x${r.slice(26)}`)
    }
    const same = (x, y) => !!x && !!y && x.toLowerCase() === y.toLowerCase()

    const handler = await at(pad, LISTING_ABI, 'taxHandler')
    if (!(await at(handler, LISTING_ABI, 'isListed', [recipient]))) return { unlisted: true }
    const owner = await at(handler, LISTING_ABI, 'owner')
    let by = null
    if (factory) {
      const admin = await at(factory, FLOOR_FACTORY_ABI, 'admin')
      const listed = await listedBy(admin)
      if (same(listed, factory)) return { floor: true, by: 'GangHandlerAdmin.moduleOf' }
      // recorded there for another factory: a factory's module too, whoever owns the handler by now
      by = same(admin, owner) || (listed && listed !== zeroAddress) ? listed : await listedBy(owner)
    } else by = await listedBy(owner)
    const byFactory = !!by && by !== zeroAddress

    if (!byFactory && (await hex('eth_getCode', [recipient])) === '0x') return { floor: false }
    let r
    try { r = await hex('eth_call', [{ to: recipient, data: encodeFunctionData({ abi: FLOOR_ABI, functionName: 'moduleType' }) }]) } catch (e) {
      // a module a factory listed always answers: a revert from one is not the chain's word
      if (byFactory || !revertedCall(e)) throw e
      return { floor: false }
    }
    const kind = r.length === 66 ? hexToString(r, { size: 32 }).replace(/\0+$/, '') : null
    if (kind === FLOOR_TYPE) return { floor: true, by: 'moduleType()' }
    if (byFactory) {
      if (kind === null || !KIND_RE.test(kind)) throw new Error('a listed module did not name its kind')
      return { floor: false }
    }
    // listed by hand: an empty return (no such function, a silent fallback), a full word or more is the contract's
    // answer — a floor module returns exactly one word, and a node's failure never makes an answer longer. A piece of
    // a word is not an answer
    if (r !== '0x' && r.length < 66) throw new Error('moduleType() answered less than a word')
    return { floor: false }
  } catch (e) {
    return { unread: e?.details || String(e?.shortMessage ?? e?.message ?? e).split('\n')[0] }
  }
}

/**
 * The module's state when `addr` answers `floor-v1`; null when it does not. `factory`: the floor factory of the pad's
 * generation (the provenance check). Assets read: the quote, WBNB, the module's GANG and `extraAssets`.
 */
export async function floorOf(read, addr, { wbnb, pad, factory, extraAssets = [], ref, getCode } = {}) {
  if (!addr || addr === zeroAddress) return null
  let type
  try { type = await read(addr, FLOOR_ABI, 'moduleType') } catch { return null }
  if (hexToString(type, { size: 32 }).replace(/\0+$/, '') !== FLOOR_TYPE) return null
  const FIELDS = ['dev', 'floorToken', 'token', 'quote', 'floorQuote', 'capAmount', 'paidTotal', 'payBps', 'redeemFeeBps', 'payeesOf', 'treasuryHeld', 'treasury', 'payeesPending', 'floorSupply', 'floorPrice', 'unsplit', 'lastPaidAt']
  const [vals, gangQuote, verified] = await Promise.all([
    Promise.all(FIELDS.map((f) => read(addr, FLOOR_ABI, f))),
    read(addr, FLOOR_ABI, 'gangQuote').catch(() => zeroAddress),
    floorVerified(read, addr, factory),
  ])
  const r = Object.fromEntries(FIELDS.map((f, i) => [f, vals[i]]))
  const [payees, shares] = r.payeesOf
  const bound = r.token !== zeroAddress
  const [work, keeperServesQuote, graduated, units, tokenExists] = await Promise.all([
    bound ? read(addr, FLOOR_ABI, 'previewWork').catch(() => null) : null,
    bound ? read(addr, FLOOR_ABI, 'keeperServes', [r.quote]).catch(() => false) : false,
    bound && pad ? read(pad, PAD_ABI, 'curves', [r.token]).then((c) => c[6]).catch(() => null) : null,
    quoteUnits(read, r.floorQuote),
    bound ? true : pad ? read(pad, PAD_ABI, 'curves', [r.floorToken]).then((c) => c[0] !== zeroAddress).catch(() => (getCode ? getCode(r.floorToken).then((c) => !!c && c !== '0x').catch(() => false) : false)) : false,
  ])
  const seen = new Set()
  const list = [r.quote, r.floorQuote, wbnb, gangQuote, ...extraAssets].filter((a) => {
    if (!a || a === zeroAddress || seen.has(a.toLowerCase())) return false
    seen.add(a.toLowerCase())
    return true
  })
  const assets = (await Promise.all(list.map((a) => assetRaw(read, addr, a, payees.length)))).filter(Boolean)
  return formatFloor({
    module: addr, verified, dev: r.dev, floorToken: r.floorToken, token: r.token, quote: r.quote,
    floorQuote: r.floorQuote, quoteSymbol: units.symbol, quoteDecimals: units.decimals ?? 18,
    ...(units.decimals === null && { quoteDecimalsUnread: true }),
    capAmount: r.capAmount, paidTotal: r.paidTotal, payBps: r.payBps, redeemFeeBps: r.redeemFeeBps, payees, shares,
    treasuryHeld: r.treasuryHeld, treasury: r.treasury, payeesPending: r.payeesPending, floorSupply: r.floorSupply,
    floorPrice: r.floorPrice, unsplit: r.unsplit, lastPaidAt: r.lastPaidAt, keeperServesQuote, work, graduated, tokenExists, assets,
  }, ref ?? (bound ? `--token ${r.token}` : `--module ${addr}`))
}

/**
 * When `token` pays its tax to a floor module that is not its own (cloned for another token): what to say. This token
 * has no floor; its tax is a gift to the other token's holders (or waits in a module whose token does not exist).
 */
export function notItsFloor(s, token) {
  if (!token || String(s.floorToken).toLowerCase() === token.toLowerCase()) return null
  return `this token pays its tax to a floor module cloned for another token (${s.floorToken}): this token has NO floor and its holders can redeem nothing — its tax goes to the payees and the treasury of that other token${s.token ? '' : ', which is not even bound yet (the tax waits in the module)'}`
}

/**
 * What may be shown of `s` for `token` (null: the module named directly). A module the factory did not make, one that
 * could not be checked, or one cloned for another token is NOT this token's floor: only what it is and the warning are
 * shown — no treasury, no price per token, no next command (spec §6, §8). Else `s` as it is.
 */
export function floorShown(s, token) {
  const warning = s.verified === null ? UNCHECKED_NOTE : !s.verified ? UNVERIFIED_NOTE : notItsFloor(s, token)
  if (!warning) return s
  return {
    module: s.module, claims: FLOOR_TYPE, verified: s.verified, isThisTokensFloor: false,
    ...(s.verified === true && { floorToken: s.floorToken }), warning,
  }
}

function floorCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const SUBS = ['status', 'redeem', 'distribute', 'release', 'set-payee', 'bind']
const USAGE = 'usage: gang floor <status|redeem|distribute|release|set-payee|bind> --token <addr> (or --module <addr>) [--amount <tokens>|all] [--to <addr>] [--break-bond] [--break-call-bond] [--settle-first] [--asset <addr>|wbnb] [--index <i>] [--max <amount>] [--testnet] — see gang help'

/** `gang floor <sub>`: the floor module of a V3 token (its tax recipient), found from --token (or named by --module). */
export async function runFloor(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const rawOnly = flag('calldata')
  let ctx
  try { ctx = floorCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)
  const tn = testnet ? ' --testnet' : ''
  if (flag('token') && flag('module')) fail('give --token (its tax recipient is the floor module) or --module, not both')
  let token = null, module, tokenQuote = null, padKnown = true, curve = null
  if (flag('module')) {
    if (sub === 'redeem') fail('gang floor redeem needs --token <the token>: it redeems that token against its own floor module')
    module = opt('module')
    if (!isAddress(module ?? '')) fail('--module must be a floor module address (0x…)', { got: module ?? null })
    const pad = await ctx.read(module, FLOOR_ABI, 'pad').catch(() => null)
    padKnown = !!pad && atPad(ctx, pad, testnet)
  } else {
    token = opt('token')
    if (!isAddress(token ?? '')) fail('--token must be a V3 token address (0x…), or name the module with --module <addr>', { got: token ?? null })
    if ((await atTokenPad(ctx, token)) === null) return fail(KIND_UNREAD.error, { token, retry: KIND_UNREAD.retry })
    try {
      curve = await ctx.read(ctx.pad, PAD_ABI, 'curves', [token])
      if (curve[0] === zeroAddress) throw new Error('not a curve')
      tokenQuote = curve[1]
      module = (await ctx.read(ctx.pad, PAD_ABI, 'taxConfigOf', [token]))[3]
    } catch {
      return fail(`not a V3 token on this pad (${testnet ? 'BSC testnet' : 'BSC mainnet; add --testnet for a testnet token'})`, { token, chainId })
    }
  }
  const ref = `${token ? `--token ${token}` : `--module ${module}`}${tn}`
  const extra = sub === 'status' && flag('asset') && isAddress(opt('asset') ?? '') ? [getAddress(opt('asset'))] : []
  const s = await floorOf(ctx.read, module, {
    wbnb: ctx.wbnb, pad: padKnown ? ctx.pad : null, factory: padKnown ? ctx.floorFactory : null,
    extraAssets: [...(tokenQuote && tokenQuote !== zeroAddress ? [tokenQuote] : []), ...extra], ref,
    getCode: (a) => ctx.client.getCode({ address: a }),
  })
  if (!s) {
    return fail(token ? 'this token\'s tax recipient is not a floor module (floor-v1)' : 'not a floor module (floor-v1)',
      { ...(token && { token }), recipient: module === zeroAddress ? null : module })
  }
  const shown = floorShown(s, token)
  if (sub === 'status') return out({ success: true, chainId, ...shown, ...(shown === s && s.token === null && { bound: false }) })

  // every write is built only against a module the factory made, and never for a token that is not the module's own
  if (s.verified === null) return fail(UNCHECKED_NOTE, { module: s.module, retry: 'same command again' })
  if (shown !== s) return fail(shown.warning, { module: s.module, ...(shown.floorToken && { floorToken: shown.floorToken }) })

  const me = () => walletFor(ctx, opt('from'))
  const send = async (functionName, args, extraOut) => {
    const sim = await simulateFloor(ctx.client, me(), s.module, FLOOR_ABI, functionName, args)
    if (sim.failed) return out({ success: false, step: extraOut.step, ...sim.failed })
    const data = encodeFunctionData({ abi: FLOOR_ABI, functionName, args })
    return out(step(ctx, { from: me(), to: s.module, data }, { chainId, ...(token && { token }), module: s.module, ...extraOut }, rawOnly, summarize))
  }
  const assetArg = (def) => {
    if (!flag('asset')) return def
    const a = opt('asset')
    if (/^wbnb$/i.test(a ?? '')) return ctx.wbnb
    if (!isAddress(a ?? '') || a === zeroAddress) fail('--asset must be a token address (0x…, checksummed or all lowercase) or wbnb', { got: a ?? null })
    return getAddress(a)
  }
  const assetState = async (asset) => {
    const r = await assetRaw(ctx.read, s.module, asset, s.payees.length)
    if (!r) fail('the module cannot read that asset\'s balance (not an ERC20?)', { asset })
    return { ...r, f: (x) => formatUnits(x, r.decimals) }
  }
  const needBound = () => {
    if (!s.token) fail(HINTS.NotBound, { module: s.module, floorToken: s.floorToken })
  }
  const fq = (x) => formatUnits(x, s.quoteDecimals)
  const sym = s.quoteSymbol ?? 'of the quote'

  if (sub === 'bind') {
    if (s.token) return fail('already bound', { boundTo: s.token })
    return send('bind', [s.floorToken], { step: 'bind', token: s.floorToken, note: `anyone may bind (once): the module takes only the token it was cloned for (${s.floorToken}), created by its dev, paying its tax to it, quoted in ${sym}, with less than all of the tax going to the holders' dividend` })
  }

  if (sub === 'redeem') {
    needBound()
    if (!curve[6]) return fail(HINTS.NotTradable, { token })
    const wallet = me()
    const bal = await ctx.read(token, ERC20_ABI, 'balanceOf', [wallet])
    const rawAmount = opt('amount')
    if (!flag('amount')) fail('--amount <tokens> required (or --amount all): the tokens to give up; they go to 0xdead for good')
    const amount = /^all$/i.test(rawAmount ?? '') ? bal : parseUnits(parseAmount(fail, 'amount', rawAmount), 18)
    if (amount === 0n) return fail(bal === 0n ? 'this wallet holds none of this token' : HINTS.ZeroAmount, { wallet })
    if (amount > bal) return fail('not enough tokens', { have: formatUnits(bal, 18), need: formatUnits(amount, 18) })
    let to = wallet
    if (flag('to')) {
      to = opt('to')
      if (!isAddress(to ?? '') || to === zeroAddress) fail('--to must be a 0x address (checksummed or all lowercase): where the quote is paid (left out: this wallet)', { got: to ?? null })
      if (to.toLowerCase() === s.module.toLowerCase()) return fail(HINTS.BadTo, { to })
      to = getAddress(to)
    }
    // the tokens leave the wallet for good, as in a sell: the creator's own bond and call bond are checked the same way
    const guard = await bondGuard(ctx, { token, me: wallet, amount, testnet, breakBond: flag('break-bond'), settleFirst: flag('settle-first') }, rawOnly, summarize)
    const callGuard = await callBondGuard(ctx, { token, me: wallet, amount, testnet, breakBond: flag('break-call-bond') })
    if (guard?.refuse || callGuard?.refuse) {
      return out({
        success: false, step: 'redeem', wallet, redeemingCountsAsSelling: 'a redemption sends the tokens to 0xdead: for a bond it is a sell',
        ...(guard?.refuse ?? callGuard.refuse), ...(guard?.refuse && callGuard?.refuse && { callBond: callGuard.refuse }),
      })
    }
    if (guard?.settleStep) return out(guard.settleStep)
    const bondInfo = { ...guard?.info, ...callGuard?.info }
    const slippage = parseNum(fail, 'slippage', opt('slippage', '0'), 0, 50)
    const [[quoteOut, fee], supply, held] = await Promise.all([
      ctx.read(s.module, FLOOR_ABI, 'previewRedeem', [amount]), ctx.read(s.module, FLOOR_ABI, 'floorSupply'), ctx.read(s.module, FLOOR_ABI, 'treasury'),
    ])
    if (quoteOut === 0n) return fail(HINTS.NothingToRedeem, { treasury: fq(held), amount: formatUnits(amount, 18) })
    // the redemption against the pool: tokens bought above the floor redeem at a loss, and a sale may pay far more
    const handler = await ctx.read(ctx.pad, PAD_ABI, 'taxHandler').catch(() => null)
    // a quote of 0 is no price to compare with (the handler has no pair for the token): treated as unread, never as "a sale pays nothing"
    const quoted = handler ? await poolSellQuote(ctx, handler, token, amount) : null
    const sale = quoted && quoted.out > 0n ? quoted : null
    const better = sale && sale.out > quoteOut
    const poolWarning = better
      ? `selling these tokens in the pool pays about ${fq(sale.out)} ${sym}, redeeming them ${fq(quoteOut)} ${sym}: the floor is below the market price, so redeeming is a loss here (gang sell --token ${token}${tn})`
      : !sale ? `the pool price could not be read, so this redemption is NOT compared with a sale: the floor is usually far below the market price, and then redeeming is a loss. Check gang quote --token ${token}${tn} (or gang sell) before executing`
        : null
    const funding = await fundingStep(ctx, { me: wallet, token, need: amount, spender: s.module, sym: 'tokens', approveStep: 'approve' }, rawOnly, summarize)
    if (funding) {
      return out({
        ...funding, chainId, token, module: s.module,
        ...(funding.success !== false && { then: { step: 'redeem', irreversible: true, redeems: formatUnits(amount, 18), quoteOut: fq(quoteOut), quoteSymbol: s.quoteSymbol, sellingInThePoolInstead: sale ? fq(sale.out) : null } }),
        ...bondInfo, ...(poolWarning && { warning: poolWarning }),
      })
    }
    const minOut = (quoteOut * BigInt(Math.round((100 - slippage) * 100))) / 10_000n
    return send('redeem', [amount, minOut, to], {
      step: 'redeem', redeems: formatUnits(amount, 18), quoteOut: fq(quoteOut), fee: fq(fee), feePct: s.redeemFeePct, quoteSymbol: s.quoteSymbol,
      minQuoteOut: fq(minOut), to, treasury: fq(held), floorSupply: formatUnits(supply, 18), irreversible: true,
      ...(sale ? { sellingInThePoolInstead: fq(sale.out), poolQuotedWith: sale.quotedWith } : { sellingInThePoolInstead: null }),
      ...bondInfo, ...(poolWarning && { warning: poolWarning }),
      note: `IRREVERSIBLE: the ${formatUnits(amount, 18)} tokens go to 0xdead for good and ${to.toLowerCase() === wallet.toLowerCase() ? 'this wallet' : to} gets ${fq(quoteOut)} ${sym} — their share of the treasury (${fq(held)} ${sym} over ${formatUnits(supply, 18)} tokens) less the ${s.redeemFeePct}% fee, which stays for the holders who remain. No tax on the way. The minimum is ${slippage === 0 ? 'the previewed amount itself' : `${slippage}% under it`}: what a token redeems for only falls when the quote itself is taken from the module. Redeeming pushes no payee`,
    })
  }

  if (sub === 'distribute') {
    needBound()
    const asset = assetArg(s.quote)
    const a = await assetState(asset)
    if (asset.toLowerCase() === s.quote.toLowerCase()) {
      const [paid, capAmount, pend] = await Promise.all([ctx.read(s.module, FLOOR_ABI, 'paidTotal'), ctx.read(s.module, FLOOR_ABI, 'capAmount'), ctx.read(s.module, FLOOR_ABI, 'payeesPending')])
      // a balance under what the module holds (a quote that was frozen or taken): the split only records the shortfall —
      // every held part shrinks in proportion, nothing is pushed; the next call pushes
      const [bal, held] = await Promise.all([ctx.read(s.quote, ERC20_ABI, 'balanceOf', [s.module]), ctx.read(s.module, FLOOR_ABI, 'treasuryHeld')])
      const books = held + a.owedTotal + pend
      if (bal < books) {
        return send('distribute', [asset], {
          step: 'distribute', asset, symbol: a.symbol, boundQuote: true, shortfall: fq(books - bal), holds: fq(bal), books: fq(books), pushedNow: fq(0n),
          warning: `the module holds ${fq(bal)} ${sym}, ${fq(books - bal)} less than its books (${fq(books)}): some of the quote was frozen or taken`,
          note: 'anyone may: this call only records the shortfall — the treasury, what payees are owed and what is set aside for them shrink in proportion, and nothing is pushed. Run gang floor distribute again after it to push the payees what is left for them',
        })
      }
      if (a.undistributed === 0n && pend === 0n) {
        return fail('nothing is waiting: no quote arrived since the last split and nothing is set aside for the payees', {
          asset, symbol: a.symbol, owedTotal: a.f(a.owedTotal),
          ...(a.owedTotal > 0n && { hint: `what payees are owed after failed pushes: gang floor release ${ref} --index <i>` }),
        })
      }
      const p = partsOf(a.undistributed, paid, capAmount, s.payBps)
      const push = p.toPayees + pend
      const amounts = payeeAmounts(push, s.payees.map((x) => x.bps))
      const reachesCap = paid < capAmount && paid + p.toPayees === capAmount
      return send('distribute', [asset], {
        step: 'distribute', asset, symbol: a.symbol, boundQuote: true, amount: fq(a.undistributed),
        toTreasury: fq(p.toTreasury), toPayees: fq(p.toPayees), setAsideBefore: fq(pend), pushedNow: fq(push),
        ...(s.payees.length && { parts: s.payees.map((x, i) => ({ index: x.index, payee: x.payee, pctOfPayees: x.pctOfPayees, gets: fq(amounts[i]) })) }),
        ...(s.cap && { cap: { amount: fq(capAmount), paidBefore: fq(paid), paidAfter: fq(paid + p.toPayees), ...(reachesCap && { reachesCap: true }) } }),
        note: `anyone may: splits the bound quote that arrived (as split())${s.payees.length ? `: ${s.payPct}% to the payees, never more than what is left of the cap, the rest to the treasury; what earlier redemptions set aside for the payees is pushed with it. A push that fails is owed to that slot; a slot that is owed from before gets that too when its push goes through. Gas: ${COMBO_GAS_NOTE}` : ': all of it is the treasury already (no payees); the call only settles the books'}`,
      })
    }
    if (a.undistributed === 0n) return fail('nothing of this asset is in the module', { asset, symbol: a.symbol })
    return send('distribute', [asset], {
      step: 'distribute', asset, symbol: a.symbol, amount: a.f(a.undistributed), toDead: a.f(a.undistributed), burns: true,
      note: `anyone may: this is not the bound quote, so it cannot count in the treasury: ALL of it goes to 0xdead, none to holders or payees (when it cannot be sent there it stays in the module). Gas: ${DEAD_GAS_NOTE}`,
    })
  }

  if (sub === 'release') {
    needBound()
    if (!s.payees.length) return fail('this floor module has no payees: nothing is ever owed', { module: s.module })
    const asset = assetArg(s.quote)
    if (asset.toLowerCase() !== s.quote.toLowerCase()) {
      return fail('payees are only ever owed the bound quote: any other asset goes to 0xdead (gang floor distribute --asset)', { asset, boundQuote: s.quote })
    }
    const a = await assetState(asset)
    let index
    if (flag('index')) index = indexArg(opt('index'), s.payees.length, fail)
    else {
      const mine = s.payees.find((p) => p.payee.toLowerCase() === String(me()).toLowerCase())
      const owedSlots = (a.owed ?? []).map((x, i) => (x > 0n ? i : -1)).filter((i) => i >= 0)
      if (mine) index = mine.index
      else if (owedSlots.length === 1) index = owedSlots[0]
      else fail('--index <i> required: which payee slot to pay (gang floor status lists what each is owed)', { owedSlots })
    }
    const owed = a.owed ? a.owed[index] : 0n
    if (owed === 0n) return fail(HINTS.NothingOwed, { asset, symbol: a.symbol, index, payee: s.payees[index].payee })
    let max = maxUint256
    if (flag('max')) max = parseUnits(parseAmount(fail, 'max', opt('max')), a.decimals)
    const amount = owed < max ? owed : max
    return send('release', [asset, BigInt(index), max], {
      step: 'release', asset, symbol: a.symbol, index, payee: s.payees[index].payee, amount: a.f(amount), owed: a.f(owed),
      note: `anyone may: splits what arrived first, then pushes ${max === maxUint256 ? 'all' : 'up to --max'} of what this slot is owed to its payee (it was counted against the cap when it was split; reverts while it still cannot receive). If that split's own push already pays the slot, this reverts NothingOwed and nothing moves: run gang floor distribute ${ref} instead. Gas: ${COMBO_GAS_NOTE}`,
    })
  }

  // set-payee: only the slot's own payee; the index is the wallet's own slot unless given
  if (!s.payees.length) return fail('this floor module has no payees: there is no slot to move', { module: s.module })
  const wallet = String(me()).toLowerCase()
  const mine = s.payees.find((p) => p.payee.toLowerCase() === wallet)
  let index
  if (flag('index')) index = indexArg(opt('index'), s.payees.length, fail)
  else if (mine) index = mine.index
  else return fail('this wallet is not a payee of this floor module: only a slot\'s own payee can move it', { wallet: me(), payees: s.payees.map((p) => p.payee) })
  const slot = s.payees[index]
  if (slot.payee.toLowerCase() !== wallet) return fail(HINTS.NotPayee, { index, payee: slot.payee, wallet: me() })
  const to = opt('to')
  if (!isAddress(to ?? '') || to === zeroAddress) fail('--to <0x…> required (checksummed or all lowercase): the address this slot is paid to from now on', { got: to ?? null })
  if (to.toLowerCase() === s.module.toLowerCase()) return fail(HINTS.BadPayee, { to })
  const taken = s.payees.find((p) => p.payee.toLowerCase() === to.toLowerCase())
  if (taken) return fail(taken.index === index ? 'that is this slot\'s payee already' : HINTS.DuplicatePayee, { to, index: taken.index })
  return send('setPayee', [BigInt(index), getAddress(to)], {
    step: 'set-payee', index, pctOfPayees: slot.pctOfPayees, fromPayee: slot.payee, toPayee: getAddress(to),
    ...(s.cap?.reached && { capReached: true }),
    note: `applies at once; the share (${slot.pctOfPayees}% of the payees' part) stays with the slot, and the cap (for all payees together) stays as it is${s.cap?.reached ? ' — it is reached, so the slot gets nothing more' : ''}. The bound quote that arrived before, and what redemptions set aside, is pushed first to the current address; what this slot is owed goes to the new one. Gas: ${COMBO_GAS_NOTE}`,
  })
}

function indexArg(raw, n, fail) {
  const i = Number(raw)
  if (!Number.isInteger(i) || i < 0 || i >= n) fail(`--index must be a payee slot: the contract's 0-based index, 0 to ${n - 1} (gang floor status lists them)`, { got: raw ?? null })
  return i
}

export { capUnits, DEAD }
