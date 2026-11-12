import { createPublicClient, formatEther, hexToString, parseAbi, parseEther, encodeFunctionData, decodeEventLog, isAddress, zeroAddress } from 'viem'
import { bsc } from 'viem/chains'
import { SOFT_ABI, V2_ABI, S_ABI, ERC20_ABI, WBNB_ABI } from './abi.js'
import { genOf, padNets, rpcTransport } from './gangpad.js'
import { mapLimit } from './limit.js'

export const ADDR = {
  v2: '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E',
  softFirst: '0x315Ba2e8952D06094CC636b2B84229FA32fb23A7', // holds the Soft tokens, GANG included
  softLater: '0x4E6f13c8A453c1b8b4E20b590082bb233a5b80d7', // same ABI, no tokens yet
  u: '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb',
  s: '0x60aee38576035E757deD30fF8db8A8DA476430C1',
  wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
}

export const CONFIG = {
  chainId: '56',
}

// GANG_RPC_URL or the public nodes (gangpad.js), shared with the GangLaunchpad clients
export const client = createPublicClient({ chain: bsc, transport: rpcTransport(padNets('v3').mainnet.rpcs) })
export const fmt = (wei) => formatEther(wei)
export const fmtTok = (units) => Number(formatEther(units)).toLocaleString('en-US', { maximumFractionDigits: 2 })
export { parseEther, encodeFunctionData, isAddress, zeroAddress }

const erc = (address, functionName, args = []) => client.readContract({ address, abi: ERC20_ABI, functionName, args })
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args })

const PADS = [
  { id: 'v2', address: ADDR.v2, kind: 'v2', abi: V2_ABI },
  { id: 'soft', address: ADDR.softFirst, kind: 'soft', abi: SOFT_ABI },
  { id: 'soft', address: ADDR.softLater, kind: 'soft', abi: SOFT_ABI },
  { id: 'u', address: ADDR.u, kind: 'v2', abi: V2_ABI },
  { id: 's', address: ADDR.s, kind: 'v2', abi: S_ABI }, // 9-field Curve (no taxed): see S_ABI
]

const GANG_POINTER = {
  v3: (t) => `a GangLaunchpad V3 (bonding-curve) token: gang info|buy|sell|status --token ${t} trade it (re-run if this was an RPC hiccup)`,
  fair: (t) => `a GangLaunchpad 打新 (fair-mint) token: gang info|status --token ${t}; before launch gang mint / withdraw, after it gang buy / sell (re-run if this was an RPC hiccup)`,
  fly: (t) => `a GangLaunchpad 3.0 铸币飞轮 (Mint Flywheel) token: gang info|status --token ${t}; gang mint / withdraw, after launch also gang buy / sell (re-run if this was an RPC hiccup)`,
}

/** Resolve which pad hosts `token` by probing curves(token).creator != 0; a GangLaunchpad token is pointed at its command. */
export async function resolvePad(token) {
  for (const pad of PADS) {
    try {
      const c = await read(pad.address, pad.abi, 'curves', [token])
      const creator = Array.isArray(c) ? c[0] : c.creator
      if (creator && creator !== zeroAddress) {
        return { ...pad, curve: c }
      }
    } catch { /* wrong ABI shape or empty */ }
  }
  // tokens from `gang create` / `gang fair create` live on GangLaunchpad, which these commands don't trade
  const { kind } = await genOf({ gens: padNets('v3').mainnet.gens, read }, token)
  if (GANG_POINTER[kind]) throw new Error(`${token} is ${GANG_POINTER[kind](token)}`)
  throw new Error(
    `not a Gang token on known pads (V2/Soft/U/S): ${token}. ` +
    `Upgrade: npm i -g @gangfun/cli@latest  OR  npm i -g github:gangfun/cli`,
  )
}

function softInfoFromCurve(c) {
  const [creator, realBnb, sold, graduated, pair] = c
  return { kind: 'soft', creator, raised: realBnb, sold, graduated, pair, quote: ADDR.wbnb, gradAmt: null, taxed: false, virtualQuote: null, refPair: null }
}

function v2InfoFromCurve(c) {
  const [creator, quote, realQuote, sold, gradAmt, virtualQuote, graduated, taxed, pair, refPair] = c
  return { kind: 'v2', creator, raised: realQuote, sold, graduated, pair, quote, gradAmt, taxed, virtualQuote, refPair }
}

/** LaunchpadS: no `taxed` field — every S token is a TaxLaunchToken (1% pool tax). */
function sInfoFromCurve(c) {
  const [creator, quote, realQuote, sold, gradAmt, virtualQuote, graduated, pair, refPair] = c
  return { kind: 'v2', creator, raised: realQuote, sold, graduated, pair, quote, gradAmt, taxed: true, virtualQuote, refPair }
}

/** The curve of a resolved pad in one shape, whatever the pad's layout. */
const curveInfo = (pad) => (pad.kind === 'soft' ? softInfoFromCurve(pad.curve) : pad.id === 's' ? sInfoFromCurve(pad.curve) : v2InfoFromCurve(pad.curve))

const PAIR_ABI = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)'])

/** A graduated Soft token's price in its PancakeSwap pool (always against WBNB): BNB per token, 1e18 scale. */
async function softPoolPrice(token, pair) {
  const [[r0, r1], t0] = await Promise.all([read(pair, PAIR_ABI, 'getReserves'), read(pair, PAIR_ABI, 'token0')])
  const [tokenReserve, bnbReserve] = t0.toLowerCase() === token.toLowerCase() ? [r0, r1] : [r1, r0]
  return tokenReserve > 0n ? (bnbReserve * 10n ** 18n) / tokenReserve : null
}

export async function tokenInfo(token, me) {
  const pad = await resolvePad(token)
  const base = curveInfo(pad)
  const [name, symbol] = await Promise.all([erc(token, 'name'), erc(token, 'symbol')])
  let locked = null
  try { locked = await erc(token, 'locked') } catch { /* */ }
  // the wallet cap is the curve's: a graduated token has none
  let cap = null
  if (!base.graduated) try { cap = await read(pad.address, pad.abi, 'MAX_PER_WALLET') } catch { /* */ }

  let price = null
  if (pad.kind === 'soft') {
    try { price = base.graduated ? await softPoolPrice(token, base.pair) : await read(pad.address, pad.abi, 'spotPrice', [token]) } catch { /* */ }
  } else if (base.virtualQuote && base.virtualQuote > 0n) {
    // spot ≈ virtualQuote / (VIRTUAL_TOKEN - sold) * 1e18-ish; expose raised/grad instead
    const vq = BigInt(base.virtualQuote)
    const sold = BigInt(base.sold)
    const VIRTUAL_TOKEN = 1066666666666666666666666667n
    const tReserve = VIRTUAL_TOKEN - sold
    if (tReserve > 0n) price = (vq * 10n ** 18n) / tReserve
  }

  const grad = base.gradAmt != null ? BigInt(base.gradAmt) : (pad.kind === 'soft' ? await read(pad.address, pad.abi, 'GRADUATION_BNB') : 15n * 10n ** 18n)
  // a graduated Soft curve's realBnb went to the pool: it raised its whole target
  const raised = pad.kind === 'soft' && base.graduated ? grad : BigInt(base.raised)
  const info = {
    token, name, symbol, creator: base.creator, graduated: base.graduated,
    pair: base.graduated ? base.pair : null, locked,
    pad: pad.id, padAddress: pad.address, kind: base.kind,
    quote: base.quote, taxed: !!base.taxed,
    priceBnb: price != null ? Number(price) / 1e18 : null,
    fdvBnb: price != null ? (Number(price) / 1e18) * 1e9 : null,
    raisedBnb: fmt(raised), graduationBnb: fmt(grad),
    progressPct: grad > 0n ? Number((raised * 10000n) / grad) / 100 : 0,
    soldTokens: fmtTok(base.sold), walletCapTokens: cap != null ? fmtTok(cap) : null,
    logoURI: null,
  }
  if (pad.kind === 'v2') {
    try { info.logoURI = await read(pad.address, pad.abi, 'logoURIOf', [token]) } catch { /* U/S may lack */ }
  }
  if (me) {
    const bal = await erc(token, 'balanceOf', [me])
    info.myBalance = fmtTok(bal); info.myBalanceRaw = bal.toString()
    if (!base.graduated) try {
      const room = await read(pad.address, pad.abi, 'walletRoom', [token, me])
      info.myRoomTokens = fmtTok(room); info.myRoomRaw = room.toString()
    } catch { /* */ }
  }
  return info
}

/**
 * `gang list` without --kind: the newest `perPad` tokens of each V2 / Soft / U / S pad, read on chain (the fallback when
 * gang.fun's API is down). Reading every token of every pad took minutes (LaunchpadV2 alone has hundreds), so the
 * newest first, a few reads at a time. → { tokens, pads: [{ pad, address, total, listed }] }
 */
export async function listTokens(me, perPad = 20) {
  const tokens = []
  const pads = []
  for (const pad of PADS) {
    try {
      const n = Number(await read(pad.address, pad.abi, 'tokenCount'))
      const idx = Array.from({ length: Math.min(n, perPad) }, (_, i) => BigInt(n - 1 - i))
      const addrs = await mapLimit(idx, 8, (i) => read(pad.address, pad.abi, 'allTokens', [i]))
      const infos = await mapLimit(addrs, 8, (a) => tokenInfo(a, me).catch(() => null))
      const listed = infos.filter(Boolean)
      tokens.push(...listed)
      pads.push({ pad: pad.id, address: pad.address, total: n, listed: listed.length })
    } catch { pads.push({ pad: pad.id, address: pad.address, total: null, listed: 0, error: 'pad unreadable' }) }
  }
  return { tokens, pads }
}

/** LaunchpadV2 curve constants (LaunchpadV2.sol) — unique off-chain path = on-chain math. */
const V2_VIRTUAL_TOKEN = 1066666666666666666666666667n
const V2_BPS = 10000n
const V2_PROTOCOL_FEE_BPS = 100n // 1%

const ceilDiv = (a, b) => (b === 0n ? 0n : (a + b - 1n) / b)

/** Contract-equivalent buy quote (_prepBuy + _tokensOut / _quoteInFor). No Soft/U/S fallback. */
function v2QuoteBuyFromCurve(base, quoteIn, room) {
  const vq = BigInt(base.virtualQuote)
  const sold = BigInt(base.sold)
  const raised = BigInt(base.raised)
  const gradAmt = BigInt(base.gradAmt)
  const tokensOutOf = (net) => {
    const k = vq * V2_VIRTUAL_TOKEN
    const qReserve = vq + raised
    const tReserve = V2_VIRTUAL_TOKEN - sold
    const newT = ceilDiv(k, qReserve + net)
    return tReserve - newT
  }
  const quoteInFor = (tokensOut) => {
    const k = vq * V2_VIRTUAL_TOKEN
    const qReserve = vq + raised
    const tReserve = V2_VIRTUAL_TOKEN - sold
    return ceilDiv(k, tReserve - tokensOut) - qReserve
  }
  const recomputeFee = (gross, netIn) => {
    let spentGross = ceilDiv(netIn * V2_BPS, V2_BPS - V2_PROTOCOL_FEE_BPS)
    if (spentGross > gross) spentGross = gross
    const taxPlat = (spentGross * V2_PROTOCOL_FEE_BPS) / V2_BPS
    const net = spentGross - taxPlat
    const refundGross = gross - spentGross
    return { taxPlat, net, refundGross, spentGross }
  }

  let taxPlat = (quoteIn * V2_PROTOCOL_FEE_BPS) / V2_BPS
  let net = quoteIn - taxPlat
  let refundGross = 0n
  const remaining = gradAmt > raised ? gradAmt - raised : 0n
  if (net > remaining) {
    net = remaining
    ;({ taxPlat, net, refundGross } = recomputeFee(quoteIn, net))
    if (net > remaining) net = remaining
  }
  let tokensOut = tokensOutOf(net)
  if (room != null && tokensOut > room) {
    tokensOut = room
    net = quoteInFor(room)
    ;({ taxPlat, net, refundGross } = recomputeFee(quoteIn, net))
  }
  return { tokensOut, spent: quoteIn - refundGross, fee: taxPlat, refund: refundGross }
}

/** Contract-equivalent sell quote (_quoteOut + 1% platform fee). */
function v2QuoteSellFromCurve(base, tokensIn) {
  const vq = BigInt(base.virtualQuote)
  const sold = BigInt(base.sold)
  const raised = BigInt(base.raised)
  const k = vq * V2_VIRTUAL_TOKEN
  const qReserve = vq + raised
  const tReserve = V2_VIRTUAL_TOKEN - sold
  const newQ = ceilDiv(k, tReserve + tokensIn)
  const quoteOut = qReserve - newQ
  const fee = (quoteOut * V2_PROTOCOL_FEE_BPS) / V2_BPS
  return { out: quoteOut - fee, fee }
}

export async function quoteBuy(token, buyer, amountHuman) {
  const pad = await resolvePad(token)
  if (curveInfo(pad).graduated) {
    throw new Error(`${token} has graduated: it trades in its PancakeSwap pool, not on the curve. gang buy --amount <n> builds that trade`)
  }
  const gross = parseEther(amountHuman)
  if (pad.kind === 'soft') {
    const [tokensOut, bnbIn, fee, refund] = await read(pad.address, pad.abi, 'quoteBuy', [token, buyer, gross])
    return { kind: 'soft', pad: pad.id, padAddress: pad.address, amountHuman, tokensOut, spent: bnbIn, fee, refund,
      tokensOutFmt: fmtTok(tokensOut), spentFmt: fmt(bnbIn), feeFmt: fmt(fee), refundFmt: fmt(refund), unit: 'BNB',
      quotePath: 'onchain-quoteBuy' }
  }
  // Unique path: LaunchpadV2.sol _prepBuy / _tokensOut / _quoteInFor (no on-chain quoteBuy view).
  const base = curveInfo(pad)
  let room = null
  try { room = await read(pad.address, pad.abi, 'walletRoom', [token, buyer]) } catch { /* */ }
  const q = v2QuoteBuyFromCurve(base, gross, room)
  return { kind: 'v2', pad: pad.id, padAddress: pad.address, quote: base.quote, amountHuman,
    tokensOut: q.tokensOut, spent: q.spent, fee: q.fee, refund: q.refund,
    tokensOutFmt: fmtTok(q.tokensOut), spentFmt: fmt(q.spent), feeFmt: fmt(q.fee), refundFmt: fmt(q.refund),
    unit: 'quote', quotePath: 'LaunchpadV2.sol#_prepBuy', deterministic: true }
}

export async function quoteSell(token, tokensIn) {
  const pad = await resolvePad(token)
  if (pad.kind === 'soft') {
    const [bnbToUser, fee] = await read(pad.address, pad.abi, 'quoteSell', [token, tokensIn])
    return { kind: 'soft', pad: pad.id, padAddress: pad.address, tokensIn, out: bnbToUser, fee,
      tokensInFmt: fmtTok(tokensIn), outFmt: fmt(bnbToUser), feeFmt: fmt(fee), unit: 'BNB',
      quotePath: 'onchain-quoteSell' }
  }
  const base = curveInfo(pad)
  const q = v2QuoteSellFromCurve(base, tokensIn)
  return { kind: 'v2', pad: pad.id, padAddress: pad.address, quote: base.quote, tokensIn, out: q.out, fee: q.fee,
    tokensInFmt: fmtTok(tokensIn), outFmt: fmt(q.out), feeFmt: fmt(q.fee), unit: 'quote',
    quotePath: 'LaunchpadV2.sol#_quoteOut', deterministic: true }
}

export async function isAgent(account) {
  // Prefer V2 gate (create path); fall back Soft.
  try { return await read(ADDR.v2, V2_ABI, 'isAgent', [account]) } catch { /* */ }
  try { return await read(ADDR.softFirst, SOFT_ABI, 'isAgent', [account]) } catch { /* */ }
  return false
}

export const balanceOf = (token, a) => erc(token, 'balanceOf', [a])
export async function allowance(token, owner, spender) {
  return erc(token, 'allowance', [owner, spender])
}

export const calldata = {
  softBuy: (token, minTokensOut) => encodeFunctionData({ abi: SOFT_ABI, functionName: 'buy', args: [token, minTokensOut] }),
  softSell: (token, tokensIn, minBnbOut) => encodeFunctionData({ abi: SOFT_ABI, functionName: 'sell', args: [token, tokensIn, minBnbOut] }),
  v2Buy: (token, quoteIn, minTokensOut) => encodeFunctionData({ abi: V2_ABI, functionName: 'buy', args: [token, quoteIn, minTokensOut] }),
  v2Sell: (token, tokensIn, minQuoteOut) => encodeFunctionData({ abi: V2_ABI, functionName: 'sell', args: [token, tokensIn, minQuoteOut] }),
  approve: (spender, amount) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
  wrap: () => encodeFunctionData({ abi: WBNB_ABI, functionName: 'deposit' }),
}

/**
 * Events of the logs that decode with one of `abis`, each with the emitting contract: GangLaunchpad logs, which `gang tx`
 * reads beside the V2 / Soft / U / S pads'. Integers stay as on chain (strings), marked `units: 'raw'`: amounts are in wei
 * (18 decimals), bps / shares / counts as they are; the V2 / Soft events are formatted (no `units`).
 */
export function decodeLogs(logs, abis, firstFor = null) {
  const events = []
  for (const log of logs) {
    // an event signature several module kinds share (Split with three amounts): the emitting module's own ABI first
    const first = firstFor ? firstFor(log) : null
    for (const abi of first ? [...first, ...abis] : abis) {
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics })
        events.push({
          event: ev.eventName, contract: log.address, units: 'raw', ...(first === UNKNOWN_KIND_ABI && { kindUnread: true }),
          ...Object.fromEntries(Object.entries(ev.args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
        })
        break
      } catch { /* other contract / event */ }
    }
  }
  return events
}

const MODULE_TYPE_ABI = parseAbi(['function moduleType() view returns (bytes32)'])
/** What a shared-signature event decodes to when its module's kind could not be read: no kind's field names are guessed. */
const UNKNOWN_KIND_ABI = [parseAbi(['event Split(uint256 incoming, uint256 firstPart, uint256 secondPart)'])]

/**
 * For logs whose topic0 is `topic` — an event signature several module kinds share, whose fields mean different things
 * in each — the decoder of the emitting module's own kind, asked of its moduleType(): `byType(kind)`. A module whose
 * kind is unread or unknown decodes with neutral field names and `kindUnread: true`, never with another kind's.
 */
export async function firstByModuleType(c, logs, topic, byType) {
  const addrs = [...new Set(logs.filter((l) => l.topics[0] === topic).map((l) => l.address.toLowerCase()))]
  const types = new Map(await Promise.all(addrs.map(async (a) => [a, await c.readContract({ address: a, abi: MODULE_TYPE_ABI, functionName: 'moduleType' })
    .then((t) => hexToString(t, { size: 32 }).replace(/\0+$/, '')).catch(() => null)])))
  return (log) => (log.topics[0] === topic ? byType(types.get(log.address.toLowerCase())) ?? UNKNOWN_KIND_ABI : null)
}

/**
 * `extraAbis`: decoders for logs not from the V2 / Soft / U / S pads (see decodeLogs). `shared`: { topic, byType } for
 * an event signature several module kinds share (firstByModuleType).
 */
export async function decodeTx(hash, extraAbis = [], shared = null) {
  const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  const firstFor = shared ? await firstByModuleType(client, r.logs, shared.topic, shared.byType) : null
  const events = []
  const known = new Map(PADS.map((p) => [p.address.toLowerCase(), p]))
  for (const log of r.logs) {
    const pad = known.get(log.address.toLowerCase())
    if (!pad) {
      events.push(...decodeLogs([log], extraAbis, firstFor))
      continue
    }
    try {
      const ev = decodeEventLog({ abi: pad.abi, data: log.data, topics: log.topics })
      const a = Object.fromEntries(Object.entries(ev.args).map(([k, v]) => {
        if (typeof v !== 'bigint') return [k, v]
        const lk = k.toLowerCase()
        if (lk.includes('token') && k !== 'token' && !lk.includes('amount')) return [k, fmtTok(v)]
        return [k, fmt(v)]
      }))
      events.push({ event: ev.eventName, pad: pad.id, ...a })
    } catch { /* */ }
  }
  return { hash, status: r.status, block: Number(r.blockNumber), events }
}
