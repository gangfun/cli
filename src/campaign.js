/**
 * `gang campaign`: gang.fun's reward campaigns (gang.fun/campaign/<slug>), e.g. Agent Season (`agent-season`). A
 * campaign's rules are public and fixed per version; rewards follow those rules and are not investment advice.
 *
 *   gang campaign [<slug>]                 live campaigns (each with its kind and sign-up); with a slug (or when one is
 *                                          live) its rules summary, its tickets and lottery or its cash rewards, and the
 *                                          signed-in wallet's progress
 *   gang campaign join [<slug>] [--yes]    the free sign-up, while the campaign has it open: a preview (nothing signed
 *                                          or sent); --yes signs it with the Agent wallet (EIP-712 typed data, no
 *                                          transaction, no gas) and submits it. Without a slug: the live campaign that
 *                                          takes sign-ups, when exactly one does (--yes needs the slug when several are live)
 *
 * Two kinds (0.47.0+): a ticket campaign (tickets and a lottery, maybe a free sign-up) and a campaign with cash rewards
 * (no tickets: rules.new_user tiers pay an amount per wallet that enters by its counted buys / mints, and again on a
 * come-back buy; a DEV board per period). A cash campaign has no sign-up: counted trades enter by themselves. A
 * campaign can have both (kind cash+tickets): it shows both blocks, and its sign-up is the ticket one.
 *
 * A buy-reward campaign (type buy_reward, 0.48.0+; kind buy) shares a token reward per period among wallets by their
 * counted buys (and mints, if its rules say so), capped per wallet per period, under public versioned rules. It has no
 * sign-up either. Before a period is published the wallet's share is an estimate; once published, its units and tx.
 *
 * The sign-up proves which Agent wallet joins without a trade. It is open only while the campaign's config says so
 * (rules.ticket.join = true, as the server checks; a config without the key is closed): otherwise nothing is signed,
 * earlier sign-ups keep their ticket, and the notes say where the base ticket comes from
 * now. Either way an agent never trades only to earn campaign rewards or tickets, and never on its own.
 */
import { formatUnits } from 'viem'
import { get as apiGet } from './discover.js'
import { bawAddress, bawStatus } from './baw.js'
import { localTime } from './follow.js'
import { gangGens, VAULT_GEN } from './gangpad.js'
import { bawSignTyped, post, shellWord } from './weekly.js'

const RULES_NOTE = 'A gang.fun reward campaign: rewards follow its public rules and are not investment advice.'
const NO_TICKET_TRADES = "Never trade only to earn campaign rewards or tickets, and never on your own: any trade is the user's decision, previewed and confirmed."
/** The note while the campaign's free sign-up is open. */
export const CAMPAIGN_NOTE = `${RULES_NOTE} Never trade only to earn campaign rewards or tickets: the free sign-up (gang campaign join) gives the same base ticket.`
/** The note for a campaign with cash rewards: no sign-up. */
export const CAMPAIGN_NOTE_CASH = `${RULES_NOTE} No sign-up: counted trades (buys and mints; sells never count) enter automatically; see rewards. ${NO_TICKET_TRADES}`
/** The note once the campaign closed its sign-up (rules.ticket.join not true). */
export const CAMPAIGN_NOTE_CLOSED = `${RULES_NOTE} The free sign-up is closed: tickets now come as the campaign's rules say (see notice and the campaign page); wallets that signed up earlier keep theirs. ${NO_TICKET_TRADES}`
/** The note for a buy-reward campaign (type buy_reward): no sign-up, an amount per period by counted buys. */
export const CAMPAIGN_NOTE_BUY = `A gang.fun reward campaign: rewards follow its public, versioned rules (see rules and version) and are not investment advice. No sign-up: counted trades are recorded automatically; estimates are not final until a period is published. An agent never trades only to earn campaign rewards, and never on its own: any trade is the user's decision, previewed and confirmed.`
/** The note for a list of campaigns (each may have its sign-up open or closed). */
export const CAMPAIGN_NOTE_LIST = `${RULES_NOTE} ${NO_TICKET_TRADES}`
const CLOSED_MSG = (slug) => `the free sign-up for ${slug} is closed: wallets that signed up earlier keep their ticket; tickets now come as the campaign's rules say (see notice and ${campaignUrl(slug)}). Nothing was signed or sent. ${NO_TICKET_TRADES}`
export const CAMPAIGN_DOMAIN = { name: 'gang.fun campaign', version: '1', chainId: 56 }
const DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }]
export const JOIN_TYPE = [{ name: 'wallet', type: 'address' }, { name: 'campaign', type: 'string' }, { name: 'expires', type: 'uint256' }]
const SIGN_TTL_S = 30 * 60 // the server takes up to 1 hour ahead
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const SIGN_IN = 'sign in to baw (baw auth signin): the sign-up is signed by the Agent wallet that joins'
// gang.fun's refusal → the CLI's code (DEVELOPERS.md)
const API_CODES = { not_agent: 'NO_AGENT_ID', rate_limited: 'NETWORK', unavailable: 'NETWORK', bad_request: 'USAGE' }
const RETRY_CODES = new Set(['expired', 'rate_limited', 'unavailable'])
const PRINTED = Symbol('printed')

export const campaignUrl = (slug) => `https://gang.fun/campaign/${slug}`

/** The typed data baw signs for a sign-up (eth_signTypedData_v4 shape: EIP712Domain included in types). */
export function joinTypedData(wallet, campaign, expires) {
  return {
    types: { EIP712Domain: DOMAIN_TYPE, CampaignJoin: JOIN_TYPE }, primaryType: 'CampaignJoin', domain: CAMPAIGN_DOMAIN,
    message: { wallet, campaign, expires },
  }
}

/** Is the campaign's free sign-up closed? Open only with rules.ticket.join = true (the server refuses otherwise). */
export const joinClosed = (c) => c?.rules?.ticket?.join !== true
/** A buy-reward campaign (type buy_reward): a token reward per period by counted buys; no tickets, no sign-up. */
export const isBuyReward = (c) => c?.type === 'buy_reward'
/** Does this campaign (GET /campaigns/:slug) take a free sign-up now? Live, with tickets, its sign-up not closed. */
export const takesJoin = (c) => c?.status === 'live' && !isBuyReward(c) && c.tickets != null && !joinClosed(c)
/** A campaign with cash rewards (no tickets; rules.new_user pays per wallet) rather than a ticket campaign. */
/** Does the campaign pay cash per wallet (rules.new_user.cash not false)? Alone (isCash) or beside tickets. */
export const hasCash = (c) => !isBuyReward(c) && c?.rules?.new_user != null && c.rules.new_user.cash !== false
/** A campaign with cash rewards only (no tickets): it has no sign-up. */
export const isCash = (c) => c != null && c.tickets == null && hasCash(c)
export const kindOf = (c) => (isBuyReward(c) ? 'buy' : isCash(c) ? 'cash' : hasCash(c) ? 'cash+tickets' : 'tickets')
/** A campaign with no sign-up at all: cash only, or buy reward. */
export const noSignUp = (c) => isBuyReward(c) || isCash(c)
/** open | closed | none (a cash or buy-reward campaign has no sign-up). */
export const signUpOf = (c) => (noSignUp(c) ? 'none' : joinClosed(c) ? 'closed' : 'open')
/** The note that fits this campaign's kind and sign-up state. */
export const noteFor = (c) => (isBuyReward(c) ? CAMPAIGN_NOTE_BUY : isCash(c) ? CAMPAIGN_NOTE_CASH : joinClosed(c) ? CAMPAIGN_NOTE_CLOSED : CAMPAIGN_NOTE)
const noticeOf = (c) => {
  const n = isBuyReward(c) ? c?.notice?.en : c?.rules?.page?.notice_en
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 500) : null
}

const titleOf = (t) => (t && typeof t === 'object' ? t.en || t.zh || null : t ?? null)
const when = (ts) => (Number(ts) > 0 ? localTime(Number(ts)) : null)
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
/**
 * A threshold for people, in whole U: the smallest whole U at or above the real threshold (rounded to 6 decimals for
 * float noise), so it is never shown lower than it is. Amounts are counted net of fees, so a "1 U" rule is often stored
 * a little lower: 0.95 → 1, 1.004 → 2, 1.05 → 2, 0.004 → 1, 0 → 0 (any amount).
 */
export const wholeU = (u) => (num(u) == null ? null : Math.ceil(Math.round(Number(u) * 1e6) / 1e6))
const atLeast = (u) => (wholeU(u) ? `≥${wholeU(u)} U` : 'any amount')
const span = (s) => {
  const n = num(s)
  if (n == null) return null
  if (n % 86400 === 0) return `${n / 86400} d`
  return `${Math.round((n / 3600) * 10) / 10} h`
}

// the quotes the CLI can name (BSC mainnet); others are listed by address
const QUOTE_SYMBOLS = {
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'WBNB', '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': 'USD1',
}
const TRACK_NAMES = { v3: 'GangLaunchpad curve tokens', fair: '打新 fair mint', fly: '铸币飞轮 Mint Flywheel', v2: 'LaunchpadV2', soft: 'Soft' }
/** A counted pad's name, from this CLI's mainnet pad list (null for one it does not know). */
const padName = (a) => {
  const g = gangGens(false).find((x) => x.pad && x.pad.toLowerCase() === String(a).toLowerCase())
  if (!g?.gen) return null
  return g.gen === VAULT_GEN ? 'GangLaunchpad 2.0 vault' : `GangLaunchpad ${g.gen}`
}
const listOf = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}` : xs[0] ?? '')

/** What counts and who can enter (rules.count, require_agent_id): pads / quotes null = any. */
function countedOf(c) {
  const k = c.rules.count ?? {}
  const kinds = (k.kinds ?? ['buy', 'mint']).filter((x) => x === 'buy' || x === 'mint')
  const tracks = Array.isArray(k.tracks) ? k.tracks : null
  const pads = Array.isArray(k.pads) && k.pads.length ? k.pads.map((a) => ({ address: a, name: padName(a) })) : null
  const quotes = Array.isArray(k.quotes) && k.quotes.length ? k.quotes.map((a) => ({ address: a, symbol: QUOTE_SYMBOLS[String(a).toLowerCase()] ?? null })) : null
  return { kinds: kinds.length ? kinds : ['buy', 'mint'], tracks, pads, quotes, agentId: c.rules.require_agent_id === true }
}

/** The cash rewards of a campaign that pays cash (GET /campaigns/:slug rules + slots + periods), or null. */
export function rewardsOf(c) {
  if (!hasCash(c)) return null
  const n = c.rules.new_user
  const asset = c.rules.payout?.user_asset ?? null
  const counted = countedOf(c)
  const counts = counted.kinds.map((k) => `${k}s`).join(' and ')
  const where = [
    counted.tracks && `of ${listOf(counted.tracks.map((t) => TRACK_NAMES[t] ?? t))}`,
    counted.pads && `on ${listOf(counted.pads.map((p) => p.name ?? p.address))}`,
    counted.quotes && `paid in ${listOf(counted.quotes.map((q) => q.symbol ?? q.address))}`,
  ].filter(Boolean).join(', ')
  const who = `a new wallet (its first Gang trade is in the window; one that traded on Gang before gets nothing)${counted.agentId ? ' holding an Agent ID' : ''}`
  const tiers = Array.isArray(n.tiers) ? n.tiers : []
  const board = c.rules.dev_board
  const prizes = Array.isArray(board?.prizes_u) ? board.prizes_u.map(Number) : []
  const periods = Array.isArray(c.periods) ? c.periods.length : null
  return {
    asset,
    counts: `${counts} only (sells never count), net of fees${where ? `, ${where}` : ''}`,
    counted,
    who: { newWalletsOnly: true, agentId: counted.agentId, text: who },
    entry: { minU: wholeU(n.threshold_u), text: `${who}, whose counted ${counts}${where ? ` ${where}` : ''} reach ${atLeast(n.threshold_u)} in total (net of fees)` },
    perWallet: tiers.map((t) => ({ slots: num(t.slots), firstU: num(t.first_u), comeBackU: num(t.revisit_u) })),
    comeBack: {
      minU: wholeU(n.revisit_min_u), after: span(n.revisit_after_s), within: span(n.revisit_within_s),
      text: `a counted buy or mint of ${atLeast(n.revisit_min_u)} from ${span(n.revisit_after_s)} to ${span(n.revisit_within_s)} after the wallet's first trade`,
    },
    ...(c.slots && { slots: { total: num(c.slots.total), open: num(c.slots.open), left: num(c.slots.left), entered: num(c.slots.entered) } }),
    ...(prizes.length && {
      devBoard: {
        prizesU: prizes, perPeriod: true, periods, asset: c.rules.payout?.dev_asset ?? asset,
        metric: board.metric ?? null, minCount: num(board.min_count),
      },
    }),
  }
}

/** The parts of GET /campaigns/:slug an agent needs (the page has the rest). */
export function summary(c) {
  if (isBuyReward(c)) return buySummary(c)
  const w = c.window ?? {}
  return {
    slug: c.slug, title: titleOf(c.title), status: c.status, kind: kindOf(c),
    start: when(w.start), end: when(w.ended_at ?? w.end),
    ...(noticeOf(c) && { notice: noticeOf(c) }), ...(signUpOf(c) !== 'open' && { signUp: signUpOf(c) }),
    ...(hasCash(c) && { rewards: rewardsOf(c) }),
    ...(c.tickets && { tickets: { total: c.tickets.total ?? 0, holders: c.tickets.holders ?? 0, prizesNow: c.tickets.prizes_now ?? 0 } }),
    ...(c.lottery && {
      lottery: {
        status: c.lottery.status, ...(c.lottery.snapshot_hash && { snapshotHash: c.lottery.snapshot_hash }),
        ...(c.lottery.target_block != null && { targetBlock: c.lottery.target_block }),
        ...(Array.isArray(c.lottery.winners) && c.lottery.winners.length && { winners: c.lottery.winners.map((x) => ({ wallet: x.wallet, prizeU: x.prize_u })) }),
      },
    }),
    url: campaignUrl(c.slug),
  }
}

/** The signed-in wallet's row (GET /campaigns/:slug/wallet/:address), or null; c (the campaign) adds its cash progress. */
export function mineOf(m, c) {
  if (!m || typeof m !== 'object') return null
  if (isBuyReward(c)) return buyMineOf(m, c)
  const t = m.tickets ?? {}
  return {
    wallet: m.wallet, status: m.status ?? null, agentId: m.agent_id ?? null,
    tickets: { base: t.base ?? 0, revisit: t.revisit ?? 0, invite: t.invite ?? 0, total: t.total ?? 0 },
    joined: !!m.joined_at, ...(m.joined_at && { joinedAt: when(m.joined_at) }),
    ...(m.revisit && { revisit: { from: when(m.revisit.due_from), until: when(m.revisit.due_until), done: !!m.revisit.done } }),
    ...(m.won && { won: m.won }),
    ...(hasCash(c) && {
      cash: {
        status: m.status ?? null, slot: m.slot ?? null, tier: m.tier ?? null, amountU: num(m.amount_u) ?? 0,
        firstU: num(m.first_u), comeBackU: num(m.revisit_u),
        comeBack: m.revisit ? { from: when(m.revisit.due_from), until: when(m.revisit.due_until), minU: wholeU(m.revisit.min_u), done: !!m.revisit.done } : null,
        earnedU: num(m.earned_u) ?? 0, paidU: num(m.paid) ?? 0, asset: c.rules.payout?.user_asset ?? null,
      },
    }),
  }
}

// --- buy-reward campaigns (type buy_reward, 0.48.0+) ---

/** Base units (an integer string) → whole tokens as a decimal string; null when units or decimals are not integers. */
export function tokensOf(units, decimals) {
  if (units == null || !/^\d+$/.test(String(units))) return null
  if (decimals == null || decimals === '' || !Number.isInteger(Number(decimals)) || Number(decimals) < 0 || Number(decimals) > 255) return null
  return formatUnits(BigInt(String(units)), Number(decimals))
}
const PRICE_WORDS = { settle_snapshot: "U values at the settlement snapshot's prices" }
/** price_source in words (known ones by name, others with underscores as spaces); the raw value stays in priceSource. */
export const priceWords = (x) => (typeof x === 'string' && x.trim() ? PRICE_WORDS[x.trim()] ?? x.trim().replace(/[_-]+/g, ' ') : null)
/** What a sell-like move is for these rules: a sell or transfer, and a withdrawal when mints count. */
const outflow = (r) => (r?.include_mints === true ? 'a sell, transfer or withdrawal' : 'a sell or transfer')
/** What an estimate is and why it can still change, for this campaign's rules. */
export function estimateNoteOf(c) {
  const r = c?.rules ?? {}
  const down = r.mode === 'gross_buys'
    ? "other wallets' counted buys"
    : `${r.include_mints === true ? 'sells, transfers or withdrawals' : 'sells or transfers'} before settlement, other wallets' counted buys`
  return `An estimate, not final: it can go down (${down}). It values amounts in U at current prices; the final count uses the settlement snapshot.`
}
const pct = (bps) => (num(bps) == null ? null : `${Math.round(Number(bps)) / 100}%`)
const PAYOUT_TEXT = {
  end_only: 'paid once after the campaign ends, by the published results of each period',
  per_period: 'paid after each period, once its results are published',
}
const BUY_STATUS_TEXT = {
  eligible: 'eligible: its counted trades earn a share of each period',
  not_new: "not a new wallet (it traded on Gang before the campaign's cut-off): it earns nothing in this campaign",
  not_agent: 'holds no Agent ID: its trades do not count',
  excluded: 'excluded by the campaign rules: it earns nothing',
  pending: 'not decided yet: shown once its trades are checked',
}

/** A buy-reward campaign's rules in short words (rules of GET /campaigns/:slug). */
export function buyRulesOf(c) {
  const r = c.rules ?? {}
  const mode = r.mode === 'gross_buys' ? 'gross_buys' : 'net_held'
  const mints = r.include_mints === true
  const pads = Array.isArray(r.pads) && r.pads.length ? r.pads.map((a) => ({ address: a, name: padName(a) })) : null
  const quotes = Array.isArray(r.quotes) && r.quotes.length
    ? r.quotes.map((q) => (q && typeof q === 'object' ? { address: q.address ?? null, symbol: q.symbol ?? QUOTE_SYMBOLS[String(q.address).toLowerCase()] ?? null } : { address: q, symbol: QUOTE_SYMBOLS[String(q).toLowerCase()] ?? null }))
    : null
  const what = mints ? 'buys and mints' : 'buys'
  const where = [
    pads ? `on ${listOf(pads.map((p) => p.name ?? p.address))}` : 'on Gang',
    quotes && `paid in ${listOf(quotes.map((q) => q.symbol ?? q.address))}`,
  ].filter(Boolean).join(', ')
  const capU = num(r.cap_u_per_wallet_period)
  const age = num(r.min_token_age_s)
  const newBefore = r.new_only && typeof r.new_only === 'object' ? when(r.new_only.before) ?? r.new_only.before ?? null : null
  // net_held: what is still held when it is settled; end_only (the default) settles after the campaign ends, per_period
  // at each period's end. A sell (or, for mints, a withdrawal) any time before then takes that amount back out
  const out = outflow(r)
  const counts = mode === 'net_held'
    ? (r.payout === 'per_period'
      ? `net ${what} ${where}, still held at the end of each period: ${out} before then takes that amount back out`
      : `net ${what} ${where}, still held at settlement after the campaign ends: ${out} any time before then takes that amount back out`)
    : `${what} ${where}, as made (gross: a later sell does not take it back out)`
  const price = priceWords(r.price_source)
  const text = [
    `Counts: ${counts}, valued in U.`,
    price && `Prices: ${price}.`,
    capU != null && `At most ${capU} U counted per wallet per period.`,
    (num(r.token_share_cap_bps) != null || num(r.creator_share_cap_bps) != null) && `Share caps: ${[
      num(r.token_share_cap_bps) != null && `buyers of one token together earn at most ${pct(r.token_share_cap_bps)} of a period's reward`,
      num(r.creator_share_cap_bps) != null && `buyers of all of one creator's tokens together at most ${pct(r.creator_share_cap_bps)}`,
    ].filter(Boolean).join('; ')}.`,
    age && `A token counts once it is at least ${span(age)} old.`,
    r.exclude_own_tokens === true && "Trades of the wallet's own tokens (ones it created) do not count.",
    r.agent_id === true && 'Only wallets holding an Agent ID.',
    r.new_only && `New wallets only (no Gang trade before ${newBefore ?? 'the campaign'}).`,
    PAYOUT_TEXT[r.payout] && `Reward: ${PAYOUT_TEXT[r.payout]}.`,
  ].filter(Boolean)
  return {
    mode, counts, includeMints: mints, capUPerWalletPeriod: capU,
    tokenShareCapBps: num(r.token_share_cap_bps), creatorShareCapBps: num(r.creator_share_cap_bps),
    minTokenAge: age ? span(age) : null, excludeOwnTokens: r.exclude_own_tokens === true, agentId: r.agent_id === true,
    newOnly: r.new_only ? { before: newBefore } : null, pads, quotes, payout: r.payout ?? null, priceSource: r.price_source ?? null,
    text,
  }
}

function buySummary(c) {
  const w = c.window ?? {}
  const rw = c.reward ?? {}
  const dec = rw.decimals
  const periods = Array.isArray(c.periods) ? c.periods : []
  return {
    slug: c.slug, title: titleOf(c.title), status: c.status, kind: 'buy', type: 'buy_reward',
    start: when(w.start), end: when(w.ended_at ?? w.end), ...(noticeOf(c) && { notice: noticeOf(c) }), signUp: 'none',
    version: c.version ?? null,
    reward: { token: rw.token ?? null, symbol: rw.symbol ?? null, decimals: tokensOf('0', dec) == null ? null : Number(dec), total: tokensOf(rw.total_units, dec), totalUnits: rw.total_units ?? null },
    rules: buyRulesOf(c),
    periods: periods.map((p) => ({
      id: p.id, start: when(p.start), end: when(p.end), status: p.status ?? null, reward: tokensOf(p.units, dec),
      ...(p.wallets != null && { wallets: num(p.wallets) }),
      ...(p.published && { published: { at: when(p.published.at), payees: num(p.published.payees), reward: tokensOf(p.published.units, dec) } }),
    })),
    currentPeriod: c.current_period ?? null,
    url: campaignUrl(c.slug),
  }
}

/** Is this period of the campaign published (periods[].published)? */
const isPublished = (c, id) => (Array.isArray(c?.periods) ? c.periods : []).some((x) => String(x.id) === String(id) && x.published)

/**
 * The signed-in wallet's buy-reward row (GET /campaigns/:slug/wallet/:address). Once a period is published the row
 * carries the wallet's units and tx; a published period without units paid this wallet nothing: reward 0, never an
 * estimate.
 */
export function buyMineOf(m, c) {
  const dec = (m.reward ?? c.reward ?? {}).decimals
  const periods = (Array.isArray(m.periods) ? m.periods : []).map((p) => {
    const units = p.units ?? null
    const tx = p.tx_hash ?? null
    const base = { id: p.id, start: when(p.start), end: when(p.end), countedU: num(p.counted_u) ?? 0, rawU: num(p.raw_u), capU: num(p.cap_u) }
    if (units != null) return { ...base, reward: tokensOf(units, dec), units: String(units), ...(tx && { txHash: tx }) }
    if (isPublished(c, p.id)) return { ...base, reward: '0', units: '0', published: true, why: 'no payout to this wallet in the published results' }
    return { ...base, estimatedReward: tokensOf(p.est_units ?? '0', dec), estimate: true }
  })
  return {
    wallet: m.wallet, status: m.status ?? null, statusText: BUY_STATUS_TEXT[m.status] ?? null,
    symbol: (m.reward ?? c.reward ?? {}).symbol ?? null,
    ...(m.updated_at != null && { updatedAt: when(m.updated_at) }),
    periods,
    ...(periods.some((p) => p.estimate) && { estimateNote: estimateNoteOf(c) }),
  }
}
/** runCampaign(sub, rest, io): sub = 'join' or a slug or undefined; io = { flag, out, fail } from index.js. */
export async function runCampaign(sub, rest, { flag, out, fail }) {
  const join = sub === 'join'
  const extra = join ? rest.slice(1) : rest
  if (extra.length) fail(`unexpected ${JSON.stringify(extra[0])}: gang campaign [<slug>] | gang campaign join [<slug>] [--yes]`)
  const slugArg = (join ? rest[0] : sub)?.toLowerCase()
  if (slugArg != null && !SLUG_RE.test(slugArg)) fail(`gang campaign takes a campaign slug like agent-season (got ${JSON.stringify(slugArg)})`)
  const signedIn = () => { try { return bawStatus() === 'CONNECTED' } catch { return false } }
  const read = async (path) => {
    try { return await apiGet(path, undefined, '') } catch (e) { return fail(e.message, { retry: 'same command again' }) }
  }
  // without a slug: the live campaigns' slugs, said on every "no live campaign takes a sign-up" refusal
  let liveSlugs = null
  // the campaign this command is about: the slug given, else the only live one; several live: status lists them all,
  // and join takes the one that accepts a sign-up (asks for a slug only when several do)
  const pick = async () => {
    if (slugArg) return slugArg
    const l = await read('/campaigns?status=live')
    const items = Array.isArray(l?.items) ? l.items : []
    liveSlugs = items.map((i) => i.slug)
    if (items.length === 1) return items[0].slug
    if (!items.length) return null
    if (!join) {
      // each row's kind and sign-up come from its own view (null when it could not be read)
      const views = await Promise.all(items.map((i) => apiGet(`/campaigns/${i.slug}`, undefined, '').catch(() => null)))
      out({
        success: true,
        live: items.map((i, k) => ({
          slug: i.slug, title: titleOf(i.title), status: i.status,
          kind: views[k] ? kindOf(views[k]) : null, signUp: views[k] ? signUpOf(views[k]) : null, url: campaignUrl(i.slug),
        })),
        note: CAMPAIGN_NOTE_LIST,
      })
      return PRINTED
    }
    const views = await Promise.all(items.map((i) => read(`/campaigns/${i.slug}`)))
    const open = views.filter(takesJoin).map((c) => c.slug)
    // --yes signs at once: with several live, only the slug the user OK'd (the preview's confirm names it)
    if (flag('yes') && open.length) return fail(`several campaigns are live: name the one to sign up for (gang campaign join <slug> --yes, as the preview's confirm says: ${open.join(', ')})`, { code: 'USAGE', campaigns: open })
    if (open.length === 1) return open[0]
    if (!open.length) return fail(`no live gang.fun campaign takes a free sign-up now (live: ${liveSlugs.join(', ')}); gang campaign <slug> shows how its ${views.some((v) => hasCash(v) || isBuyReward(v)) ? 'rewards or tickets work' : 'tickets come'}. ${NO_TICKET_TRADES}`, { apiCode: 'closed', code: 'ERROR', campaigns: liveSlugs, ...(views.some(isBuyReward) && { note: CAMPAIGN_NOTE_BUY }) })
    return fail(`several live campaigns take a free sign-up: name one (gang campaign join <slug>: ${open.join(', ')})`, { campaigns: open })
  }
  const mine = async (slug, w, c) => {
    if (!w) return null
    try { return mineOf(await apiGet(`/campaigns/${slug}/wallet/${w.toLowerCase()}`, undefined, ''), c) } catch { return null }
  }
  const wallet = () => (signedIn() ? (() => { try { return bawAddress() } catch { return null } })() : null)

  const slug = await pick()
  if (slug === PRINTED) return undefined // the list of live campaigns was printed
  if (!slug) {
    if (join) fail('no gang.fun campaign is live now')
    return out({ success: true, live: [], note: 'No gang.fun campaign is live now.' })
  }
  const c = await read(`/campaigns/${slug}`)
  if (!c) fail(`gang.fun has no campaign ${slug}`)
  const w = wallet()
  const me = await mine(slug, w, c)
  // can this wallet sign up at all? (the server refuses otherwise, after the user approved a signature for nothing)
  const closed = joinClosed(c)
  const joinOpen = takesJoin(c)
  const notNew = me?.status === 'not_new'
  const excluded = me?.status === 'excluded'

  if (!join) {
    return out({
      success: true, campaign: summary(c), ...(me && { mine: me }),
      ...(!me?.tickets?.base && joinOpen && !notNew && !excluded && { next: `gang campaign join ${slug}` }),
      note: noteFor(c),
    })
  }

  // a buy-reward campaign has no sign-up: nothing to sign, and no reason to trade for it
  if (isBuyReward(c)) fail(`this campaign has no sign-up (${slug}): it rewards counted trades under its public rules, recorded automatically (gang campaign ${slug} shows them). Nothing was signed or sent. ${NO_TICKET_TRADES}`, { apiCode: 'no_signup', code: 'ERROR', ...(liveSlugs && { campaigns: liveSlugs }), campaign: summary(c), note: CAMPAIGN_NOTE_BUY })
  // a campaign with cash rewards has no sign-up at all: nothing to sign, and no reason to trade for it
  if (isCash(c)) fail(`this campaign has no sign-up (${slug}): counted trades are recorded automatically (gang campaign ${slug} shows its rewards). Nothing was signed or sent. ${NO_TICKET_TRADES}`, { apiCode: 'no_signup', code: 'ERROR', ...(liveSlugs && { campaigns: liveSlugs }), campaign: summary(c), note: CAMPAIGN_NOTE_CASH })
  // an earlier sign-up keeps its ticket, also once the sign-up closed or the campaign ended; an excluded wallet has none
  if (excluded) fail(`${w} is not eligible for ${slug}`, { apiCode: 'not_eligible', code: 'ERROR' })
  if (me?.joined) return out({ success: true, campaign: slug, wallet: w.toLowerCase(), alreadyJoined: true, mine: me, url: campaignUrl(slug) })
  // the only live campaign takes no sign-up: the same refusal as when several are live and none does (live slugs in campaigns)
  const listed = liveSlugs && { campaigns: liveSlugs }
  if (closed && c.status === 'live') fail(CLOSED_MSG(slug), { apiCode: 'closed', code: 'ERROR', ...listed, campaign: summary(c), note: CAMPAIGN_NOTE_CLOSED })
  if (!joinOpen && c.status === 'live' && listed) fail(`no live gang.fun campaign takes a free sign-up now (live: ${slug}); gang campaign ${slug} shows how its ${hasCash(c) ? 'rewards or tickets work' : 'tickets come'}. ${NO_TICKET_TRADES}`, { apiCode: 'closed', code: 'ERROR', ...listed, campaign: summary(c) })
  if (!joinOpen) fail(`${slug} is not open for sign-up (status ${c.status})`, { campaign: summary(c) })
  if (!w) fail(SIGN_IN)
  if (notNew) fail(`${w} traded on Gang before ${slug} started: the sign-up is for new wallets (invites still earn tickets)`, { apiCode: 'not_new', code: 'ERROR' })
  if (!flag('yes')) {
    return out({
      success: true, preview: true, join: { campaign: slug, wallet: w.toLowerCase() },
      signs: 'an EIP-712 sign-up message with the Agent wallet: no transaction, no gas, no cost',
      ...(me?.tickets?.base && { alreadyHasBaseTicket: true, why: 'This wallet already has its base ticket from a trade: signing up adds no ticket.' }),
      confirm: ['gang', 'campaign', 'join', slug, '--yes'].map(shellWord).join(' '),
      note: `Nothing was signed or sent. On the user's OK run confirm. ${CAMPAIGN_NOTE}`,
    })
  }
  const expires = Math.floor(Date.now() / 1000) + SIGN_TTL_S
  let signature
  try { signature = bawSignTyped(w, joinTypedData(w, slug, expires)) } catch (e) { fail(e.message, e.retryable ? { retry: 'same command again' } : {}) }
  let r
  try {
    r = await post(`/campaigns/${slug}/join`, { wallet: w.toLowerCase(), expires, signature })
  } catch (e) {
    // the campaign closed its sign-up after we read it
    // (or it ended): say what is sure, and where the current rules are
    if (e.apiCode === 'closed') fail(`gang.fun says the sign-up for ${slug} is closed: nothing was added; wallets that signed up earlier keep their ticket. gang campaign ${slug} shows how tickets come now. ${NO_TICKET_TRADES}`, { apiCode: 'closed', code: 'ERROR' })
    fail(e.message, {
      ...(e.apiCode && { apiCode: e.apiCode, code: API_CODES[e.apiCode] || 'ERROR' }),
      ...((e.retryable || RETRY_CODES.has(e.apiCode)) && { retry: 'same command again' }),
    })
  }
  return out({
    success: true, campaign: slug, wallet: w.toLowerCase(), joined: true, ...(r.joined_at && { joinedAt: when(r.joined_at) }),
    ...(r.tickets != null && { tickets: r.tickets }), url: campaignUrl(slug),
  })
}

