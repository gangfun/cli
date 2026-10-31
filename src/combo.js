import { createPublicClient, parseAbi, encodeFunctionData, formatUnits, getAddress, hexToString, isAddress, maxUint128, maxUint256, parseUnits, zeroAddress } from 'viem'
import { padNets, NOT_ON_MAINNET, rpcTransport } from './gangpad.js'
import { walletFor } from './fair.js'
import { parseAmount, parseNum, revertOf as revertIn, step } from './steps.js'
import { parseSplitSpec } from './split.js'

/**
 * `gang combo …` and `gang create … --buyback <pct> --lp <pct> [--split <addr>:<pct>,…]` (any two or three of them) —
 * GangComboSplitter (组合：回购 + 加池 + 分账, `combo-v1`): one V3 token's tax recipient that does what the three
 * single-purpose modules do, at once. Of each payment of the bound quote, `buybackBps` is set aside for buy-back-and-burn
 * (GangBuybackSplitter v4's chunk), `lpBps` for liquidity whose LP goes to 0xdead (GangLiquiditySplitter's chunk), and the
 * rest is pushed to 1–10 payees at fixed shares (GangSplitModule's push; none when buy-back + LP = 100%).
 * EVERYTHING is fixed when it is cloned: nobody (not the dev, not the platform) can change the ratios, the payees or their
 * shares — unlike a lone buy-back / LP splitter, whose dev can change its ratio. A payee can only move its own slot
 * (`setPayee`). GangComboSplitterFactory clones one for the dev (`create(buybackBps, lpBps, payees, shares, salt)`, at
 * `predict(dev, salt)`) and has GangHandlerAdmin list it, so the dev names it as the recipient at create (launch.js does
 * the three steps: clone → create → bind, as for --buyback / --split / --lp).
 * Chunks: one per 4 minutes for both kinds together, always of the larger set-aside part (`chunk`), ≤ 0.5% of the pair's
 * quote reserve, none while the price is > 2% above the pair's 10-minute average. The keeper's `work(minOut)` does the one
 * action `previewWork` planned, encoded in minOut's top byte (1 buy-back, 2 liquidity, 3 price observation, 4 split).
 * Any other asset: the buy-back + LP share goes to 0xdead, the rest to the payees (`distribute(asset)`; NotBound before
 * `bind`).
 * Gas: a chunk takes ~0.55–0.75M, and a split pushes up to 10 payees, each needing ~365k gas left before it. The CLI never
 * sets a gas limit: the wallet / node estimates it; a lower one reverts PushStarved (nothing moves) or the chunk.
 * Env: GANG_COMBO_FACTORY / GANG_TESTNET_COMBO_FACTORY override the built-in factory addresses.
 */

// BSC 56: deployed 2026-10-31 (pad 0x15CF…4365); a clone reverts NotFactory until the platform's Safe allows the
// factory on GangHandlerAdmin
export const MAINNET_COMBO_FACTORY = '0xd33C38BE3f8472b3013167830F0638C1704e1DBd'
// BSC 97, set 10
export const TESTNET_COMBO_FACTORY = '0x52a8f90a92E5C1828b4436a0B99C6b293f7F4CFE'
export const COMBO_TYPE = 'combo-v1'
export const MAX_PAYEES = 10
const BPS = 10_000
const CHUNK_GAP_S = 4 * 60

/** previewWork's planned action, minOut's top byte (GangComboSplitter DO_*). */
export const WORK_ACTIONS = { 0: 'none', 1: 'buy-back', 2: 'liquidity', 3: 'observe', 4: 'split' }
const WORK_WHAT = {
  none: 'nothing to do',
  'buy-back': 'one buy-back chunk (buys the token in the pair and burns it at 0xdead)',
  liquidity: 'one liquidity chunk (half buys the token, all of it goes back into the pair with the matching quote, LP to 0xdead)',
  observe: 'a price observation (the 10-minute average a chunk needs)',
  split: 'a split that pays the payees their part of the quote that arrived',
}
const LOW_248 = (1n << 248n) - 1n

/** previewWork's minOut → { code, action, minTokensOut (chunks only), what }. Pass minOut to work() as returned. */
export function decodeWorkPlan(minOut) {
  const v = BigInt(minOut ?? 0n)
  const code = Number(v >> 248n)
  const action = WORK_ACTIONS[code] ?? `unknown (${code})`
  const value = v & LOW_248
  return {
    code, action, ...((code === 1 || code === 2) && { minTokensOut: formatUnits(value, 18) }),
    what: WORK_WHAT[action] ?? 'an action this CLI does not know',
  }
}

const ERRORS = [
  'error ZeroAddress()', 'error NotClone()', 'error NotFactory()', 'error AlreadyInitialized()', 'error BadBps()',
  'error BadPayees()', 'error BadShares()', 'error BadPayee()', 'error DuplicatePayee()', 'error BadIndex()',
  'error NotPayee()', 'error AlreadyBound()', 'error NotBound()', 'error NotCurve()', 'error NotCreator()',
  'error NotRecipient()', 'error NothingOwed()', 'error NothingToChunk()', 'error ChunkTooSoon()', 'error NotTradable()',
  'error Slippage()', 'error PushStarved()',
]

export const COMBO_FACTORY_ABI = parseAbi([
  'function create(uint16 buybackBps, uint16 lpBps, address[] payees, uint16[] shares, bytes32 salt) returns (address module)',
  'function predict(address dev, bytes32 salt) view returns (address)',
  'function pad() view returns (address)',
  'error NotAgent()', 'error WrongHandler()',
  'event Created(address indexed dev, address indexed module, uint16 buybackBps, uint16 lpBps, address[] payees, uint16[] shares)',
  ...ERRORS,
])

export const COMBO_ABI = parseAbi([
  'function moduleType() view returns (bytes32)',
  'function dev() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function pair() view returns (address)',
  'function gangQuote() view returns (address)',
  'function buybackBps() view returns (uint16)',
  'function lpBps() view returns (uint16)',
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
  'event Distributed(address indexed asset, uint256 incoming, uint256 toDead)',
  'event PayeeOwed(address indexed asset, uint256 indexed index, uint256 amount)',
  'event PayeeReleased(address indexed asset, uint256 indexed index, uint256 amount)',
  'event PayeeChanged(uint256 indexed index, address indexed oldPayee, address indexed newPayee)',
  'event Shortfall(address indexed asset, uint256 amount)',
  'event BoughtBack(uint256 quoteIn, uint256 burned, uint256 left)',
  'event LiquidityAdded(uint256 quoteIn, uint256 tokensIn, uint256 liquidity, uint256 left)',
  ...ERRORS,
])
/** gang tx decodes these (the factory's Created and the module's events). */
export const COMBO_EVENT_ABIS = [COMBO_FACTORY_ABI, COMBO_ABI]

const PAD_ABI = parseAbi([
  'function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)',
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
])
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])

export const COMBO_GAS_NOTE = 'let the wallet estimate the gas limit (eth_estimateGas) and do not set or lower it: a chunk takes about 0.55–0.75M gas, and a split pushes up to 10 payees, each needing about 365k gas left before it, so the limit is far above the gas used; a lower limit reverts (PushStarved: nothing moves)'

export const HINTS = {
  NotAgent: 'only an Agent can create a V3 token, so only an Agent gets a combined recipient',
  NotFactory: 'this combo factory is not allowed on the platform\'s GangHandlerAdmin: it cannot list a combined recipient as a tax recipient. If GANG_COMBO_FACTORY / GANG_TESTNET_COMBO_FACTORY is set, unset it to use the built-in factory; otherwise launch with one of --buyback / --lp / --split alone',
  BadBps: '--buyback + --lp is at most 100%',
  BadPayees: 'below 100% buy-back + LP: 1–10 payees (--split), one share each; at 100%: no payees',
  BadShares: 'each payee share at least 0.01% (1 bps) of the rest, all adding up to 100% of it',
  BadPayee: 'a payee cannot be the combined recipient itself',
  DuplicatePayee: 'that address is a payee already (each address holds at most one slot)',
  ZeroAddress: 'the zero address cannot be a payee',
  BadIndex: 'no payee slot with that index (gang combo status lists them, from 0)',
  NotPayee: 'only the current payee of a slot can move it to another address',
  AlreadyBound: 'the combined recipient is bound to a token already',
  NotBound: 'the combined recipient is not bound to a token yet (gang combo bind --token <the token>): nothing is split before that',
  NotCurve: 'not a V3 (curve) token on this pad',
  NotCreator: 'the token was not created by this combined recipient\'s dev',
  NotRecipient: 'the token does not pay its tax to this combined recipient',
  NothingOwed: 'nothing is owed to that slot in this asset (gang combo status shows what each slot is owed)',
  NothingToChunk: 'nothing is set aside for a buy-back or liquidity chunk yet (buybackLeft / lpLeft): it fills as the tax arrives',
  ChunkTooSoon: 'one chunk (buy-back or liquidity, together) per 4 minutes: wait until 4 minutes after the last one (lastChunkAt)',
  NotTradable: 'the token has not graduated: chunks start once it trades in its PancakeSwap pair',
  Slippage: 'the pool price moved since the preview (fewer tokens than the minimum): run gang combo chunk again',
  PushStarved: `the tx's gas limit was too low for the payee pushes: ${COMBO_GAS_NOTE}`,
}
export const revertOf = (e) => revertIn(e, [COMBO_ABI, COMBO_FACTORY_ABI], HINTS)

/** Dry-run a call; { failed } with the revert when it would not pass. */
export async function simulateCombo(client, from, address, abi, functionName, args = []) {
  try {
    const { result } = await client.simulateContract({ account: from, address, abi, functionName, args })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

export function comboFactoryAddress(testnet) {
  return (testnet ? process.env.GANG_TESTNET_COMBO_FACTORY || TESTNET_COMBO_FACTORY
    : process.env.GANG_COMBO_FACTORY || MAINNET_COMBO_FACTORY) || null
}

export const comboNotDeployed = (testnet) => (testnet
  ? 'GangComboSplitterFactory (the combined recipient) is not deployed on the BSC testnet in this CLI version: set GANG_TESTNET_COMBO_FACTORY to its address, or give one of --buyback / --lp / --split alone'
  : 'GangComboSplitterFactory (the combined recipient) is not deployed on BSC mainnet in this CLI version: set GANG_COMBO_FACTORY to its address, or give one of --buyback / --lp / --split alone')

const COMBO_REST_NOTE = 'in a combined launch --split lists the payees of what --buyback and --lp leave, their shares adding up to 100 (of that rest)'

/**
 * A combined launch's flags → { buybackBps, lpBps, payees, shares, list } or { error, … }, checked as
 * GangComboSplitter.initialize checks them. `buybackBps` / `lpBps`: the parsed --buyback / --lp (bps, 0 when absent);
 * `split`: the raw --split (undefined when absent); `me`: the creating wallet (`self`, and the only payee by default).
 * Payee shares are of the rest (10,000 − buyback − LP); the payee being the module itself is checked once its address is
 * known (launch.js, from predict).
 */
export function parseComboSpec({ buybackBps = 0, lpBps = 0, split } = {}, me) {
  const kept = buybackBps + lpBps
  if (kept > BPS) return { error: `--buyback ${buybackBps / 100} + --lp ${lpBps / 100} is ${kept / 100}%, more than 100% of the recipient's part`, hint: 'lower one of them: the payees (--split) share what the two leave' }
  if (kept === 0) return { error: '--buyback 0 and --lp 0 leave only the payees: give --split alone for a split module', hint: 'or raise --buyback / --lp' }
  if (kept === BPS) {
    if (split !== undefined) return { error: `--buyback + --lp is 100% of the recipient's part: nothing is left for payees, so --split is refused`, hint: 'drop --split, or lower --buyback / --lp so the payees get the rest' }
    return { buybackBps, lpBps, payees: [], shares: [], list: [] }
  }
  let spec
  if (split === undefined) {
    if (!isAddress(me ?? '')) return { error: 'the rest of the recipient\'s part goes to your wallet: sign in with baw, or give --from (or name the payees with --split)' }
    spec = { payees: [getAddress(me)], shares: [BPS], list: [{ index: 0, payee: getAddress(me), pct: 100, you: true }] }
  } else {
    spec = parseSplitSpec(split, me)
    if (spec.error) return { ...spec, hint: spec.hint ? `${spec.hint}. ${COMBO_REST_NOTE}` : COMBO_REST_NOTE }
  }
  const rest = BPS - kept
  return {
    buybackBps, lpBps, payees: spec.payees, shares: spec.shares,
    list: spec.list.map(({ pct: p, ...x }) => ({ ...x, pctOfRest: p, pctOfRecipient: ofRecipient(spec.shares[x.index], rest) })),
  }
}

/** A payee's share of the rest (bps) as a % of the recipient's whole part. */
const ofRecipient = (share, rest) => Math.round((Number(share) * rest) / 1e2) / 1e4

/** The combo as one line: "30% buy-back, 30% liquidity, the rest (40%): 0xAb…: 70%, 0xCd…: 30%". */
export function comboLine(buybackBps, lpBps, payees, shares) {
  const rest = BPS - buybackBps - lpBps
  const parts = [`${buybackBps / 100}% buy-back and burn`, `${lpBps / 100}% liquidity (LP to 0xdead)`]
  if (payees.length) parts.push(`the rest (${rest / 100}%) to ${payees.map((p, i) => `${p}: ${Number(shares[i]) / 100}% of it`).join(', ')}`)
  return parts.join(', ')
}

export const PERMANENT_NOTE = 'PERMANENT: the buy-back %, the LP %, the payees and their shares are fixed for good — nobody (not you, not the platform) can change them later, unlike a lone --buyback or --lp splitter whose dev can change its ratio; a payee can only move its own slot to another address (gang combo set-payee)'

/** What the combo does with each part, and with any other asset (the preview and status note). */
export function comboParts(buybackBps, lpBps, nPayees) {
  const dead = (buybackBps + lpBps) / 100
  return {
    buyback: `${buybackBps / 100}% of each tax payment to this recipient (in the token's quote) is set aside and bought back in the PancakeSwap pair, the tokens burned (0xdead)`,
    liquidity: `${lpBps / 100}% is set aside and added to the pair as liquidity (half buys the token, all of it goes back in with the matching quote), the LP sent to 0xdead (locked for good)`,
    payees: nPayees ? `the rest (${(BPS - buybackBps - lpBps) / 100}%) is pushed to the payees at their shares (the first also takes the rounding dust)` : 'no payees: buy-back + liquidity take it all',
    chunks: 'after graduation, one chunk per 4 minutes for both kinds together (always the larger set-aside part), at most 0.5% of the pair\'s quote reserve, none while the price is more than 2% above its 10-minute average',
    otherAssets: nPayees
      ? `any other asset sent to it (not the token's quote) cannot be bought back or added: its buy-back + LP share (${dead}%) goes to 0xdead, the rest to the payees (gang combo distribute --asset <addr>)`
      : 'any other asset sent to it (not the token\'s quote) goes to 0xdead in full (gang combo distribute --asset <addr>)',
  }
}

const iso = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null)
const q18 = (x) => formatUnits(x, 18)

/** _kindOf: the larger set-aside part (a buy-back on a tie); a liquidity part under 2 wei has no half. */
function kindOf(bb, lp) {
  const canBurn = bb !== 0n, canAdd = lp / 2n !== 0n
  if (!canBurn && !canAdd) return null
  if (!canAdd) return 'buy-back'
  if (!canBurn) return 'liquidity'
  return bb >= lp ? 'buy-back' : 'liquidity'
}

/**
 * The module's state for printing, from the raw reads (pure: unit-tested). `raw`: { module, dev, token, quote,
 * quoteSymbol, buybackBps, lpBps, payees, shares, buybackLeft, lpLeft, unsplit, lastChunkAt, lastPaidAt,
 * keeperServesQuote, preview: [ready, burn, amount, tokensOut] | null, work: [due, minOut] | null, graduated: bool | null,
 * assets: [{ asset, symbol, decimals, undistributed, owedTotal, owed: bigint[] | null }], now (unix s) }. `ref`: how later
 * commands name it (e.g. `--token 0x… --testnet`).
 */
export function formatCombo(raw, ref) {
  const token = raw.token && raw.token !== zeroAddress ? raw.token : null
  const quote = token && raw.quote && raw.quote !== zeroAddress ? raw.quote : null
  const isQuote = (a) => !!quote && a.toLowerCase() === quote.toLowerCase()
  const bbBps = Number(raw.buybackBps), lpBps = Number(raw.lpBps)
  const rest = BPS - bbBps - lpBps
  const dev = String(raw.dev).toLowerCase()
  const payees = raw.payees.map((payee, index) => ({
    index, payee, pctOfRest: Number(raw.shares[index]) / 100, pctOfRecipient: ofRecipient(raw.shares[index], rest),
    bps: Number(raw.shares[index]), ...(payee.toLowerCase() === dev && { isDev: true }),
  }))
  const now = Number(raw.now ?? Math.floor(Date.now() / 1000))
  const last = Number(raw.lastChunkAt ?? 0n)

  // the set-aside parts once the waiting quote is split (as the contract's _afterSplit, without a shortfall)
  const unsplit = BigInt(raw.unsplit ?? 0n)
  let toBb = (unsplit * BigInt(bbBps)) / 10_000n, toLp = (unsplit * BigInt(lpBps)) / 10_000n
  if (!payees.length) {
    const pay = unsplit - toBb - toLp
    if (bbBps !== 0) toBb += pay
    else toLp += pay
  }
  const bbAfter = BigInt(raw.buybackLeft) + toBb, lpAfter = BigInt(raw.lpLeft) + toLp
  const kind = kindOf(bbAfter, lpAfter)
  const [ready, burn, amount, tokensOut] = raw.preview ?? [false, false, 0n, 0n]
  let waiting = null
  if (!ready) {
    waiting = !token ? 'not bound to a token yet (gang combo bind --token <the token>)'
      : raw.graduated === false ? 'the token has not graduated: chunks start once it trades in its PancakeSwap pair (the pool tax starts then too)'
        : !kind ? 'nothing set aside for a buy-back or liquidity chunk yet: it fills as the tax arrives'
          : last > 0 && now < last + CHUNK_GAP_S ? `one chunk per 4 minutes (both kinds together): the next from ${iso(last + CHUNK_GAP_S)}`
            : 'the price check: a 10-minute average of the pair\'s price (the next call records it, if none is running) and a price no more than 2% above it'
  }
  const nextChunk = ready
    ? burn
      ? { kind: 'buy-back', quoteIn: q18(amount), tokensBurned: formatUnits(tokensOut, 18) }
      : { kind: 'liquidity', quoteChunk: q18(amount), buyHalf: q18(amount / 2n), tokensBought: formatUnits(tokensOut, 18) }
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
    assets.push({
      asset: a.asset, symbol: a.symbol ?? null, ...(isQuote(a.asset) && { boundQuote: true }),
      undistributed: f(undistributed), owedTotal: f(owedTotal), ...(owed.length && { owed }),
      splitBy: !token ? 'nobody until bound (distribute reverts NotBound)'
        : byKeeper ? 'keeper (or anyone, gang combo distribute)'
          : isQuote(a.asset) ? 'hand: gang combo distribute (anyone)'
            : `hand: gang combo distribute (anyone): ${payees.length ? `${(bbBps + lpBps) / 100}% to 0xdead, the rest to the payees` : 'all of it to 0xdead'}`,
    })
    if (token && undistributed > 0n && !byKeeper) next.push(`gang combo distribute ${ref} --asset ${a.asset}`)
    for (const o of owed) next.push(`gang combo release ${ref} --asset ${a.asset} --index ${o.index}`)
  }
  if (!token) next.unshift(String(ref ?? '').startsWith('--token ') ? `gang combo bind ${ref}` : 'gang combo bind --token <the token>')
  if (ready) next.push(`gang combo chunk ${ref}`)

  const sym = (assets.find((x) => x.boundQuote)?.symbol) || raw.quoteSymbol || quote
  const distribution = !token ? 'unbound' : raw.keeperServesQuote ? 'keeper' : 'manual'
  const keeperLine = distribution === 'unbound'
    ? 'Not bound to a token yet: nothing is split, bought back or added until gang combo bind --token <the token>'
    : distribution === 'keeper'
      ? `The keeper serves this quote (${sym}): it runs the chunks and pays the payees (once their part reaches 0.05% of the pair's quote reserve, or after a day once it reaches 1/100 of that); anyone can do it sooner (gang combo chunk / gang combo distribute)`
      : `The keeper does not serve this quote (${sym}): everything is manual — gang combo chunk and gang combo distribute (anyone)`
  const [due, minOut] = raw.work ?? [false, 0n]
  const parts = comboParts(bbBps, lpBps, payees.length)
  return {
    module: raw.module, moduleType: COMBO_TYPE, dev: raw.dev, token, quote, ...(quote && sym && { quoteSymbol: sym }),
    buybackPct: bbBps / 100, lpPct: lpBps / 100, payeesPct: rest / 100, buybackBps: bbBps, lpBps, permanent: true,
    payees,
    buybackLeft: q18(raw.buybackLeft), lpLeft: q18(raw.lpLeft), unsplit: q18(unsplit),
    nextChunk, ...(waiting && { nextChunkWaitsFor: waiting }),
    lastChunkAt: iso(last), lastPaidAt: iso(raw.lastPaidAt ?? 0n),
    distribution,
    keeper: {
      servesQuote: token ? !!raw.keeperServesQuote : null, due: !!due,
      ...(due && { plan: decodeWorkPlan(minOut) }),
    },
    assets,
    ...(next.length && { next }),
    parts,
    note: `${PERMANENT_NOTE}. ${keeperLine}. A failed payee push is owed to that slot and paid with its next push, or by gang combo release`,
  }
}

/** Reads `asset`'s side of the module; null when it is not an ERC20 the module can read. */
async function assetRaw(read, module, asset, n) {
  let undistributed, owedTotal
  try {
    [undistributed, owedTotal] = await Promise.all([
      read(module, COMBO_ABI, 'undistributed', [asset]), read(module, COMBO_ABI, 'owedTotal', [asset]),
    ])
  } catch { return null }
  const [symbol, decimals, owed] = await Promise.all([
    read(asset, ERC20_ABI, 'symbol').catch(() => null),
    read(asset, ERC20_ABI, 'decimals').then(Number).catch(() => 18),
    owedTotal > 0n ? Promise.all(Array.from({ length: n }, (_, i) => read(module, COMBO_ABI, 'owedOf', [asset, BigInt(i)]))) : null,
  ])
  return { asset, symbol, decimals, undistributed, owedTotal, owed }
}

/**
 * The module's state when `addr` is a GangComboSplitter (combo-v1); null when it is not. Assets read: the bound quote,
 * WBNB, the module's GANG and `extraAssets` (e.g. the quote of a token paying it that is not the bound one). `pad`: to
 * read graduation.
 */
export async function comboOf(read, addr, { wbnb, pad, extraAssets = [], ref } = {}) {
  if (!addr || addr === zeroAddress) return null
  let type
  try { type = await read(addr, COMBO_ABI, 'moduleType') } catch { return null }
  if (hexToString(type, { size: 32 }).replace(/\0+$/, '') !== COMBO_TYPE) return null
  const [dev, token, quote, [payees, shares], buybackBps, lpBps, buybackLeft, lpLeft, unsplit, lastChunkAt, lastPaidAt, gangQuote] = await Promise.all([
    ...['dev', 'token', 'quote', 'payeesOf', 'buybackBps', 'lpBps', 'buybackLeft', 'lpLeft', 'unsplit', 'lastChunkAt', 'lastPaidAt'].map((f) => read(addr, COMBO_ABI, f)),
    read(addr, COMBO_ABI, 'gangQuote').catch(() => zeroAddress),
  ])
  const bound = token !== zeroAddress
  const [preview, work, keeperServesQuote, graduated] = await Promise.all([
    bound ? read(addr, COMBO_ABI, 'previewChunk').catch(() => null) : null,
    bound ? read(addr, COMBO_ABI, 'previewWork').catch(() => null) : null,
    bound ? read(addr, COMBO_ABI, 'keeperServes', [quote]).catch(() => false) : false,
    bound && pad ? read(pad, PAD_ABI, 'curves', [token]).then((c) => c[6]).catch(() => null) : null,
  ])
  const seen = new Set()
  const list = [quote, wbnb, gangQuote, ...extraAssets].filter((a) => {
    if (!a || a === zeroAddress || seen.has(a.toLowerCase())) return false
    seen.add(a.toLowerCase())
    return true
  })
  const assets = (await Promise.all(list.map((a) => assetRaw(read, addr, a, payees.length)))).filter(Boolean)
  return formatCombo({
    module: addr, dev, token, quote, buybackBps, lpBps, payees, shares, buybackLeft, lpLeft, unsplit, lastChunkAt, lastPaidAt,
    keeperServesQuote, preview, work, graduated, assets,
  }, ref ?? (bound ? `--token ${token}` : `--module ${addr}`))
}

/** When `token` pays its tax to the combo but the combo is bound to another token (a decoy bind): what to say. */
export function decoyWarning(s, token, tokenQuote, ref) {
  if (!token || !s.token || s.token.toLowerCase() === token.toLowerCase()) return null
  return `this token pays its tax to the combined recipient, but it is bound to another token (${s.token}): the buy-backs and liquidity go to that token's pair, and this token's tax (${tokenQuote ?? 'its quote'}) is not its bound quote — it is only distributed by hand (gang combo distribute ${ref} --asset ${tokenQuote ?? '<its quote>'}): its buy-back + LP share to 0xdead, the rest to the payees`
}

function comboCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const SUBS = ['status', 'distribute', 'release', 'set-payee', 'bind', 'chunk']
const USAGE = 'usage: gang combo <status|distribute|release|set-payee|bind|chunk> --token <addr> (or --module <addr>) [--asset <addr>|wbnb] [--index <i>] [--to <addr>] [--max <amount>] [--slippage 1] [--testnet] — see gang help'

/** `gang combo <sub>`: the combined recipient of a V3 token (its tax recipient), found from --token (or named by --module). */
export async function runCombo(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const rawOnly = flag('calldata')
  let ctx
  try { ctx = comboCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)
  const tn = testnet ? ' --testnet' : ''
  if (flag('token') && flag('module')) fail('give --token (its tax recipient is the combined recipient) or --module, not both')
  let token = null, module, tokenQuote = null
  if (flag('module')) {
    if (sub === 'bind') fail('gang combo bind needs --token <the token> (it binds the token\'s own recipient)')
    module = opt('module')
    if (!isAddress(module ?? '')) fail('--module must be a combined recipient address (0x…)', { got: module ?? null })
  } else {
    token = opt('token')
    if (!isAddress(token ?? '')) fail('--token must be a V3 token address (0x…), or name the module with --module <addr>', { got: token ?? null })
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
  const s = await comboOf(ctx.read, module, {
    wbnb: ctx.wbnb, pad: ctx.pad, extraAssets: [...(tokenQuote && tokenQuote !== zeroAddress ? [tokenQuote] : []), ...extra], ref,
  })
  if (!s) {
    return fail(token ? 'this token\'s tax recipient is not a combined recipient (combo-v1)' : 'not a combined recipient (combo-v1)',
      { ...(token && { token }), recipient: module === zeroAddress ? null : module })
  }
  const warning = decoyWarning(s, token, tokenQuote, ref)
  const me = () => walletFor(ctx, opt('from'))
  const send = async (functionName, args, extra) => {
    const sim = await simulateCombo(ctx.client, me(), s.module, COMBO_ABI, functionName, args)
    if (sim.failed) return out({ success: false, step: extra.step, ...sim.failed, ...(warning && { warning }) })
    const data = encodeFunctionData({ abi: COMBO_ABI, functionName, args })
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
    if (!s.token) fail(HINTS.NotBound, { module: s.module, ...(token && { next: `gang combo bind --token ${token}${tn}` }) })
  }
  /** `amount` split among the payees as the contract does: the others rounded down, the first the rest. */
  const payeeParts = (amount, f) => {
    if (!s.payees.length) return []
    const amounts = s.payees.map((p) => (amount * BigInt(p.bps)) / BigInt(BPS))
    amounts[0] = amount - amounts.slice(1).reduce((x, y) => x + y, 0n)
    return s.payees.map((p, i) => ({ index: p.index, payee: p.payee, pctOfRest: p.pctOfRest, gets: f(amounts[i]) }))
  }

  if (sub === 'status') return out({ success: true, chainId, ...s, ...(s.token === null && { bound: false }), ...(warning && { warning }) })

  if (sub === 'bind') {
    if (s.token) return fail('already bound', { boundTo: s.token, ...(warning && { warning }) })
    return send('bind', [token], { step: 'bind', note: 'anyone may bind (once); the token must be the dev\'s and pay its tax to this module. It decides which quote is split and which pair the buy-backs and liquidity go to' })
  }

  if (sub === 'distribute') {
    needBound()
    const asset = assetArg(s.quote)
    const a = await assetState(asset)
    if (a.undistributed === 0n) {
      return fail('nothing of this asset is waiting to be split', {
        asset, symbol: a.symbol, owedTotal: a.f(a.owedTotal),
        ...(a.owedTotal > 0n && { hint: `what is held is owed to payees after failed pushes: gang combo release ${ref} --asset ${asset} --index <i>` }),
      })
    }
    const bb = BigInt(s.buybackBps), lpb = BigInt(s.lpBps)
    if (asset.toLowerCase() === s.quote.toLowerCase()) {
      const toBuyback = (a.undistributed * bb) / 10_000n, toLp = (a.undistributed * lpb) / 10_000n
      const toPayees = s.payees.length ? a.undistributed - toBuyback - toLp : 0n
      return send('distribute', [asset], {
        step: 'distribute', asset, symbol: a.symbol, boundQuote: true, amount: a.f(a.undistributed),
        toBuyback: a.f(toBuyback), toLp: a.f(toLp), toPayees: a.f(toPayees), parts: payeeParts(toPayees, a.f),
        note: `anyone may: splits the bound quote that arrived (as split()): ${s.buybackPct}% set aside for buy-back, ${s.lpPct}% for liquidity, the rest pushed to the payees; a push that fails is owed to that slot. Gas: ${COMBO_GAS_NOTE}`,
      })
    }
    const toDead = s.payees.length ? (a.undistributed * (bb + lpb)) / 10_000n : a.undistributed
    const rest = a.undistributed - toDead
    return send('distribute', [asset], {
      step: 'distribute', asset, symbol: a.symbol, amount: a.f(a.undistributed), toDead: a.f(toDead), toPayees: a.f(rest),
      parts: payeeParts(rest, a.f),
      note: `anyone may: this is not the bound quote, so it cannot be bought back or added to the pool: ${s.payees.length ? `its buy-back + LP share (${(s.buybackBps + s.lpBps) / 100}%) goes to 0xdead, the rest to the payees at their shares` : 'all of it goes to 0xdead (no payees)'}; a push that fails is owed to that slot. Gas: ${COMBO_GAS_NOTE}`,
    })
  }

  if (sub === 'release') {
    needBound()
    if (!s.payees.length) return fail('this combined recipient has no payees (buy-back + LP = 100%): nothing is ever owed')
    const asset = assetArg(s.quote)
    const a = await assetState(asset)
    let index
    if (flag('index')) index = indexArg(opt('index'), s.payees.length, fail)
    else {
      const mine = s.payees.find((p) => p.payee.toLowerCase() === String(me()).toLowerCase())
      const owedSlots = (a.owed ?? []).map((x, i) => (x > 0n ? i : -1)).filter((i) => i >= 0)
      if (mine) index = mine.index
      else if (owedSlots.length === 1) index = owedSlots[0]
      else fail('--index <i> required: which payee slot to pay (gang combo status lists what each is owed)', { owedSlots })
    }
    const owed = a.owed ? a.owed[index] : 0n
    if (owed === 0n) return fail(HINTS.NothingOwed, { asset, symbol: a.symbol, index, payee: s.payees[index].payee })
    let max = maxUint256
    if (flag('max')) max = parseUnits(parseAmount(fail, 'max', opt('max')), a.decimals)
    const amount = owed < max ? owed : max
    return send('release', [asset, BigInt(index), max], {
      step: 'release', asset, symbol: a.symbol, index, payee: s.payees[index].payee, amount: a.f(amount), owed: a.f(owed),
      note: `anyone may: splits what newly arrived of this asset first, then pushes ${max === maxUint256 ? 'all' : 'up to --max'} of what this slot is owed to its payee (reverts while it still cannot receive; nothing owed is lost). Gas: ${COMBO_GAS_NOTE}`,
    })
  }

  if (sub === 'chunk') {
    needBound()
    const slippage = parseNum(fail, 'slippage', opt('slippage', '1'), 0, 50)
    const [ready, burn, amount, tokensOut] = await ctx.read(s.module, COMBO_ABI, 'previewChunk')
    if (ready) {
      // previewChunk prices the buy (a liquidity chunk: its half) after the buy tax; the contract scales the minimum
      // down when the pair got less
      const minOut = (tokensOut * BigInt(Math.round((100 - slippage) * 100))) / 10_000n
      return send('chunk', [minOut], burn
        ? {
            step: 'chunk', kind: 'buy-back', quoteIn: q18(amount), expectTokensBurned: formatUnits(tokensOut, 18),
            minTokens: formatUnits(minOut, 18), slippagePct: slippage, buybackLeft: s.buybackLeft, lpLeft: s.lpLeft,
            note: `anyone may: splits what arrived, then one buy-back chunk (the larger set-aside part): buys the token in the pair and burns it at 0xdead (gang tx shows BoughtBack). The keeper does the same every few minutes. Gas: ${COMBO_GAS_NOTE}`,
          }
        : {
            step: 'chunk', kind: 'liquidity', quoteChunk: q18(amount), buyHalf: q18(amount / 2n), expectTokensBought: formatUnits(tokensOut, 18),
            minTokens: formatUnits(minOut, 18), slippagePct: slippage, buybackLeft: s.buybackLeft, lpLeft: s.lpLeft,
            note: `anyone may: splits what arrived, then one liquidity chunk (the larger set-aside part): half buys the token, all of it goes back into the pair with the matching quote, the LP to 0xdead (gang tx shows LiquidityAdded). The keeper does the same every few minutes. Gas: ${COMBO_GAS_NOTE}`,
          })
    }
    // not ready: only a call that records the price observation can pass; a minimum no chunk can meet makes it revert
    // (Slippage) rather than trade unchecked if a chunk became possible before it lands
    const sim = await simulateCombo(ctx.client, me(), s.module, COMBO_ABI, 'chunk', [maxUint128])
    if (sim.failed) return out({ success: false, step: 'chunk', ...sim.failed, ...(s.nextChunkWaitsFor && { waitsFor: s.nextChunkWaitsFor }), buybackLeft: s.buybackLeft, lpLeft: s.lpLeft, ...(warning && { warning }) })
    return send('chunk', [maxUint128], {
      step: 'record-price', trades: false, waitsFor: s.nextChunkWaitsFor,
      note: 'no chunk this time: the call splits what arrived and records the pair\'s price observation (or waits for the 10-minute average / a price no more than 2% above it). The keeper calls it too. If a chunk becomes possible before it lands, it reverts (Slippage) rather than trade without a minimum: run gang combo chunk again then, about 10 minutes after the first observation',
    })
  }

  // set-payee: only the slot's own payee; the index is the wallet's own slot unless given
  if (!s.payees.length) return fail('this combined recipient has no payees (buy-back + LP = 100%)')
  const wallet = String(me()).toLowerCase()
  const mine = s.payees.find((p) => p.payee.toLowerCase() === wallet)
  let index
  if (flag('index')) index = indexArg(opt('index'), s.payees.length, fail)
  else if (mine) index = mine.index
  else return fail('this wallet is not a payee of this combined recipient: only a slot\'s own payee can move it', { wallet: me(), payees: s.payees.map((p) => p.payee) })
  const slot = s.payees[index]
  if (slot.payee.toLowerCase() !== wallet) return fail(HINTS.NotPayee, { index, payee: slot.payee, wallet: me() })
  const to = opt('to')
  if (!isAddress(to ?? '') || to === zeroAddress) fail('--to <0x…> required (checksummed or all lowercase): the address this slot is paid to from now on', { got: to ?? null })
  if (to.toLowerCase() === s.module.toLowerCase()) return fail(HINTS.BadPayee, { to })
  const taken = s.payees.find((p) => p.payee.toLowerCase() === to.toLowerCase())
  if (taken) return fail(taken.index === index ? 'that is this slot\'s payee already' : HINTS.DuplicatePayee, { to, index: taken.index })
  // the contract splits only the bound quote before the move: other assets that arrived would go to the new address,
  // so split those first (each its own tx, then the same command again); needs the module bound (NotBound before)
  const unsplit = s.token ? s.assets.filter((x) => !x.boundQuote && Number(x.undistributed) > 0) : []
  if (unsplit.length) {
    const first = unsplit[0]
    return send('distribute', [first.asset], {
      step: 'distribute-first', asset: first.asset, symbol: first.symbol, amount: first.undistributed,
      ...(unsplit.length > 1 && { thenAlso: unsplit.slice(1).map((x) => ({ asset: x.asset, symbol: x.symbol, amount: x.undistributed })) }),
      note: `before the move: ${first.symbol || first.asset} that arrived earlier is distributed to the current payees (and its buy-back + LP share to 0xdead); the contract splits only the bound quote itself. After executing, re-run the same command. Gas: ${COMBO_GAS_NOTE}`,
    })
  }
  return send('setPayee', [BigInt(index), getAddress(to)], {
    step: 'set-payee', index, pctOfRest: slot.pctOfRest, fromPayee: slot.payee, toPayee: getAddress(to),
    note: `applies at once; the share (${slot.pctOfRest}% of the rest) stays with the slot. The bound quote that arrived before is split first (to the current address); what this slot is owed (any asset) goes to the new one. The ratios and the other slots stay as they are (fixed for good). Gas: ${COMBO_GAS_NOTE}`,
  })
}

function indexArg(raw, n, fail) {
  const i = Number(raw)
  if (!Number.isInteger(i) || i < 0 || i >= n) fail(`--index must be a payee slot: the contract's 0-based index, 0 to ${n - 1} (gang combo status lists them)`, { got: raw ?? null })
  return i
}
