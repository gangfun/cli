/**
 * `gang portfolio`: one wallet's holdings on every gang.fun track (V3, 打新, 铸币飞轮, V2 / Soft / U / S) in one answer, plus its
 * trading record, the bonds on the tokens it launched and the creator fee they keep for it (GangLaunchpad 2.0).
 *
 * Which tokens: gang.fun's index of the wallet's curve and sale trades (/agents/<addr>/positions), which also gives the
 * cost basis, the average price, the realized PnL and the USD price of each quote. Balance, value and what is claimable
 * are then read on chain, with the same reads as `gang status` (statusOf). A token the wallet only received by transfer,
 * or only bought on PancakeSwap, is not in that index and so not listed. Mainnet only: gang.fun indexes no testnet.
 */

import { mapLimit } from './limit.js'

const MAX_LAUNCHES = 100 // bonds are looked up on the newest launches up to this many

const num = (v) => (v == null || v === '' ? null : Number(v))
// display rounding of values (balances stay as read, an agent may sell them): 6 significant digits, no float noise
const round = (x) => (x == null || !Number.isFinite(x) ? null : Number(x.toPrecision(6)))
const usd = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100)
const sameAmount = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-9


const KIND = { v3: 'v3', fair: 'fair', fly: 'fly', main: 'legacy', stocks: 'legacy' }

/**
 * One indexed position + its on-chain status → a holding, or null when nothing is left (no balance, no shares, nothing
 * to claim). value: what the holding is worth now in its quote, and `valueBasis` says how it was priced.
 */
function holdingOf(p, kind, s) {
  const quoteUsd = num(p.quoteUsd) ?? (num(p.valueUsd) != null && num(p.valueQuote) > 0 ? num(p.valueUsd) / num(p.valueQuote) : null)
  const base = { token: p.address, symbol: p.symbol, kind, track: p.track, quote: p.quoteSymbol }
  let balance = null, shares = null, value = null, valueBasis = null, claimable = null, graduated = false, extra = {}
  // what the index holds for this wallet: tokens bought on the curve minus sold (at graduation for a graduated one)
  const indexed = num(p.balance ?? p.balanceAtGrad)

  if (kind === 'v3') {
    graduated = !!s.graduated
    balance = num(s.balance)
    if (graduated) {
      value = num(s.poolSellAll?.expectOut) ?? (balance === 0 ? 0 : null)
      valueBasis = s.poolSellAll ? 'selling it all into the pool now, tax included' : null
    } else {
      value = balance != null && num(p.priceQuote) != null ? balance * num(p.priceQuote) : null
      valueBasis = 'last curve price (a sell pays the 1% curve fee on top)'
    }
    if (num(s.dividendPct) > 0) claimable = num(s.dividend?.claimable)
  } else if (kind === 'fair') {
    const pos = s.position || {}
    graduated = !!s.sale?.launched
    shares = num(pos.shares)
    if (!graduated) {
      // before launch the tokens sit in the pad: the position is shares, worth what withdrawing them all pays now
      balance = num(pos.baselineTokens)
      value = num(pos.sellBackAll) ?? (shares ? null : 0)
      valueBasis = 'withdrawing every share now (gang withdraw --all)'
    } else {
      balance = num(pos.balance)
      value = num(pos.poolSellAll?.expectOut) ?? (balance === 0 ? 0 : null)
      valueBasis = pos.poolSellAll ? 'selling it all into the pool now, tax included' : null
      claimable = num(pos.pendingReward)
      extra = {
        reward: pos.reward ?? null,
        ...(pos.sellableBeforeOut != null && { sellableBeforeOut: pos.sellableBeforeOut }),
        ...(pos.note && { note: pos.note }),
      }
    }
  } else if (kind === 'fly') {
    // 铸币飞轮: the minted tokens are in the wallet from the first mint (locked until launch)
    const pos = s.position || {}
    graduated = !!s.sale?.launched
    shares = num(pos.preShares)
    balance = num(pos.balance)
    if (!graduated) {
      // filled and waiting for its launch: no sell-back (it reopens only if the launch does not come within 7 days)
      value = num(pos.sellBackAll) ?? (shares ? null : 0)
      valueBasis = pos.sellBackAll != null ? 'selling every pre-launch share back now (gang withdraw --all)' : 'sell-back is closed until the launch'
      extra = { saleStatus: s.sale?.status ?? null, ...(s.sale?.sellBackOpen === false && { sellBackOpen: false }) }
    } else {
      value = num(pos.poolSellAll?.expectOut) ?? (balance === 0 ? 0 : null)
      valueBasis = pos.poolSellAll ? 'selling it all into the pool now, tax included' : null
      claimable = num(pos.pendingReward)
      extra = {
        reward: pos.reward ?? null, quotaLeft: pos.quotaLeft ?? null,
        ...(pos.sellableBeforeOut != null && { sellableBeforeOut: pos.sellableBeforeOut }),
        ...(pos.note && { note: pos.note }),
      }
    }
  } else {
    graduated = !!s.graduated
    // myBalance is formatted with thousands separators: the raw wei is the number
    balance = s.myBalanceRaw != null ? Number(BigInt(s.myBalanceRaw)) / 1e18 : null
    if (!graduated && balance != null && num(p.priceQuote) != null) {
      value = balance * num(p.priceQuote)
      valueBasis = 'last curve price (a sell pays the curve fee on top)'
    } else if (balance === 0) {
      value = 0
    } else {
      extra = { valueNote: `not priced: gang sell --token ${p.address} --all previews what the pool pays` }
    }
  }

  // what is held: shares while a 打新 sale is minting (the tokens sit in the pad), tokens otherwise (after launch the
  // shares only record what was minted)
  const minting = (kind === 'fair' || kind === 'fly') && !graduated
  const held = minting ? shares : balance
  if (!(held > 0) && !(claimable > 0)) return null

  // the cost basis covers what the index saw; once the balance moved outside it (a transfer, a PancakeSwap trade) it
  // no longer describes these tokens
  const costComparable = sameAmount(balance, indexed)
  const cost = num(p.costQuote)
  const unrealized = costComparable && value != null && cost != null ? value - cost : null
  const next = []
  // a filled 铸币飞轮 sale takes no sell-back: it launches next (anyone may), then its tokens sell in the pool
  const filled = kind === 'fly' && minting && s.sale?.sellBackOpen === false
  if (held > 0) {
    next.push(filled ? `gang fly launch --token ${p.address}` : minting ? `gang withdraw --token ${p.address} --all` : `gang sell --token ${p.address} --all`)
  }
  if (claimable > 0) next.push(`gang claim --token ${p.address}`)
  return {
    ...base,
    status: kind === 'fly' && minting ? (s.sale?.status ?? 'minting') : minting ? 'minting' : graduated ? (kind === 'fair' || kind === 'fly' ? 'launched' : 'graduated') : 'curve',
    balance, ...(shares != null && { shares }),
    value: round(value), valueUsd: quoteUsd != null && value != null ? usd(value * quoteUsd) : null, valueBasis,
    cost: round(cost), avgPrice: num(p.avgPrice),
    unrealized: round(unrealized), unrealizedUsd: quoteUsd != null && unrealized != null ? usd(unrealized * quoteUsd) : null,
    ...(!costComparable && {
      costNote: 'the balance moved outside the curve / sale trades gang.fun indexes (a transfer or a PancakeSwap trade): cost and unrealized do not describe it',
    }),
    realized: round(num(p.realizedQuote)), realizedUsd: num(p.realizedUsd),
    claimable: round(claimable), claimableUsd: quoteUsd != null && claimable != null ? usd(claimable * quoteUsd) : null,
    quoteUsd,
    ...extra,
    link: `https://gang.fun/token/${p.address}`,
    next,
  }
}

/**
 * A holding the wallet bonded (its own active bond): selling below the bonded X loses the bond, so the holding says how
 * much can go and `next` sells at most that (gang sell refuses more without --break-bond anyway).
 */
function withBond(h, b) {
  // the bond's own headroom (creator balance − X, exact; negative once broken), so the amount never rounds up past it
  const free = b.headroomTokens == null ? null : String(b.headroomTokens).startsWith('-') ? '0' : String(b.headroomTokens)
  const rest = h.next.filter((c) => !c.startsWith('gang sell '))
  return {
    ...h,
    bonded: {
      holdTokens: num(b.holdTokens), sellableKeepingBond: num(free), deadline: b.deadline ?? null,
      note: 'selling below holdTokens before the bond is settled loses the whole bond',
    },
    next: [...(num(free) > 0 ? [`gang sell --token ${h.token} --amount ${free}`] : []), ...rest, `gang bond status --token ${h.token}`],
  }
}

/** A bond view (`gang bond status`) → the fields a portfolio shows; null when the token has none. */
function bondRow(l, b) {
  if (!b || b.state === 'none') return null
  return {
    token: l.address, symbol: l.symbol, state: b.state, bond: b.bond ?? null, quote: b.quote ?? null,
    holdTokens: b.holdTokens ?? null, creatorBalance: b.creatorBalance ?? null, headroomTokens: b.headroomTokens ?? null,
    ...(b.violated != null && { violated: b.violated }), ...(b.phase && { phase: b.phase }), deadline: b.deadline ?? null,
    ...(b.note && { note: b.note }),
    next: `gang bond status --token ${l.address}`,
  }
}

/**
 * wallet: 0x address. get(path) → JSON or null (discover.js get). statusOf(kind, token, wallet, position) → the
 * `gang status` result of that kind, or throws (legacy: tokenInfo, or { graduated, myBalanceRaw } for a token no known
 * pad has). bondOf(token) → the `gang bond status` view, or throws. creatorFeesOf(wallet) → creatorfee.js creatorFeeList
 * (the wallet's 2.0 tokens and their creator fee, read on chain), or throws; optional.
 */
export async function portfolio({ wallet, get, statusOf, bondOf, creatorFeesOf, concurrency = 6 }) {
  const w = wallet.toLowerCase()
  const [profile, positions, launches, fees] = await Promise.all([
    get(`/agents/${w}`),
    get(`/agents/${w}/positions`),
    get(`/agents/${w}/launches?limit=${MAX_LAUNCHES}`),
    creatorFeesOf ? creatorFeesOf(wallet).catch((e) => ({ error: e.message })) : null,
  ])
  if (!Array.isArray(positions?.items)) throw new Error('gang API has no positions at /agents/<addr>/positions')

  const errors = []
  if (fees?.error) errors.push({ creatorFee: fees.error })
  const rows = await mapLimit(positions.items, concurrency, async (p) => {
    const kind = KIND[p.track]
    if (!kind) return null
    try {
      return holdingOf(p, kind, await statusOf(kind, p.address, wallet, p))
    } catch (e) {
      errors.push({ token: p.address, symbol: p.symbol, error: e.message })
      return null
    }
  })
  // bonds cover GangLaunchpad tokens only (V3 / 打新)
  const ours = (launches?.items ?? []).filter((l) => l.track === 'v3' || l.track === 'fair')
  const views = new Map()
  const bonds = (await mapLimit(ours, concurrency, async (l) => {
    try {
      const b = await bondOf(l.address)
      views.set(l.address.toLowerCase(), b)
      return bondRow(l, b)
    } catch (e) {
      errors.push({ token: l.address, symbol: l.symbol, error: `bond: ${e.message}` })
      return null
    }
  })).filter(Boolean)

  const holdings = rows.filter(Boolean)
    .map((h) => {
      const b = views.get(h.token.toLowerCase())
      return b?.state === 'active' ? withBond(h, b) : h
    })
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1))

  const sum = (key) => usd(holdings.reduce((s, h) => s + (h[key] ?? 0), 0))
  const unpriced = holdings.filter((h) => h.valueUsd == null).length
  const t = profile?.trade ?? {}
  const l = profile?.launch ?? {}
  return {
    success: true, wallet, handle: profile?.handle ?? null,
    totals: {
      holdings: holdings.length, valueUsd: sum('valueUsd'), unrealizedUsd: sum('unrealizedUsd'), claimableUsd: sum('claimableUsd'),
      ...(unpriced && { unpriced, unpricedNote: 'holdings without a USD value are left out of valueUsd' }),
    },
    holdings,
    record: {
      buys: t.buys ?? null, sells: t.sells ?? null, tokensTraded: t.tokens ?? null, volumeUsd: t.volumeUsd ?? null,
      realizedPnlUsd: t.realizedPnlUsd ?? null, gradHits: t.gradHits ?? null,
      launches: l.count ?? null, launchesGraduated: l.graduated ?? null,
    },
    bonds,
    ...creatorFeeRows(fees),
    ...(launches?.hasMore && { bondsNote: `bonds were looked up on the newest ${MAX_LAUNCHES} launches only` }),
    ...(errors.length && { errors }),
    note: 'Holdings are the tokens gang.fun saw this wallet trade on a curve or sale; balance and value are read on chain now. '
      + 'Tokens only received by transfer or only bought on PancakeSwap are not listed. USD uses each quote\'s price now. Data, not advice.',
  }
}

/**
 * The 2.0 creator fee waiting for this wallet on the tokens it created: { creatorFees: { tokens, totals } } with the
 * tokens that have some, or nothing when the network has no 2.0 pad (or the read failed: then it is in errors).
 */
function creatorFeeRows(fees) {
  if (!fees?.scanned?.length) return {}
  const due = fees.tokens.filter((x) => x.claimableRaw !== '0')
  return {
    creatorFees: {
      tokens: due.map((x) => ({ token: x.token, symbol: x.symbol, quote: x.quoteSymbol, claimable: num(x.claimable), padGen: x.padGen, next: `gang creator-fee --token ${x.token} --claim` })),
      totals: fees.totals.filter((x) => num(x.claimable) > 0),
      note: 'GangLaunchpad 2.0 keeps 70% of the 1% curve fee of your V3 tokens for you; gang creator-fee lists every one of them',
    },
  }
}

export const _test = { holdingOf, bondRow, withBond, mapLimit, creatorFeeRows }
