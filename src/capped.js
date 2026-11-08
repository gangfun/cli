import { createPublicClient, parseAbi, encodeFunctionData, formatUnits, getAddress, hexToString, isAddress, maxUint128, maxUint256, parseUnits, zeroAddress } from 'viem'
import { atPad, atTokenPad, GANG_GENS, gangGens, KIND_UNREAD, padNets, NOT_ON_MAINNET, rpcTransport } from './gangpad.js'
import { walletFor } from './fair.js'
import { parseAmount, parseNum, revertOf as revertIn, step } from './steps.js'
import { parseSplitSpec } from './split.js'
import { COMBO_GAS_NOTE, decodeWorkPlan, kindOf } from './combo.js'

/**
 * `gang capped …` and `gang create … --tax-cap <amount> [--tax-cap-share <pct>] [--split <addr>:<pct>,…] [--after-cap buyback:<pct>,lp:<pct>]`
 * — GangCappedSplitter (税收封顶, `capped-v1`): one V3 token's tax recipient whose payees' take has a cap fixed for good.
 * Of each payment of the bound quote, `payBps` (--tax-cap-share) is pushed to 1–10 payees at fixed shares until they have
 * been credited `capAmount` (--tax-cap, in `capQuote`'s own decimals) in all — counted when split, pushed or owed alike; the
 * split that crosses the cap pays exactly what is left of it. The rest, and after the cap all of it, is set aside:
 * `buybackOfRestBps` for buy-back-and-burn, the remainder for liquidity whose LP goes to 0xdead (--after-cap). A copy of
 * GangComboSplitter (combo.js): the chunks, the keeper's `work(minOut)` plan and the pushes are its own.
 * EVERYTHING is fixed when it is cloned (the cap, its quote, the ratios, the payees, their shares); a payee can only move
 * its own slot (`setPayee`), which leaves the cap as it is. `bind` takes only a token quoted in `capQuote` (WrongQuote).
 * Any other asset: `distribute(asset)` sends all of it to 0xdead (left in the module when that transfer fails), never to
 * the payees, so a decoy bind can't route the real token's tax around the cap; payees are owed only the bound quote.
 * `initialize` reverts BadQuote unless the keeper serves capQuote (WBNB, the module's GANG, a QuoteRegistry quote): the
 * launch refuses any other quote before the clone (launch.js untrustedBuybackQuote, the rule of every module).
 * The cap covers only this recipient's part of the pool tax: not the creator's share of the curve fee (gang creator-fee),
 * not the dev's own tokens, not the holders' dividend (COVERAGE_NOTE; docs/SPEC-CAPPED-MODULE-2026-11-08.md §2).
 * GangCappedSplitterFactory clones one for the dev (`create(capQuote, capAmount, payBps, buybackOfRestBps, payees,
 * shares, salt)`, at `predict(dev, salt)`) and has GangHandlerAdmin list it (launch.js: clone → create → bind).
 * Gas: as combo's (COMBO_GAS_NOTE). Env: GANG_CAPPED_FACTORY / GANG_TESTNET_CAPPED_FACTORY (gangpad.js).
 */

// one factory per GangLaunchpad generation: the create target's (GANG_GENS in gangpad.js; null until it is deployed)
export const MAINNET_CAPPED_FACTORY = GANG_GENS.mainnet[0].cappedFactory ?? null
export const TESTNET_CAPPED_FACTORY = GANG_GENS.testnet[0].cappedFactory ?? null
export const CAPPED_TYPE = 'capped-v1'
const BPS = 10_000
const CHUNK_GAP_S = 4 * 60

const ERRORS = [
  'error ZeroAddress()', 'error NotClone()', 'error NotFactory()', 'error AlreadyInitialized()', 'error BadBps()',
  'error BadPayees()', 'error BadShares()', 'error BadPayee()', 'error DuplicatePayee()', 'error BadIndex()',
  'error NotPayee()', 'error AlreadyBound()', 'error NotBound()', 'error NotCurve()', 'error NotCreator()',
  'error NotRecipient()', 'error NothingOwed()', 'error NothingToChunk()', 'error ChunkTooSoon()', 'error NotTradable()',
  'error Slippage()', 'error PushStarved()', 'error BadCap()', 'error WrongQuote()', 'error BadQuote()',
]

export const CAPPED_FACTORY_ABI = parseAbi([
  'function create(address capQuote, uint256 capAmount, uint16 payBps, uint16 buybackOfRestBps, address[] payees, uint16[] shares, bytes32 salt) returns (address module)',
  'function predict(address dev, bytes32 salt) view returns (address)',
  'function pad() view returns (address)',
  'error NotAgent()', 'error WrongHandler()',
  'event Created(address indexed dev, address indexed module, address indexed capQuote, uint256 capAmount, uint16 payBps, uint16 buybackOfRestBps, address[] payees, uint16[] shares)',
  ...ERRORS,
])

export const CAPPED_ABI = parseAbi([
  'function moduleType() view returns (bytes32)',
  'function pad() view returns (address)',
  'function dev() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function pair() view returns (address)',
  'function gangQuote() view returns (address)',
  'function capQuote() view returns (address)',
  'function capAmount() view returns (uint256)',
  'function paidTotal() view returns (uint256)',
  'function payBps() view returns (uint16)',
  'function buybackOfRestBps() view returns (uint16)',
  'function capLeft() view returns (uint256)',
  'function capReached() view returns (bool)',
  'function payeesOf() view returns (address[] payees, uint16[] shares)',
  'function buybackLeft() view returns (uint256)',
  'function lpLeft() view returns (uint256)',
  'function owedOf(address asset, uint256 index) view returns (uint256)',
  'function owedTotal(address asset) view returns (uint256)',
  'function unsplit() view returns (uint256)',
  'function undistributed(address asset) view returns (uint256)',
  'function keeperServes(address q) view returns (bool)',
  'function previewChunk() view returns (bool ready, bool burn, uint256 amount, uint256 tokensOut)',
  'function previewWork() view returns (bool due, uint256 minOut)',
  'function lastChunkAt() view returns (uint64)',
  'function lastPaidAt() view returns (uint64)',
  'function bind(address token)',
  'function split()',
  'function distribute(address asset) returns (uint256 incoming)',
  'function release(address asset, uint256 index, uint256 maxAmount) returns (uint256 amount)',
  'function setPayee(uint256 index, address newPayee)',
  'function chunk(uint256 minTokensOut) returns (bool burn, uint256 quoteIn, uint256 tokensOut, uint256 liquidity)',
  'function work(uint256 minOut)',
  'event Bound(address indexed token, address indexed quote)',
  'event Split(uint256 incoming, uint256 toBuyback, uint256 toLp, uint256 toPayees)',
  'event CapReached(uint256 capAmount)',
  'event Distributed(address indexed asset, uint256 incoming, uint256 toDead)',
  'event PayeeOwed(address indexed asset, uint256 indexed index, uint256 amount)',
  'event PayeeReleased(address indexed asset, uint256 indexed index, uint256 amount)',
  'event PayeeChanged(uint256 indexed index, address indexed oldPayee, address indexed newPayee)',
  'event Shortfall(address indexed asset, uint256 amount)',
  'event BoughtBack(uint256 quoteIn, uint256 burned, uint256 left)',
  'event LiquidityAdded(uint256 quoteIn, uint256 tokensIn, uint256 liquidity, uint256 left)',
  ...ERRORS,
])
/** gang tx decodes these (the factory's Created and the module's events; Split and the rest share combo's topics). */
export const CAPPED_EVENT_ABIS = [CAPPED_FACTORY_ABI, CAPPED_ABI]

const PAD_ABI = parseAbi([
  'function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)',
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
])
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])

/** Gas for a call that moves another asset to 0xdead: one transfer, checked like a push. */
const DEAD_GAS_NOTE = 'let the wallet estimate the gas limit and do not lower it: the transfer to 0xdead needs about 365k gas left before it (a lower limit reverts PushStarved: nothing moves)'

export const HINTS = {
  NotAgent: 'only an Agent can create a V3 token, so only an Agent gets a capped recipient',
  NotFactory: 'this capped factory is not allowed on the platform\'s GangHandlerAdmin: it cannot list a capped recipient as a tax recipient. If GANG_CAPPED_FACTORY / GANG_TESTNET_CAPPED_FACTORY is set, unset or fix it; otherwise launch without --tax-cap',
  BadCap: '--tax-cap must be above 0',
  BadBps: '--tax-cap-share is 0.01–100% of the recipient\'s part, and each --after-cap part 0–100%',
  BadPayees: '1–10 payees (--split), one share each',
  BadShares: 'each payee share at least 0.01% (1 bps) of the payees\' part, all adding up to 100% of it',
  BadPayee: 'a payee cannot be the capped recipient itself',
  DuplicatePayee: 'that address is a payee already (each address holds at most one slot)',
  ZeroAddress: 'the zero address cannot be a payee or the cap\'s quote',
  BadIndex: 'no payee slot with that index (gang capped status lists them, from 0)',
  NotPayee: 'only the current payee of a slot can move it to another address',
  AlreadyBound: 'the capped recipient is bound to a token already',
  NotBound: 'the capped recipient is not bound to a token yet (gang capped bind --token <the token>): nothing is split before that',
  NotCurve: 'not a V3 (curve) token on this pad',
  NotCreator: 'the token was not created by this capped recipient\'s dev',
  NotRecipient: 'the token does not pay its tax to this capped recipient',
  WrongQuote: 'the token\'s quote is not the capped recipient\'s capQuote (the quote its cap is counted in): it can never be bound to this token. A launch with --tax-cap clones it with the launch\'s own quote',
  BadQuote: 'the cap\'s quote must be WBNB, GANG or a quote in the pad\'s QuoteRegistry: a launch with --tax-cap needs one of those as its quote',
  NothingOwed: 'nothing is owed to that slot (payees are only ever owed the bound quote; gang capped status shows what each slot is owed)',
  NothingToChunk: 'nothing is set aside for a buy-back or liquidity chunk yet (buybackLeft / lpLeft): it fills as the tax arrives',
  ChunkTooSoon: 'one chunk (buy-back or liquidity, together) per 4 minutes: wait until 4 minutes after the last one (lastChunkAt)',
  NotTradable: 'the token has not graduated: chunks start once it trades in its PancakeSwap pair',
  Slippage: 'the pool price moved since the preview (fewer tokens than the minimum): run gang capped chunk again',
  PushStarved: `the tx's gas limit was too low for the payee pushes: ${COMBO_GAS_NOTE}`,
}
export const revertOf = (e) => revertIn(e, [CAPPED_ABI, CAPPED_FACTORY_ABI], HINTS)

/** Dry-run a call; { failed } with the revert when it would not pass. */
export async function simulateCapped(client, from, address, abi, functionName, args = []) {
  try {
    const { result } = await client.simulateContract({ account: from, address, abi, functionName, args })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

/** The create target's capped factory (a launch clones its capped recipient there), or null when not deployed. */
export function cappedFactoryAddress(testnet) {
  return gangGens(testnet)[0].cappedFactory || null
}

export const cappedNotDeployed = (testnet) => (testnet
  ? 'GangCappedSplitterFactory (the capped recipient, --tax-cap) is not deployed on the BSC testnet in this CLI version: set GANG_TESTNET_CAPPED_FACTORY to its address, or launch without --tax-cap'
  : 'GangCappedSplitterFactory (the capped recipient, --tax-cap) is not deployed on BSC mainnet in this CLI version: set GANG_CAPPED_FACTORY to its address, or launch without --tax-cap')

export const PERMANENT_NOTE = 'PERMANENT: the cap, its quote, the payees\' %, the buy-back / liquidity split, the payees and their shares are fixed for good — nobody (not you, not the platform) can change them later; a payee can only move its own slot to another address (gang capped set-payee), which leaves the cap as it is'
export const COVERAGE_NOTE = 'The cap covers only this recipient\'s part of the pool tax. It does not cover the creator\'s share of the curve fee (kept on the pad and claimed apart: gang creator-fee), nor the dev\'s own tokens (it is not a lock: the dev can still hold or sell them), nor the holders\' dividend (fixed at the create, the same before and after the cap)'
export const OTHER_ASSETS_NOTE = 'any other asset sent to it (not the token\'s quote) cannot count against the cap: all of it goes to 0xdead when it is distributed (gang capped distribute --asset <addr>, anyone), never to the payees; one that cannot be sent there stays in the module'

// ---- the launch's flags

const PCT_RE = /^(\d{1,3})(?:\.(\d{1,2}))?$/
const pctBps = (raw) => {
  const m = PCT_RE.exec(String(raw ?? '').trim())
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null
}
const AFTER_USAGE = '--after-cap takes buyback:<pct>,lp:<pct>, adding up to 100 (how what the payees don\'t get is split: buy-back and burn / liquidity), e.g. --after-cap buyback:70,lp:30 or --after-cap lp:100; left out: buyback:100'
const CAP_SHARE_USAGE = '--tax-cap-share is the payees\' % of the recipient\'s part until the cap: 0.01 to 100, at most 2 decimals (left out: 100)'
const CAPPED_SPLIT_NOTE = 'with --tax-cap, --split lists the payees of the capped part, their shares adding up to 100 (of that part)'

/** --after-cap → { buybackOfRestBps } or { error, … }. Left out: everything to the buy-back. */
export function parseAfter(raw) {
  if (raw === undefined) return { buybackOfRestBps: BPS }
  const s = String(raw ?? '').trim()
  if (!s || s.startsWith('--')) return { error: AFTER_USAGE, got: raw ?? null }
  const parts = {}
  for (const p of s.split(',').map((x) => x.trim())) {
    const i = p.indexOf(':')
    const key = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase()
    if (i < 0 || !['buyback', 'lp'].includes(key)) return { error: `--after-cap: "${p}" is not buyback:<pct> or lp:<pct>`, hint: AFTER_USAGE }
    if (key in parts) return { error: `--after-cap: ${key} appears twice`, hint: AFTER_USAGE }
    const bps = pctBps(p.slice(i + 1))
    if (bps === null || bps > BPS) return { error: `--after-cap: "${p.slice(i + 1).trim()}" (for ${key}) is not a share in % from 0 to 100 with at most 2 decimals`, hint: AFTER_USAGE }
    parts[key] = bps
  }
  const sum = (parts.buyback ?? 0) + (parts.lp ?? 0)
  if (sum !== BPS) return { error: `--after-cap: the parts add up to ${sum / 100}%, not 100%`, got: raw, hint: AFTER_USAGE }
  return { buybackOfRestBps: parts.buyback ?? 0 }
}

/** --tax-cap-share → { payBps } (1–10,000) or { error }. Left out: 100%. */
export function parseCapShare(raw) {
  if (raw === undefined) return { payBps: BPS }
  const bps = pctBps(raw)
  if (bps === null || bps < 1 || bps > BPS) return { error: CAP_SHARE_USAGE, got: raw ?? null }
  return { payBps: bps }
}

/**
 * --tax-cap's text → its amount in the quote's smallest unit (`decimals`: the quote's own) or { error }. Without
 * `decimals` (the quote not read yet) only its form is checked: { ok: true }.
 */
export function capUnits(text, decimals, symbol) {
  const s = String(text ?? '').trim()
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return { error: '--tax-cap must be a positive amount of the token\'s quote (e.g. 20): the most the payees ever get, in all', got: text ?? null }
  const [whole, frac = ''] = s.split('.')
  if (!/[1-9]/.test(s)) return { error: '--tax-cap must be above 0', got: text }
  // no quote has supply anywhere near this: a figure this long is a typo, and above 2^256 it can't be sent at all
  if (whole.replace(/^0+/, '').length > 30) return { error: '--tax-cap is far too large (more than 30 digits before the point): give the cap in whole units of the quote, e.g. 20', got: text }
  if (decimals == null) return { ok: true }
  if (frac.replace(/0+$/, '').length > decimals) return { error: `--tax-cap: ${symbol ?? 'the quote'} has ${decimals} decimals, ${s} has more`, got: text }
  const amount = parseUnits(s, decimals)
  if (amount === 0n) return { error: '--tax-cap must be above 0', got: text }
  if (amount > maxUint256) return { error: '--tax-cap is far too large for this quote', got: text }
  return { amount }
}

/** A payee's share (bps of the payees' part) as a % of the recipient's whole part, until the cap. */
const ofRecipient = (share, payBps) => Math.round((Number(share) * Number(payBps)) / 1e2) / 1e4

/**
 * A capped launch's flags → { payBps, buybackOfRestBps, payees, shares, list } or { error, … }, checked as
 * GangCappedSplitter.initialize checks them. `capShare` / `split` / `after`: the raw flags (undefined when absent); `me`:
 * the creating wallet (`self`, and the only payee by default). The cap itself needs the quote's decimals: capUnits.
 */
export function parseCappedSpec({ capShare, split, after } = {}, me) {
  const share = parseCapShare(capShare)
  if (share.error) return share
  const rest = parseAfter(after)
  if (rest.error) return rest
  let spec
  if (split === undefined) {
    if (!isAddress(me ?? '')) return { error: 'the capped part goes to your wallet: sign in with baw, or give --from (or name the payees with --split)' }
    spec = { payees: [getAddress(me)], shares: [BPS], list: [{ index: 0, payee: getAddress(me), pct: 100, you: true }] }
  } else {
    spec = parseSplitSpec(split, me)
    if (spec.error) return { ...spec, hint: spec.hint ? `${spec.hint}. ${CAPPED_SPLIT_NOTE}` : CAPPED_SPLIT_NOTE }
  }
  return {
    payBps: share.payBps, buybackOfRestBps: rest.buybackOfRestBps, payees: spec.payees, shares: spec.shares,
    list: spec.list.map(({ pct: p, ...x }) => ({ ...x, pctOfPayees: p, pctOfRecipientUntilCap: ofRecipient(spec.shares[x.index], share.payBps) })),
  }
}

// ---- the contract's math (pure: unit-tested to the wei)

/** _partsOf: how `incoming` of the bound quote splits with `paid` already credited against `capAmount`. */
export function partsOf(incoming, paid, capAmount, payBps, buybackOfRestBps) {
  let toPayees = (BigInt(incoming) * BigInt(payBps)) / 10_000n
  const left = BigInt(capAmount) - BigInt(paid)
  if (toPayees > left) toPayees = left
  const rest = BigInt(incoming) - toPayees
  const toBuyback = (rest * BigInt(buybackOfRestBps)) / 10_000n
  return { toPayees, toBuyback, toLp: rest - toBuyback }
}

/** _payAll: `amount` to the payees at their shares (bps), the others rounded down, the first the rest. */
export function payeeAmounts(amount, shares) {
  if (!shares.length) return []
  const a = shares.map((s) => (BigInt(amount) * BigInt(s)) / 10_000n)
  a[0] = BigInt(amount) - a.slice(1).reduce((x, y) => x + y, 0n)
  return a
}

/** The split as % of the recipient's part, until the cap and after it. */
export function splitPcts(payBps, buybackOfRestBps) {
  const rest = BPS - Number(payBps), bb = Number(buybackOfRestBps)
  const untilBb = ofRecipient(rest, bb)
  return {
    untilCap: { payeesPct: Number(payBps) / 100, buybackPct: untilBb, lpPct: Math.round((rest / 100 - untilBb) * 1e4) / 1e4 },
    afterCap: { payeesPct: 0, buybackPct: bb / 100, lpPct: (BPS - bb) / 100 },
  }
}

const fmtNum = (n) => n.toLocaleString('en-US', { maximumSignificantDigits: 4 })

/**
 * Roughly how much pool volume reaches the cap (spec §1): cap / ((tax − platform tax) × (1 − dividend) × pay share), in
 * the quote. Buys pay the buy tax and sells the sell tax: different rates give a range. null when nothing goes to payees.
 */
export function capVolume({ capAmount, decimals, symbol, buyTaxPct, sellTaxPct, platformTaxPct = 0.5, dividendPct = 0, payBps }) {
  const cap = Number(formatUnits(BigInt(capAmount), decimals))
  const at = (tax) => {
    const f = ((tax - platformTaxPct) / 100) * (1 - dividendPct / 100) * (Number(payBps) / BPS)
    return f > 0 ? cap / f : null
  }
  const hi = Math.max(buyTaxPct, sellTaxPct), lo = Math.min(buyTaxPct, sellTaxPct)
  const [few, many] = [at(hi), at(lo)]
  if (few === null || many === null) return null
  const sym = symbol ?? 'of the quote'
  const how = `cap / ((tax − ${platformTaxPct}% platform) × (1 − ${dividendPct}% dividend) × ${Number(payBps) / 100}% to the payees). An estimate: the tax arrives in chunks sold for the quote, and the cap comes sooner while the holders' part falls back to the recipient (no holder with 10,000+ tokens)`
  return hi === lo
    ? { poolVolume: `about ${fmtNum(few)} ${sym}`, how }
    : { poolVolume: `about ${fmtNum(few)} ${sym} (every trade at the ${hi}% tax) to ${fmtNum(many)} ${sym} (every trade at ${lo}%)`, how }
}

/** The capped split as one line, for a launch preview and a re-run's refusal. */
export function cappedLine({ cap, symbol, payBps, buybackOfRestBps, payees, shares }) {
  const p = splitPcts(payBps, buybackOfRestBps)
  const after = `${p.afterCap.buybackPct}% buy-back and burn, ${p.afterCap.lpPct}% liquidity (LP to 0xdead)`
  const who = payees.map((x, i) => `${x}: ${Number(shares[i]) / 100}% of it`).join(', ')
  const until = Number(payBps) === BPS ? `all of it to ${who}` : `${p.untilCap.payeesPct}% to ${who}; the rest ${after}`
  return `until the payees have been credited ${cap} ${symbol ?? 'of the quote'} in all: ${until}. From then on all of it: ${after}`
}

/** What the capped recipient does with each part, and with any other asset (the preview and status note). */
export function cappedParts(payBps, buybackOfRestBps) {
  const p = splitPcts(payBps, buybackOfRestBps)
  return {
    untilCap: `${p.untilCap.payeesPct}% of each tax payment to this recipient (in the token's quote) is pushed to the payees at their shares (the first also takes the rounding dust) until they have been credited the cap in all (pushed or owed alike); the split that crosses it pays exactly what is left of it`,
    rest: `the rest, and once the cap is reached all of it, is set aside: ${p.afterCap.buybackPct}% of it bought back in the PancakeSwap pair and the tokens burned (0xdead), ${p.afterCap.lpPct}% added to the pair as liquidity (half buys the token, all of it goes back in with the matching quote), the LP sent to 0xdead (locked for good)`,
    chunks: 'after graduation, one chunk per 4 minutes for both kinds together (always the larger set-aside part), at most 0.5% of the pair\'s quote reserve, none while the price is more than 2% above its 10-minute average',
    otherAssets: OTHER_ASSETS_NOTE,
  }
}

const iso = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null)

/**
 * The module's state for printing, from the raw reads (pure: unit-tested). `raw`: { module, dev, token, quote, capQuote,
 * capSymbol, capDecimals, capAmount, paidTotal, payBps, buybackOfRestBps, payees, shares, buybackLeft, lpLeft, unsplit,
 * lastChunkAt, lastPaidAt, keeperServesQuote, preview: [ready, burn, amount, tokensOut] | null, work: [due, minOut] | null,
 * graduated: bool | null, assets: [{ asset, symbol, decimals, undistributed, owedTotal, owed: bigint[] | null }], now }.
 * Quote amounts are in the cap quote's decimals (bind takes only that quote), tokens in 18. `ref`: how later commands
 * name it (e.g. `--token 0x… --testnet`).
 */
export function formatCapped(raw, ref) {
  const token = raw.token && raw.token !== zeroAddress ? raw.token : null
  const quote = token && raw.quote && raw.quote !== zeroAddress ? raw.quote : null
  const isQuote = (a) => !!quote && a.toLowerCase() === quote.toLowerCase()
  const dec = raw.capDecimals ?? 18
  const fq = (x) => formatUnits(BigInt(x ?? 0n), dec)
  const payBps = Number(raw.payBps), bbBps = Number(raw.buybackOfRestBps)
  const capAmount = BigInt(raw.capAmount), paid = BigInt(raw.paidTotal)
  const left = capAmount - paid
  const reached = left <= 0n
  const progressPct = capAmount > 0n ? Number((paid * 10_000n) / capAmount) / 100 : 0
  const dev = String(raw.dev).toLowerCase()
  const payees = raw.payees.map((payee, index) => ({
    index, payee, pctOfPayees: Number(raw.shares[index]) / 100, pctOfRecipientUntilCap: ofRecipient(raw.shares[index], payBps),
    bps: Number(raw.shares[index]), ...(payee.toLowerCase() === dev && { isDev: true }),
  }))
  const now = Number(raw.now ?? Math.floor(Date.now() / 1000))
  const last = Number(raw.lastChunkAt ?? 0n)

  // the waiting quote once split (as the contract's _afterSplit, without a shortfall)
  const unsplit = BigInt(raw.unsplit ?? 0n)
  const pending = partsOf(unsplit, paid, capAmount, payBps, bbBps)
  const bbAfter = BigInt(raw.buybackLeft) + pending.toBuyback, lpAfter = BigInt(raw.lpLeft) + pending.toLp
  const kind = kindOf(bbAfter, lpAfter)
  const [ready, burn, amount, tokensOut] = raw.preview ?? [false, false, 0n, 0n]
  let waiting = null
  if (!ready) {
    waiting = !token ? 'not bound to a token yet (gang capped bind --token <the token>)'
      : raw.graduated === false ? 'the token has not graduated: chunks start once it trades in its PancakeSwap pair (the pool tax starts then too)'
        : !kind ? 'nothing set aside for a buy-back or liquidity chunk yet: it fills as the tax arrives'
          : last > 0 && now < last + CHUNK_GAP_S ? `one chunk per 4 minutes (both kinds together): the next from ${iso(last + CHUNK_GAP_S)}`
            : 'the price check: a 10-minute average of the pair\'s price (the next call records it, if none is running) and a price no more than 2% above it'
  }
  const nextChunk = ready
    ? burn
      ? { kind: 'buy-back', quoteIn: fq(amount), tokensBurned: formatUnits(tokensOut, 18) }
      : { kind: 'liquidity', quoteChunk: fq(amount), buyHalf: fq(BigInt(amount) / 2n), tokensBought: formatUnits(tokensOut, 18) }
    : { kind, ready: false }

  const next = []
  const assets = []
  for (const a of raw.assets ?? []) {
    const owedTotal = a.owedTotal ?? 0n
    const undistributed = a.undistributed ?? 0n
    if (!isQuote(a.asset) && undistributed === 0n && owedTotal === 0n) continue
    const f = (x) => formatUnits(x, a.decimals ?? 18)
    const owed = owedTotal > 0n && a.owed
      ? a.owed.map((x, index) => ({ index, payee: raw.payees[index], amount: f(x) })).filter((_, i) => a.owed[i] > 0n) : []
    const byKeeper = isQuote(a.asset) && raw.keeperServesQuote
    // unlike combo-v1, distributing another asset burns it: say so wherever the command is offered
    const burns = !!token && !isQuote(a.asset) && undistributed > 0n
    assets.push({
      asset: a.asset, symbol: a.symbol ?? null, ...(isQuote(a.asset) && { boundQuote: true }),
      undistributed: f(undistributed), owedTotal: f(owedTotal), ...(owed.length && { owed }),
      splitBy: !token ? 'nobody until bound (distribute reverts NotBound)'
        : byKeeper ? 'the keeper (the quote is one it serves) or anyone: gang capped distribute'
          : isQuote(a.asset) ? 'hand: gang capped distribute (anyone)'
            : 'hand: gang capped distribute (anyone): all of it to 0xdead, never to the payees',
      ...(burns && { burns: true }),
    })
    if (token && undistributed > 0n && !byKeeper) {
      next.push(burns
        ? `gang capped distribute ${ref} --asset ${a.asset} (BURNS all of it: sends it to 0xdead, paid to nobody; only if that is wanted)`
        : `gang capped distribute ${ref} --asset ${a.asset}`)
    }
    for (const o of owed) next.push(`gang capped release ${ref} --asset ${a.asset} --index ${o.index}`)
  }
  if (!token) next.unshift(String(ref ?? '').startsWith('--token ') ? `gang capped bind ${ref}` : 'gang capped bind --token <the token>')
  if (ready) next.push(`gang capped chunk ${ref}`)

  const sym = (assets.find((x) => x.boundQuote)?.symbol) || raw.capSymbol || raw.capQuote
  const distribution = !token ? 'unbound' : raw.keeperServesQuote ? 'keeper' : 'manual'
  const keeperLine = distribution === 'unbound'
    ? 'Not bound to a token yet: nothing is split, paid, bought back or added until gang capped bind --token <the token>'
    : distribution === 'keeper'
      ? `The quote (${sym}) is one the keeper serves: where the keeper runs capped-v1 it does the chunks${reached ? '' : ' and pays the payees (once their part reaches 0.05% of the pair\'s quote reserve, or after a day once it reaches 1/100 of that)'}; anyone can do it at any time (gang capped chunk / gang capped distribute)`
      : `The keeper does not serve this quote (${sym}): everything is manual — gang capped chunk and gang capped distribute (anyone)`
  const capLine = reached
    ? `The cap is reached: the payees were credited ${fq(capAmount)} ${sym} in all, and every payment now goes to the buy-back and liquidity`
    : `${fq(paid)} of the ${fq(capAmount)} ${sym} cap credited to the payees so far (${progressPct}%), ${fq(left)} left`
  const [due, minOut] = raw.work ?? [false, 0n]
  const crosses = !reached && unsplit > 0n && pending.toPayees === left
  return {
    module: raw.module, moduleType: CAPPED_TYPE, dev: raw.dev, token, quote, ...(quote && sym && { quoteSymbol: sym }),
    cap: {
      quote: raw.capQuote, symbol: raw.capSymbol ?? null, decimals: dec, amount: fq(capAmount), paid: fq(paid), left: fq(left),
      progressPct, reached, ...(raw.capDecimalsUnread && { decimalsNote: 'the quote\'s decimals could not be read: amounts assume 18' }),
    },
    payPct: payBps / 100, payBps, buybackOfRestBps: bbBps, split: { ...splitPcts(payBps, bbBps), now: reached ? 'afterCap' : 'untilCap' },
    permanent: true, payees,
    buybackLeft: fq(raw.buybackLeft), lpLeft: fq(raw.lpLeft), unsplit: fq(unsplit),
    ...(unsplit > 0n && { unsplitGoes: { toPayees: fq(pending.toPayees), toBuyback: fq(pending.toBuyback), toLp: fq(pending.toLp), ...(crosses && { reachesCap: true }) } }),
    nextChunk, ...(waiting && { nextChunkWaitsFor: waiting }),
    lastChunkAt: iso(last), lastPaidAt: iso(raw.lastPaidAt ?? 0n),
    distribution,
    keeper: {
      servesQuote: token ? !!raw.keeperServesQuote : null, due: !!due,
      ...(due && { plan: decodeWorkPlan(minOut) }),
    },
    assets,
    ...(next.length && { next }),
    parts: cappedParts(payBps, bbBps),
    covers: COVERAGE_NOTE,
    note: `${PERMANENT_NOTE}. ${capLine}. ${keeperLine}. A failed payee push is owed to that slot (it counts against the cap already) and paid with its next push, or by gang capped release`,
  }
}

/** Reads `asset`'s side of the module; null when it is not an ERC20 the module can read. */
async function assetRaw(read, module, asset, n) {
  let undistributed, owedTotal
  try {
    [undistributed, owedTotal] = await Promise.all([
      read(module, CAPPED_ABI, 'undistributed', [asset]), read(module, CAPPED_ABI, 'owedTotal', [asset]),
    ])
  } catch { return null }
  const [symbol, decimals, owed] = await Promise.all([
    read(asset, ERC20_ABI, 'symbol').catch(() => null),
    read(asset, ERC20_ABI, 'decimals').then(Number).catch(() => 18),
    owedTotal > 0n ? Promise.all(Array.from({ length: n }, (_, i) => read(module, CAPPED_ABI, 'owedOf', [asset, BigInt(i)]))) : null,
  ])
  return { asset, symbol, decimals, undistributed, owedTotal, owed }
}

/** The quote's symbol and decimals (its own, never assumed); decimals null when unread. */
export async function quoteUnits(read, quote) {
  const [symbol, decimals] = await Promise.all([
    read(quote, ERC20_ABI, 'symbol').catch(() => null),
    read(quote, ERC20_ABI, 'decimals').then(Number).catch(() => null),
  ])
  return { symbol, decimals }
}

/**
 * The module's state when `addr` is a GangCappedSplitter (capped-v1); null when it is not. Assets read: the bound quote,
 * the cap's quote, WBNB, the module's GANG and `extraAssets` (e.g. the quote of a token paying it that is not the bound
 * one). `pad`: to read graduation.
 */
export async function cappedOf(read, addr, { wbnb, pad, extraAssets = [], ref } = {}) {
  if (!addr || addr === zeroAddress) return null
  let type
  try { type = await read(addr, CAPPED_ABI, 'moduleType') } catch { return null }
  if (hexToString(type, { size: 32 }).replace(/\0+$/, '') !== CAPPED_TYPE) return null
  const FIELDS = ['dev', 'token', 'quote', 'capQuote', 'capAmount', 'paidTotal', 'payBps', 'buybackOfRestBps', 'payeesOf', 'buybackLeft', 'lpLeft', 'unsplit', 'lastChunkAt', 'lastPaidAt']
  const [vals, gangQuote] = await Promise.all([
    Promise.all(FIELDS.map((f) => read(addr, CAPPED_ABI, f))),
    read(addr, CAPPED_ABI, 'gangQuote').catch(() => zeroAddress),
  ])
  const r = Object.fromEntries(FIELDS.map((f, i) => [f, vals[i]]))
  const [payees, shares] = r.payeesOf
  const bound = r.token !== zeroAddress
  const [preview, work, keeperServesQuote, graduated, units] = await Promise.all([
    bound ? read(addr, CAPPED_ABI, 'previewChunk').catch(() => null) : null,
    bound ? read(addr, CAPPED_ABI, 'previewWork').catch(() => null) : null,
    bound ? read(addr, CAPPED_ABI, 'keeperServes', [r.quote]).catch(() => false) : false,
    bound && pad ? read(pad, PAD_ABI, 'curves', [r.token]).then((c) => c[6]).catch(() => null) : null,
    quoteUnits(read, r.capQuote),
  ])
  const seen = new Set()
  const list = [r.quote, r.capQuote, wbnb, gangQuote, ...extraAssets].filter((a) => {
    if (!a || a === zeroAddress || seen.has(a.toLowerCase())) return false
    seen.add(a.toLowerCase())
    return true
  })
  const assets = (await Promise.all(list.map((a) => assetRaw(read, addr, a, payees.length)))).filter(Boolean)
  return formatCapped({
    module: addr, dev: r.dev, token: r.token, quote: r.quote, capQuote: r.capQuote, capSymbol: units.symbol,
    capDecimals: units.decimals ?? 18, ...(units.decimals === null && { capDecimalsUnread: true }),
    capAmount: r.capAmount, paidTotal: r.paidTotal, payBps: r.payBps, buybackOfRestBps: r.buybackOfRestBps, payees, shares,
    buybackLeft: r.buybackLeft, lpLeft: r.lpLeft, unsplit: r.unsplit, lastChunkAt: r.lastChunkAt, lastPaidAt: r.lastPaidAt,
    keeperServesQuote, preview, work, graduated, assets,
  }, ref ?? (bound ? `--token ${r.token}` : `--module ${addr}`))
}

/**
 * When `token` pays its tax to the capped recipient but the module is bound to another token (a decoy bind): what to say.
 * The same quote is split under the one cap, its buy-backs going to the other pair; another quote is all burned.
 */
export function decoyWarning(s, token, tokenQuote, ref) {
  if (!token || !s.token || s.token.toLowerCase() === token.toLowerCase()) return null
  const sameQuote = !!tokenQuote && !!s.quote && tokenQuote.toLowerCase() === s.quote.toLowerCase()
  return sameQuote
    ? `this token pays its tax to the capped recipient, but it is bound to another token (${s.token}): this token's tax, in the same quote, is split with that token's under the one cap, and its buy-backs and liquidity go to that token's pair, not this one's`
    : `this token pays its tax to the capped recipient, but it is bound to another token (${s.token}): this token's tax (${tokenQuote ?? 'its quote'}) is not the bound quote, so it never reaches the payees, the buy-back or the liquidity — all of it goes to 0xdead (gang capped distribute ${ref} --asset ${tokenQuote ?? '<its quote>'})`
}

function cappedCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const SUBS = ['status', 'distribute', 'release', 'set-payee', 'bind', 'chunk']
const USAGE = 'usage: gang capped <status|distribute|release|set-payee|bind|chunk> --token <addr> (or --module <addr>) [--asset <addr>|wbnb] [--index <i>] [--to <addr>] [--max <amount>] [--slippage 1] [--testnet] — see gang help'

/** `gang capped <sub>`: the capped recipient of a V3 token (its tax recipient), found from --token (or named by --module). */
export async function runCapped(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const rawOnly = flag('calldata')
  let ctx
  try { ctx = cappedCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)
  const tn = testnet ? ' --testnet' : ''
  if (flag('token') && flag('module')) fail('give --token (its tax recipient is the capped recipient) or --module, not both')
  let token = null, module, tokenQuote = null, padKnown = true
  if (flag('module')) {
    if (sub === 'bind') fail('gang capped bind needs --token <the token> (it binds the token\'s own recipient)')
    module = opt('module')
    if (!isAddress(module ?? '')) fail('--module must be a capped recipient address (0x…)', { got: module ?? null })
    // the module's own generation: any other pad answers curves() of its token with zeros, which reads as "not graduated"
    const pad = await ctx.read(module, CAPPED_ABI, 'pad').catch(() => null)
    padKnown = !!pad && atPad(ctx, pad, testnet)
  } else {
    token = opt('token')
    if (!isAddress(token ?? '')) fail('--token must be a V3 token address (0x…), or name the module with --module <addr>', { got: token ?? null })
    if ((await atTokenPad(ctx, token)) === null) return fail(KIND_UNREAD.error, { token, retry: KIND_UNREAD.retry }) // else on the pad of the token's generation
    try {
      const [creator, quote] = await ctx.read(ctx.pad, PAD_ABI, 'curves', [token])
      if (creator === zeroAddress) throw new Error('not a curve')
      tokenQuote = quote
      module = (await ctx.read(ctx.pad, PAD_ABI, 'taxConfigOf', [token]))[3]
    } catch {
      return fail(`not a V3 token on this pad (${testnet ? 'BSC testnet' : 'BSC mainnet; add --testnet for a testnet token'})`, { token, chainId })
    }
  }
  const ref = `${token ? `--token ${token}` : `--module ${module}`}${tn}`
  // status --asset <addr>: read that asset too (a stray one the default list doesn't cover)
  const extra = sub === 'status' && flag('asset') && isAddress(opt('asset') ?? '') ? [getAddress(opt('asset'))] : []
  const s = await cappedOf(ctx.read, module, {
    wbnb: ctx.wbnb, pad: padKnown ? ctx.pad : null, extraAssets: [...(tokenQuote && tokenQuote !== zeroAddress ? [tokenQuote] : []), ...extra], ref,
  })
  if (!s) {
    return fail(token ? 'this token\'s tax recipient is not a capped recipient (capped-v1)' : 'not a capped recipient (capped-v1)',
      { ...(token && { token }), recipient: module === zeroAddress ? null : module })
  }
  const warning = decoyWarning(s, token, tokenQuote, ref)
  const me = () => walletFor(ctx, opt('from'))
  const send = async (functionName, args, extra) => {
    const sim = await simulateCapped(ctx.client, me(), s.module, CAPPED_ABI, functionName, args)
    if (sim.failed) return out({ success: false, step: extra.step, ...sim.failed, ...(warning && { warning }) })
    const data = encodeFunctionData({ abi: CAPPED_ABI, functionName, args })
    // no gas field: the wallet / node estimates it (COMBO_GAS_NOTE)
    return out(step(ctx, { from: me(), to: s.module, data }, { chainId, ...(token && { token }), module: s.module, ...extra, ...(warning && { warning }) }, rawOnly, summarize))
  }
  const assetArg = (def) => {
    if (!flag('asset')) return def
    const a = opt('asset')
    if (/^wbnb$/i.test(a ?? '')) return ctx.wbnb
    if (!isAddress(a ?? '') || a === zeroAddress) fail('--asset must be a token address (0x…, checksummed or all lowercase) or wbnb', { got: a ?? null })
    return getAddress(a)
  }
  const assetState = async (asset) => {
    const known = s.assets.find((x) => x.asset.toLowerCase() === asset.toLowerCase())
    const r = await assetRaw(ctx.read, s.module, asset, s.payees.length)
    if (!r) fail('the module cannot read that asset\'s balance (not an ERC20?)', { asset })
    return { ...r, symbol: r.symbol ?? known?.symbol ?? null, f: (x) => formatUnits(x, r.decimals) }
  }
  const needBound = () => {
    if (!s.token) fail(HINTS.NotBound, { module: s.module, ...(token && { next: `gang capped bind --token ${token}${tn}` }) })
  }
  const fq = (x) => formatUnits(x, s.cap.decimals)
  const sym = s.quoteSymbol ?? s.cap.symbol ?? 'of the quote'

  if (sub === 'status') return out({ success: true, chainId, ...s, ...(s.token === null && { bound: false }), ...(warning && { warning }) })

  if (sub === 'bind') {
    if (s.token) return fail('already bound', { boundTo: s.token, ...(warning && { warning }) })
    if (tokenQuote && tokenQuote.toLowerCase() !== String(s.cap.quote).toLowerCase()) {
      return fail(HINTS.WrongQuote, { token, tokenQuote, capQuote: s.cap.quote })
    }
    return send('bind', [token], { step: 'bind', note: `anyone may bind (once); the token must be the dev's, pay its tax to this module and be quoted in the cap's quote (${s.cap.symbol ?? s.cap.quote}). It decides which pair the buy-backs and liquidity go to` })
  }

  if (sub === 'distribute') {
    needBound()
    const asset = assetArg(s.quote)
    const a = await assetState(asset)
    if (a.undistributed === 0n) {
      return fail('nothing of this asset is waiting to be split', {
        asset, symbol: a.symbol, owedTotal: a.f(a.owedTotal),
        ...(a.owedTotal > 0n && { hint: `what is held is owed to payees after failed pushes: gang capped release ${ref} --index <i>` }),
      })
    }
    if (asset.toLowerCase() === s.quote.toLowerCase()) {
      // the split as the contract makes it: the payees' part capped by what is left of the cap
      const [paid, capAmount] = await Promise.all([ctx.read(s.module, CAPPED_ABI, 'paidTotal'), ctx.read(s.module, CAPPED_ABI, 'capAmount')])
      const p = partsOf(a.undistributed, paid, capAmount, s.payBps, s.buybackOfRestBps)
      const reachesCap = paid < capAmount && paid + p.toPayees === capAmount
      const amounts = payeeAmounts(p.toPayees, s.payees.map((x) => x.bps))
      return send('distribute', [asset], {
        step: 'distribute', asset, symbol: a.symbol, boundQuote: true, amount: fq(a.undistributed),
        toPayees: fq(p.toPayees), toBuyback: fq(p.toBuyback), toLp: fq(p.toLp),
        parts: s.payees.map((x, i) => ({ index: x.index, payee: x.payee, pctOfPayees: x.pctOfPayees, gets: fq(amounts[i]) })),
        cap: { amount: fq(capAmount), paidBefore: fq(paid), paidAfter: fq(paid + p.toPayees), leftAfter: fq(capAmount - paid - p.toPayees), ...(reachesCap && { reachesCap: true }) },
        note: `anyone may: splits the bound quote that arrived (as split()): ${s.payPct}% to the payees, but never more than what is left of the cap (${fq(capAmount - paid)} ${sym}), pushed now; the rest set aside, ${s.split.afterCap.buybackPct}% of it for buy-back and ${s.split.afterCap.lpPct}% for liquidity${reachesCap ? '. This split reaches the cap: from then on all of it goes to the buy-back and liquidity' : paid >= capAmount ? ' (the cap is reached: nothing goes to the payees)' : ''}; a push that fails is owed to that slot and counts against the cap. Gas: ${COMBO_GAS_NOTE}`,
      })
    }
    return send('distribute', [asset], {
      step: 'distribute', asset, symbol: a.symbol, amount: a.f(a.undistributed), toDead: a.f(a.undistributed), toPayees: a.f(0n),
      note: `anyone may: this is not the bound quote, so it cannot count against the cap: all of it goes to 0xdead, none to the payees (when it cannot be sent there it stays in the module). Gas: ${DEAD_GAS_NOTE}`,
    })
  }

  if (sub === 'release') {
    needBound()
    const asset = assetArg(s.quote)
    if (asset.toLowerCase() !== s.quote.toLowerCase()) {
      return fail('payees are only ever owed the bound quote: any other asset goes to 0xdead, never to a payee (gang capped distribute --asset)', { asset, boundQuote: s.quote })
    }
    const a = await assetState(asset)
    let index
    if (flag('index')) index = indexArg(opt('index'), s.payees.length, fail)
    else {
      const mine = s.payees.find((p) => p.payee.toLowerCase() === String(me()).toLowerCase())
      const owedSlots = (a.owed ?? []).map((x, i) => (x > 0n ? i : -1)).filter((i) => i >= 0)
      if (mine) index = mine.index
      else if (owedSlots.length === 1) index = owedSlots[0]
      else fail('--index <i> required: which payee slot to pay (gang capped status lists what each is owed)', { owedSlots })
    }
    const owed = a.owed ? a.owed[index] : 0n
    if (owed === 0n) return fail(HINTS.NothingOwed, { asset, symbol: a.symbol, index, payee: s.payees[index].payee })
    let max = maxUint256
    if (flag('max')) max = parseUnits(parseAmount(fail, 'max', opt('max')), a.decimals)
    const amount = owed < max ? owed : max
    return send('release', [asset, BigInt(index), max], {
      step: 'release', asset, symbol: a.symbol, index, payee: s.payees[index].payee, amount: a.f(amount), owed: a.f(owed),
      note: `anyone may: splits what newly arrived of the bound quote first, then pushes ${max === maxUint256 ? 'all' : 'up to --max'} of what this slot is owed to its payee (it was counted against the cap when it was split; reverts while it still cannot receive; nothing owed is lost). Gas: ${COMBO_GAS_NOTE}`,
    })
  }

  if (sub === 'chunk') {
    needBound()
    const slippage = parseNum(fail, 'slippage', opt('slippage', '1'), 0, 50)
    const [ready, burn, amount, tokensOut] = await ctx.read(s.module, CAPPED_ABI, 'previewChunk')
    if (ready) {
      // previewChunk prices the buy (a liquidity chunk: its half) after the buy tax; the contract scales the minimum
      // down when the pair got less
      const minOut = (tokensOut * BigInt(Math.round((100 - slippage) * 100))) / 10_000n
      return send('chunk', [minOut], burn
        ? {
            step: 'chunk', kind: 'buy-back', quoteIn: fq(amount), expectTokensBurned: formatUnits(tokensOut, 18),
            minTokens: formatUnits(minOut, 18), slippagePct: slippage, buybackLeft: s.buybackLeft, lpLeft: s.lpLeft,
            note: `anyone may: splits what arrived, then one buy-back chunk (the larger set-aside part): buys the token in the pair and burns it at 0xdead (gang tx shows BoughtBack). The keeper does the same every few minutes. Gas: ${COMBO_GAS_NOTE}`,
          }
        : {
            step: 'chunk', kind: 'liquidity', quoteChunk: fq(amount), buyHalf: fq(amount / 2n), expectTokensBought: formatUnits(tokensOut, 18),
            minTokens: formatUnits(minOut, 18), slippagePct: slippage, buybackLeft: s.buybackLeft, lpLeft: s.lpLeft,
            note: `anyone may: splits what arrived, then one liquidity chunk (the larger set-aside part): half buys the token, all of it goes back into the pair with the matching quote, the LP to 0xdead (gang tx shows LiquidityAdded). The keeper does the same every few minutes. Gas: ${COMBO_GAS_NOTE}`,
          })
    }
    // not ready: only a call that records the price observation can pass; a minimum no chunk can meet makes it revert
    // (Slippage) rather than trade unchecked if a chunk became possible before it lands
    const sim = await simulateCapped(ctx.client, me(), s.module, CAPPED_ABI, 'chunk', [maxUint128])
    if (sim.failed) return out({ success: false, step: 'chunk', ...sim.failed, ...(s.nextChunkWaitsFor && { waitsFor: s.nextChunkWaitsFor }), buybackLeft: s.buybackLeft, lpLeft: s.lpLeft, ...(warning && { warning }) })
    return send('chunk', [maxUint128], {
      step: 'record-price', trades: false, waitsFor: s.nextChunkWaitsFor,
      note: 'no chunk this time: the call splits what arrived and records the pair\'s price observation (or waits for the 10-minute average / a price no more than 2% above it). The keeper calls it too. If a chunk becomes possible before it lands, it reverts (Slippage) rather than trade without a minimum: run gang capped chunk again then, about 10 minutes after the first observation',
    })
  }

  // set-payee: only the slot's own payee; the index is the wallet's own slot unless given. Unlike combo-v1 nothing else
  // needs distributing first: other assets never go to payees, and the contract splits the bound quote before the move
  const wallet = String(me()).toLowerCase()
  const mine = s.payees.find((p) => p.payee.toLowerCase() === wallet)
  let index
  if (flag('index')) index = indexArg(opt('index'), s.payees.length, fail)
  else if (mine) index = mine.index
  else return fail('this wallet is not a payee of this capped recipient: only a slot\'s own payee can move it', { wallet: me(), payees: s.payees.map((p) => p.payee) })
  const slot = s.payees[index]
  if (slot.payee.toLowerCase() !== wallet) return fail(HINTS.NotPayee, { index, payee: slot.payee, wallet: me() })
  const to = opt('to')
  if (!isAddress(to ?? '') || to === zeroAddress) fail('--to <0x…> required (checksummed or all lowercase): the address this slot is paid to from now on', { got: to ?? null })
  if (to.toLowerCase() === s.module.toLowerCase()) return fail(HINTS.BadPayee, { to })
  const taken = s.payees.find((p) => p.payee.toLowerCase() === to.toLowerCase())
  if (taken) return fail(taken.index === index ? 'that is this slot\'s payee already' : HINTS.DuplicatePayee, { to, index: taken.index })
  return send('setPayee', [BigInt(index), getAddress(to)], {
    step: 'set-payee', index, pctOfPayees: slot.pctOfPayees, fromPayee: slot.payee, toPayee: getAddress(to),
    ...(s.cap.reached && { capReached: true }),
    note: `applies at once; the share (${slot.pctOfPayees}% of the payees' part) stays with the slot, and the cap (for all payees together) stays as it is${s.cap.reached ? ' — it is reached, so the slot gets nothing more' : ''}. The bound quote that arrived before is split first (to the current address); what this slot is owed goes to the new one. Gas: ${COMBO_GAS_NOTE}`,
  })
}

function indexArg(raw, n, fail) {
  const i = Number(raw)
  if (!Number.isInteger(i) || i < 0 || i >= n) fail(`--index must be a payee slot: the contract's 0-based index, 0 to ${n - 1} (gang capped status lists them)`, { got: raw ?? null })
  return i
}
