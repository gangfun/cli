import { createPublicClient, parseAbi, encodeFunctionData, formatUnits, getAddress, hexToString, isAddress, maxUint256, parseUnits, zeroAddress } from 'viem'
import { atTokenPad, GANG_GENS, KIND_UNREAD, gangGens, padNets, NOT_ON_MAINNET, rpcTransport } from './gangpad.js'
import { walletFor } from './fair.js'
import { parseAmount, revertOf as revertIn, step } from './steps.js'

/**
 * `gang split …` and `gang create … --split <addr>:<pct>[,…]` — GangSplitModule (多人分账, `split-v1`): a V3 token's tax
 * recipient that splits everything it receives among 1–10 payees at shares fixed when it is cloned (summing to 100%).
 * Nobody — not the dev, not the platform — can change the payees or the shares; a payee can only move its own slot to
 * another address (`setPayee`). GangSplitModuleFactory clones one for the dev (`create(payees, shares, salt)`, at
 * `predict(dev, salt)`) and has GangHandlerAdmin list it, so the dev names it as the recipient at create (launch.js does
 * the three steps: clone → create → bind, as for --buyback).
 * Every asset that reaches the module is split at the same shares (`distribute(asset)`, anyone); the keeper splits only
 * the bound quote, and only when it serves that quote (`keeperServes`: WBNB, GANG, a QuoteRegistry quote).
 * Gas: each payee's push needs about 365k gas left before it (PUSH_GAS 300k × 64/63 + a 60k reserve), so a split needs a
 * gas limit far above the gas it uses. The CLI never sets or lowers one: the wallet / node estimates it (eth_estimateGas
 * searches for a limit that passes); a lower limit reverts PushStarved, and nothing moves.
 * Env: GANG_SPLIT_FACTORY / GANG_TESTNET_SPLIT_FACTORY override the create target's factory (gangpad.js).
 */

// one factory per GangLaunchpad generation (it is bound to one pad): the create target's (GANG_GENS in gangpad.js)
export const MAINNET_SPLIT_FACTORY = GANG_GENS.mainnet[0].splitFactory
export const TESTNET_SPLIT_FACTORY = GANG_GENS.testnet[0].splitFactory
export const SPLIT_TYPE = 'split-v1'
export const MAX_PAYEES = 10
const BPS = 10_000

const ERRORS = [
  'error ZeroAddress()', 'error NotClone()', 'error NotFactory()', 'error AlreadyInitialized()', 'error BadPayees()',
  'error BadShares()', 'error BadPayee()', 'error DuplicatePayee()', 'error BadIndex()', 'error NotPayee()',
  'error AlreadyBound()', 'error NotCurve()', 'error NotCreator()', 'error NotRecipient()', 'error NothingOwed()',
  'error PushStarved()',
]

export const SPLIT_FACTORY_ABI = parseAbi([
  'function create(address[] payees, uint16[] shares, bytes32 salt) returns (address module)',
  'function predict(address dev, bytes32 salt) view returns (address)',
  'function pad() view returns (address)',
  'error NotAgent()', 'error WrongHandler()',
  'event Created(address indexed dev, address indexed module, address[] payees, uint16[] shares)',
  ...ERRORS,
])

export const SPLIT_ABI = parseAbi([
  'function moduleType() view returns (bytes32)',
  'function dev() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function gangQuote() view returns (address)',
  'function payeesOf() view returns (address[] payees, uint16[] shares)',
  'function payeeCount() view returns (uint256)',
  'function owedOf(address asset, uint256 index) view returns (uint256)',
  'function owedTotal(address asset) view returns (uint256)',
  'function undistributed(address asset) view returns (uint256)',
  'function keeperServes(address q) view returns (bool)',
  'function previewWork() view returns (bool due, uint256 minOut)',
  'function lastDistributedAt() view returns (uint64)',
  'function bind(address token)',
  'function distribute(address asset) returns (uint256 incoming)',
  'function release(address asset, uint256 index, uint256 maxAmount) returns (uint256 amount)',
  'function setPayee(uint256 index, address newPayee)',
  'event Bound(address indexed token, address indexed quote)',
  'event Distributed(address indexed asset, uint256 incoming)',
  'event PayeeOwed(address indexed asset, uint256 indexed index, uint256 amount)',
  'event PayeeReleased(address indexed asset, uint256 indexed index, uint256 amount)',
  'event PayeeChanged(uint256 indexed index, address indexed oldPayee, address indexed newPayee)',
  'event Shortfall(address indexed asset, uint256 amount)',
  ...ERRORS,
])
/** gang tx decodes these (the factory's Created and the module's events). */
export const SPLIT_EVENT_ABIS = [SPLIT_FACTORY_ABI, SPLIT_ABI]

const PAD_ABI = parseAbi([
  'function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)',
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
])
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])

export const GAS_NOTE = 'let the wallet estimate the gas limit (eth_estimateGas) and do not lower it: each payee\'s push needs about 365k gas left before it, so the limit is far above the gas used; a lower limit reverts PushStarved (nothing moves)'

export const HINTS = {
  NotAgent: 'only an Agent can create a V3 token, so only an Agent gets a split module',
  NotFactory: 'this split factory is not allowed on the platform\'s GangHandlerAdmin: it cannot list a split module as a tax recipient. If GANG_SPLIT_FACTORY / GANG_TESTNET_SPLIT_FACTORY is set, unset it to use the built-in factory; otherwise launch without --split',
  BadPayees: '1–10 payees, one share each',
  BadShares: 'each share at least 0.01% (1 bps), all adding up to 100%',
  BadPayee: 'a payee cannot be the split module itself',
  DuplicatePayee: 'that address is a payee already (each address holds at most one slot)',
  ZeroAddress: 'the zero address cannot be a payee',
  BadIndex: 'no payee slot with that index (gang split status lists them, from 0)',
  NotPayee: 'only the current payee of a slot can move it to another address',
  AlreadyBound: 'the module is bound to a token already',
  NotCurve: 'not a V3 (curve) token on this pad',
  NotCreator: 'the token was not created by this module\'s dev',
  NotRecipient: 'the token does not pay its tax to this module',
  NothingOwed: 'nothing is owed to that slot in this asset (gang split status shows what each slot is owed)',
  PushStarved: `the tx's gas limit was too low for the split: ${GAS_NOTE}`,
}
export const revertOf = (e) => revertIn(e, [SPLIT_ABI, SPLIT_FACTORY_ABI], HINTS)

/** Dry-run a call; { failed } with the revert when it would not pass. */
export async function simulateSplit(client, from, address, abi, functionName, args = []) {
  try {
    const { result } = await client.simulateContract({ account: from, address, abi, functionName, args })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

export function splitFactoryAddress(testnet) {
  return gangGens(testnet)[0].splitFactory || null
}

export const splitNotDeployed = (testnet) =>
  `GangSplitModuleFactory is not deployed on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} in this CLI version: set ${testnet ? 'GANG_TESTNET_SPLIT_FACTORY' : 'GANG_SPLIT_FACTORY'} to its address`

const SPLIT_USAGE = '--split takes <addr>:<pct>[,<addr>:<pct>…]: 1–10 payees, each share in % (up to 2 decimals, at least 0.01), adding up to 100; self (or me) = your wallet. E.g. --split self:60,0xAbc…:30,0xDef…:10'
const PCT_RE = /^(\d{1,3})(?:\.(\d{1,2}))?$/

/**
 * --split <addr>:<pct>[,…] → { payees, shares (bps), list } or { error, got }, checked as GangSplitModule.initialize checks
 * them (1–10 payees, none 0, no repeats, each share ≥ 1 bps, summing to 10,000). `self` (alias `me`) is the creating wallet;
 * the order is kept (the first payee also takes the rounding dust of each split). Whether a payee is the module itself
 * is checked once its address is known (launch.js, from predict).
 */
export function parseSplitSpec(raw, me) {
  const s = String(raw ?? '').trim()
  if (!s || s.startsWith('--')) return { error: SPLIT_USAGE, got: raw ?? null }
  const parts = s.split(',').map((x) => x.trim())
  if (parts.some((p) => !p)) return { error: `${SPLIT_USAGE} (an empty entry between commas)`, got: raw }
  if (parts.length > MAX_PAYEES) return { error: `--split takes at most ${MAX_PAYEES} payees`, got: parts.length }
  const list = []
  for (const p of parts) {
    const i = p.lastIndexOf(':')
    if (i < 0) return { error: `--split: "${p}" is not <addr>:<pct>`, hint: SPLIT_USAGE }
    const who = p.slice(0, i).trim(), pctRaw = p.slice(i + 1).trim()
    let payee, you = false
    if (/^(me|self)$/i.test(who)) {
      if (!isAddress(me ?? '')) return { error: `--split: "${who}" needs your wallet address (sign in with baw, or give --from)` }
      payee = getAddress(me); you = true
    } else if (!isAddress(who)) {
      return { error: `--split: "${who}" is not a 0x address (checksummed or all lowercase) or self`, hint: SPLIT_USAGE }
    } else payee = getAddress(who)
    if (payee === zeroAddress) return { error: '--split: the zero address cannot be a payee' }
    const m = PCT_RE.exec(pctRaw)
    if (!m) return { error: `--split: "${pctRaw}" (for ${who}) is not a share in % with at most 2 decimals (e.g. 60 or 33.33)`, hint: SPLIT_USAGE }
    const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
    if (bps < 1) return { error: `--split: ${who} has a 0% share; each payee needs at least 0.01%` }
    if (bps > BPS) return { error: `--split: ${who} has more than 100%` }
    if (!you && me && isAddress(me) && payee === getAddress(me)) you = true
    list.push({ payee, bps, you })
  }
  const seen = new Set()
  for (const { payee } of list) {
    if (seen.has(payee)) return { error: `--split: ${payee} appears twice (self is your wallet ${me}); each address holds one slot`, got: raw }
    seen.add(payee)
  }
  const sum = list.reduce((a, x) => a + x.bps, 0)
  if (sum !== BPS) return { error: `--split: the shares add up to ${sum / 100}%, not 100%`, got: raw }
  return {
    payees: list.map((x) => x.payee), shares: list.map((x) => x.bps),
    list: list.map((x, index) => ({ index, payee: x.payee, pct: x.bps / 100, ...(x.you && { you: true }) })),
  }
}

/** The split as a one-line summary: "0xAb…:60%, 0xCd…:40%". */
export const splitLine = (payees, shares) => payees.map((p, i) => `${p}: ${Number(shares[i]) / 100}%`).join(', ')

const iso = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null)

/**
 * The module's state for printing, from the raw reads (pure: unit-tested). `raw`: { module, dev, token, quote, payees,
 * shares, lastDistributedAt, keeperServesQuote, due, assets: [{ asset, symbol, decimals, undistributed, owedTotal,
 * owed: bigint[] | null }] }. `ref`: how later commands name it (e.g. `--token 0x… --testnet`).
 */
export function formatSplit(raw, ref) {
  const token = raw.token && raw.token !== zeroAddress ? raw.token : null
  const quote = token && raw.quote && raw.quote !== zeroAddress ? raw.quote : null
  const isQuote = (a) => !!quote && a.toLowerCase() === quote.toLowerCase()
  const dev = String(raw.dev).toLowerCase()
  const payees = raw.payees.map((payee, index) => ({
    index, payee, pct: Number(raw.shares[index]) / 100, bps: Number(raw.shares[index]), ...(payee.toLowerCase() === dev && { isDev: true }),
  }))
  const next = []
  const assets = []
  for (const a of raw.assets) {
    const owedTotal = a.owedTotal ?? 0n
    const undistributed = a.undistributed ?? 0n
    // the bound quote always; another asset only when something of it is here
    if (!isQuote(a.asset) && undistributed === 0n && owedTotal === 0n) continue
    const f = (x) => formatUnits(x, a.decimals ?? 18)
    const owed = owedTotal > 0n && a.owed
      ? a.owed.map((x, index) => ({ index, payee: raw.payees[index], amount: f(x) })).filter((_, i) => a.owed[i] > 0n) : []
    const byKeeper = isQuote(a.asset) && raw.keeperServesQuote
    assets.push({
      asset: a.asset, symbol: a.symbol ?? null, ...(isQuote(a.asset) && { boundQuote: true }),
      undistributed: f(undistributed), owedTotal: f(owedTotal), ...(owed.length && { owed }),
      splitBy: byKeeper ? 'keeper (or anyone, gang split distribute)' : 'hand: gang split distribute (anyone)',
    })
    if (undistributed > 0n && !byKeeper) next.push(`gang split distribute ${ref} --asset ${a.asset}`)
    for (const o of owed) next.push(`gang split release ${ref} --asset ${a.asset} --index ${o.index}`)
  }
  const sym = (assets.find((x) => x.boundQuote)?.symbol) || quote
  const distribution = !token ? 'unbound' : raw.keeperServesQuote ? 'keeper' : 'manual'
  const keeperLine = distribution === 'unbound'
    ? `Not bound to a token yet (gang split bind --token <the token>): the keeper splits nothing until then; anyone can split by hand (gang split distribute --asset <addr>)`
    : distribution === 'keeper'
      ? `The keeper splits the bound quote (${sym}) once enough has gathered (0.05% of the pool's quote reserve, or after a day once it reaches 1/100 of that); anyone can split it sooner (gang split distribute)`
      : `The keeper does not serve this quote (${sym}): distribution is manual — run gang split distribute (anyone) to pay the payees`
  return {
    module: raw.module, moduleType: SPLIT_TYPE, dev: raw.dev, token, quote, ...(quote && { quoteSymbol: sym }),
    payees, distribution,
    keeper: { servesQuote: token ? !!raw.keeperServesQuote : null, due: !!raw.due, lastDistributedAt: iso(raw.lastDistributedAt) },
    assets,
    ...(next.length && { next }),
    note: 'the payees and shares are fixed for good: nobody (not the dev, not the platform) can change them; a payee can only '
      + 'move its own slot to another address (gang split set-payee). Every asset that reaches the module is split at these '
      + `shares, the first payee also taking the rounding dust. ${keeperLine}. Any other asset sent to it is split by hand `
      + '(gang split distribute --asset <addr>). A failed push is owed to that slot and paid with its next push, or by gang split release',
  }
}

/** Reads `asset`'s side of the module; null when it is not an ERC20 the module can read. */
async function assetRaw(read, module, asset, n) {
  let undistributed, owedTotal
  try {
    [undistributed, owedTotal] = await Promise.all([
      read(module, SPLIT_ABI, 'undistributed', [asset]), read(module, SPLIT_ABI, 'owedTotal', [asset]),
    ])
  } catch { return null }
  const [symbol, decimals, owed] = await Promise.all([
    read(asset, ERC20_ABI, 'symbol').catch(() => null),
    read(asset, ERC20_ABI, 'decimals').then(Number).catch(() => 18),
    owedTotal > 0n ? Promise.all(Array.from({ length: n }, (_, i) => read(module, SPLIT_ABI, 'owedOf', [asset, BigInt(i)]))) : null,
  ])
  return { asset, symbol, decimals, undistributed, owedTotal, owed }
}

/**
 * The module's state when `addr` is a GangSplitModule (split-v1); null when it is not (an EOA, a partner, another
 * module). Assets read: the bound quote, WBNB, the module's GANG (mainnet) and `extraAssets` (e.g. the quote of a token
 * paying it that is not the bound one).
 */
export async function splitOf(read, addr, { wbnb, extraAssets = [], ref } = {}) {
  if (!addr || addr === zeroAddress) return null
  let type
  try { type = await read(addr, SPLIT_ABI, 'moduleType') } catch { return null }
  if (hexToString(type, { size: 32 }).replace(/\0+$/, '') !== SPLIT_TYPE) return null
  const [dev, token, quote, [payees, shares], last, gangQuote, preview] = await Promise.all([
    read(addr, SPLIT_ABI, 'dev'), read(addr, SPLIT_ABI, 'token'), read(addr, SPLIT_ABI, 'quote'), read(addr, SPLIT_ABI, 'payeesOf'),
    read(addr, SPLIT_ABI, 'lastDistributedAt'), read(addr, SPLIT_ABI, 'gangQuote').catch(() => zeroAddress),
    read(addr, SPLIT_ABI, 'previewWork').catch(() => [false, 0n]),
  ])
  const keeperServesQuote = quote !== zeroAddress ? await read(addr, SPLIT_ABI, 'keeperServes', [quote]).catch(() => false) : false
  const seen = new Set()
  const list = [quote, wbnb, gangQuote, ...extraAssets].filter((a) => {
    if (!a || a === zeroAddress || seen.has(a.toLowerCase())) return false
    seen.add(a.toLowerCase())
    return true
  })
  const assets = (await Promise.all(list.map((a) => assetRaw(read, addr, a, payees.length)))).filter(Boolean)
  return formatSplit({
    module: addr, dev, token, quote, payees, shares, lastDistributedAt: last, keeperServesQuote, due: preview[0], assets,
  }, ref ?? (token !== zeroAddress ? `--token ${token}` : `--module ${addr}`))
}

function splitCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  if (!net.pad) throw new Error(NOT_ON_MAINNET)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const SUBS = ['status', 'distribute', 'release', 'set-payee', 'bind']
const USAGE = 'usage: gang split <status|distribute|release|set-payee|bind> --token <addr> (or --module <addr>) [--asset <addr>] [--index <i>] [--to <addr>] [--max <amount>] [--testnet] — see gang help'

/** `gang split <sub>`: the split module of a V3 token (its tax recipient), found from --token (or named by --module). */
export async function runSplit(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const testnet = flag('testnet')
  const rawOnly = flag('calldata')
  let ctx
  try { ctx = splitCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)
  const tn = testnet ? ' --testnet' : ''
  if (flag('token') && flag('module')) fail('give --token (its tax recipient is the module) or --module, not both')
  let token = null, module, tokenQuote = null
  if (flag('module')) {
    if (sub === 'bind') fail('gang split bind needs --token <the token> (it binds the token\'s own recipient)')
    module = opt('module')
    if (!isAddress(module ?? '')) fail('--module must be a split module address (0x…)', { got: module ?? null })
  } else {
    token = opt('token')
    if (!isAddress(token ?? '')) fail('--token must be a V3 token address (0x…), or name the module with --module <addr>', { got: token ?? null })
    if ((await atTokenPad(ctx, token)) === null) return fail(KIND_UNREAD.error, { token: token, retry: KIND_UNREAD.retry }) // else on the pad of the token's generation
    try {
      const [creator, quote] = await ctx.read(ctx.pad, PAD_ABI, 'curves', [token])
      if (creator === zeroAddress) throw new Error('not a curve')
      tokenQuote = quote
      module = (await ctx.read(ctx.pad, PAD_ABI, 'taxConfigOf', [token]))[3]
    } catch {
      return fail(`not a V3 token on this pad (${testnet ? 'BSC testnet' : 'BSC mainnet'}${testnet ? '' : '; add --testnet for a testnet token'})`, { token, chainId })
    }
  }
  const ref = `${token ? `--token ${token}` : `--module ${module}`}${tn}`
  const s = await splitOf(ctx.read, module, { wbnb: ctx.wbnb, extraAssets: tokenQuote && tokenQuote !== zeroAddress ? [tokenQuote] : [], ref })
  if (!s) {
    return fail(token ? 'this token\'s tax recipient is not a split module' : 'not a split module (split-v1)',
      { ...(token && { token }), recipient: module === zeroAddress ? null : module })
  }
  // the token pays this module but the module is bound to another one: the keeper never splits this token's tax
  const decoy = token && s.token && s.token.toLowerCase() !== token.toLowerCase()
  const warning = decoy
    ? `this token pays its tax to the module, but the module is bound to another token (${s.token}): the keeper splits only that token's quote; this token's tax (${tokenQuote}) is split only by hand (gang split distribute ${ref} --asset ${tokenQuote})`
    : null
  const me = () => walletFor(ctx, opt('from'))
  const send = async (functionName, args, extra) => {
    const sim = await simulateSplit(ctx.client, me(), s.module, SPLIT_ABI, functionName, args)
    if (sim.failed) return out({ success: false, step: extra.step, ...sim.failed })
    const data = encodeFunctionData({ abi: SPLIT_ABI, functionName, args })
    // no gas field: the wallet / node estimates it (GAS_NOTE)
    return out(step(ctx, { from: me(), to: s.module, data }, { chainId, ...(token && { token }), module: s.module, ...extra }, rawOnly, summarize))
  }
  /** --asset <addr | wbnb>, else `def` (the bound quote, or the token's own quote while unbound). */
  const assetArg = (def) => {
    if (!flag('asset')) {
      if (!def) fail('the module is not bound to a token yet: give --asset <addr> (what to split), or bind it first (gang split bind --token <the token>)')
      return def
    }
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
  const defaultAsset = s.quote ?? (tokenQuote && tokenQuote !== zeroAddress ? tokenQuote : null)

  if (sub === 'status') return out({ success: true, chainId, ...s, ...(warning && { warning }) })

  if (sub === 'bind') {
    if (s.token) return fail('already bound', { boundTo: s.token, ...(warning && { warning }) })
    return send('bind', [token], { step: 'bind', note: 'anyone may bind (once); the token must be the dev\'s and pay its tax to this module. It decides which quote the keeper splits' })
  }

  if (sub === 'distribute') {
    const asset = assetArg(defaultAsset)
    const a = await assetState(asset)
    if (a.undistributed === 0n) {
      return fail('nothing of this asset is waiting to be split', {
        asset, symbol: a.symbol, owedTotal: a.f(a.owedTotal),
        ...(a.owedTotal > 0n && { hint: `what is held is owed to payees after failed pushes: gang split release ${ref} --asset ${asset} --index <i>` }),
      })
    }
    // as the contract: the others rounded down, the first payee the rest
    const amounts = s.payees.map((p) => (a.undistributed * BigInt(p.bps)) / BigInt(BPS))
    amounts[0] = a.undistributed - amounts.slice(1).reduce((x, y) => x + y, 0n)
    const parts = s.payees.map((p, i) => ({ index: p.index, payee: p.payee, pct: p.pct, gets: a.f(amounts[i]) }))
    return send('distribute', [asset], {
      step: 'distribute', asset, symbol: a.symbol, amount: a.f(a.undistributed), parts,
      note: `anyone may: splits what of this asset arrived since its last split at the fixed shares (the first payee also takes the rounding dust); a push that fails is owed to that slot. Gas: ${GAS_NOTE}`,
    })
  }

  if (sub === 'release') {
    const asset = assetArg(defaultAsset)
    const a = await assetState(asset)
    let index
    if (flag('index')) index = indexArg(opt('index'), s.payees.length, fail)
    else {
      const mine = s.payees.find((p) => p.payee.toLowerCase() === String(me()).toLowerCase())
      const owedSlots = (a.owed ?? []).map((x, i) => (x > 0n ? i : -1)).filter((i) => i >= 0)
      if (mine) index = mine.index
      else if (owedSlots.length === 1) index = owedSlots[0]
      else fail('--index <i> required: which payee slot to pay (gang split status lists what each is owed)', { owedSlots })
    }
    const owed = a.owed ? a.owed[index] : 0n
    if (owed === 0n) return fail(HINTS.NothingOwed, { asset, symbol: a.symbol, index, payee: s.payees[index].payee })
    let max = maxUint256
    if (flag('max')) max = parseUnits(parseAmount(fail, 'max', opt('max')), a.decimals)
    const amount = owed < max ? owed : max
    return send('release', [asset, BigInt(index), max], {
      step: 'release', asset, symbol: a.symbol, index, payee: s.payees[index].payee, amount: a.f(amount), owed: a.f(owed),
      note: `anyone may: splits what newly arrived of this asset first, then pushes ${max === maxUint256 ? 'all' : 'up to --max'} of what this slot is owed to its payee (reverts while it still cannot receive; nothing owed is lost). Gas: ${GAS_NOTE}`,
    })
  }

  // set-payee: only the slot's own payee; the index is the wallet's own slot unless given
  const wallet = String(me()).toLowerCase()
  const mine = s.payees.find((p) => p.payee.toLowerCase() === wallet)
  let index
  if (flag('index')) index = indexArg(opt('index'), s.payees.length, fail)
  else if (mine) index = mine.index
  else return fail('this wallet is not a payee of this module: only a slot\'s own payee can move it', { wallet: me(), payees: s.payees.map((p) => p.payee) })
  const slot = s.payees[index]
  if (slot.payee.toLowerCase() !== wallet) return fail(HINTS.NotPayee, { index, payee: slot.payee, wallet: me() })
  const to = opt('to')
  if (!isAddress(to ?? '') || to === zeroAddress) fail('--to <0x…> required (checksummed or all lowercase): the address this slot is paid to from now on', { got: to ?? null })
  if (to.toLowerCase() === s.module.toLowerCase()) return fail(HINTS.BadPayee, { to })
  const taken = s.payees.find((p) => p.payee.toLowerCase() === to.toLowerCase())
  if (taken) return fail(taken.index === index ? 'that is this slot\'s payee already' : HINTS.DuplicatePayee, { to, index: taken.index })
  // the contract splits only the bound quote before the move: what else arrived would go to the new address, so split
  // those first (review I-3); each is its own tx, then the same command again
  const unsplit = s.assets.filter((x) => !x.boundQuote && Number(x.undistributed) > 0)
  if (unsplit.length) {
    const first = unsplit[0]
    return send('distribute', [first.asset], {
      step: 'distribute-first', asset: first.asset, symbol: first.symbol, amount: first.undistributed,
      ...(unsplit.length > 1 && { thenAlso: unsplit.slice(1).map((x) => ({ asset: x.asset, symbol: x.symbol, amount: x.undistributed })) }),
      note: `before the move: ${first.symbol || first.asset} that arrived earlier is split to the current payees (the contract splits only the bound quote itself). After executing, re-run the same command. Gas: ${GAS_NOTE}`,
    })
  }
  return send('setPayee', [BigInt(index), getAddress(to)], {
    step: 'set-payee', index, pct: slot.pct, fromPayee: slot.payee, toPayee: getAddress(to),
    note: `applies at once; the share (${slot.pct}%) stays with the slot. The bound quote that arrived before is split first (to the current address); what this slot is owed (any asset) goes to the new one. Gas: ${GAS_NOTE}`,
  })
}

function indexArg(raw, n, fail) {
  const i = Number(raw)
  if (!Number.isInteger(i) || i < 0 || i >= n) fail(`--index must be a payee slot: the contract's 0-based index, 0 to ${n - 1} (gang split status lists them)`, { got: raw ?? null })
  return i
}
