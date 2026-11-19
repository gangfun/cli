/**
 * `gang campaign`: gang.fun's reward campaigns (gang.fun/campaign/<slug>), e.g. Agent Season (`agent-season`). A
 * campaign's rules are public and fixed per version; rewards follow those rules and are not investment advice.
 *
 *   gang campaign [<slug>]                 live campaigns; with a slug (or when one is live) its rules summary, its
 *                                          tickets and lottery, and the signed-in wallet's progress
 *   gang campaign join [<slug>] [--yes]    the free sign-up, while the campaign has it open: a preview (nothing signed
 *                                          or sent); --yes signs it with the Agent wallet (EIP-712 typed data, no
 *                                          transaction, no gas) and submits it. Without a slug: the live campaign that
 *                                          takes sign-ups, when exactly one does
 *
 * The sign-up proves which Agent wallet joins without a trade. It is open only while the campaign's config says so
 * (rules.ticket.join = true, as the server checks; a config without the key is closed): otherwise nothing is signed,
 * earlier sign-ups keep their ticket, and the notes say where the base ticket comes from
 * now. Either way an agent never trades only to earn campaign tickets, and never on its own.
 */
import { get as apiGet } from './discover.js'
import { bawAddress, bawStatus } from './baw.js'
import { localTime } from './follow.js'
import { bawSignTyped, post, shellWord } from './weekly.js'

const RULES_NOTE = 'A gang.fun reward campaign: rewards follow its public rules and are not investment advice.'
const NO_TICKET_TRADES = "Never trade only to earn tickets, and never on your own: any trade is the user's decision, previewed and confirmed."
/** The note while the campaign's free sign-up is open. */
export const CAMPAIGN_NOTE = `${RULES_NOTE} Never trade only to earn tickets: the free sign-up (gang campaign join) gives the same base ticket.`
/** The note once the campaign closed its sign-up (rules.ticket.join not true). */
export const CAMPAIGN_NOTE_CLOSED = `${RULES_NOTE} The free sign-up is closed: tickets now come as the campaign's rules say (see notice and the campaign page); wallets that signed up earlier keep theirs. ${NO_TICKET_TRADES}`
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
/** Does this campaign (GET /campaigns/:slug) take a free sign-up now? Live, with tickets, its sign-up not closed. */
export const takesJoin = (c) => c?.status === 'live' && c.tickets != null && !joinClosed(c)
/** The note that fits this campaign's sign-up state. */
export const noteFor = (c) => (joinClosed(c) ? CAMPAIGN_NOTE_CLOSED : CAMPAIGN_NOTE)
const noticeOf = (c) => {
  const n = c?.rules?.page?.notice_en
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 500) : null
}

const titleOf = (t) => (t && typeof t === 'object' ? t.en || t.zh || null : t ?? null)
const when = (ts) => (Number(ts) > 0 ? localTime(Number(ts)) : null)

/** The parts of GET /campaigns/:slug an agent needs (the page has the rest). */
export function summary(c) {
  const w = c.window ?? {}
  return {
    slug: c.slug, title: titleOf(c.title), status: c.status,
    start: when(w.start), end: when(w.ended_at ?? w.end),
    ...(noticeOf(c) && { notice: noticeOf(c) }), ...(joinClosed(c) && { signUp: 'closed' }),
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

/** The signed-in wallet's row (GET /campaigns/:slug/wallet/:address), or null. */
export function mineOf(m) {
  if (!m || typeof m !== 'object') return null
  const t = m.tickets ?? {}
  return {
    wallet: m.wallet, status: m.status ?? null, agentId: m.agent_id ?? null,
    tickets: { base: t.base ?? 0, revisit: t.revisit ?? 0, invite: t.invite ?? 0, total: t.total ?? 0 },
    joined: !!m.joined_at, ...(m.joined_at && { joinedAt: when(m.joined_at) }),
    ...(m.revisit && { revisit: { from: when(m.revisit.due_from), until: when(m.revisit.due_until), done: !!m.revisit.done } }),
    ...(m.won && { won: m.won }),
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
    if (!join) { out({ success: true, live: items.map((i) => ({ slug: i.slug, title: titleOf(i.title), status: i.status, url: campaignUrl(i.slug) })), note: CAMPAIGN_NOTE_LIST }); return PRINTED }
    const open = []
    for (const c of await Promise.all(items.map((i) => read(`/campaigns/${i.slug}`)))) if (takesJoin(c)) open.push(c.slug)
    if (open.length === 1) return open[0]
    if (!open.length) return fail(`no live gang.fun campaign takes a free sign-up now (live: ${liveSlugs.join(', ')}); gang campaign <slug> shows how its tickets come. ${NO_TICKET_TRADES}`, { apiCode: 'closed', code: 'ERROR', campaigns: liveSlugs })
    return fail(`several live campaigns take a free sign-up: name one (gang campaign join <slug>: ${open.join(', ')})`, { campaigns: open })
  }
  const mine = async (slug, w) => {
    if (!w) return null
    try { return mineOf(await apiGet(`/campaigns/${slug}/wallet/${w.toLowerCase()}`, undefined, '')) } catch { return null }
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
  const me = await mine(slug, w)
  // can this wallet sign up at all? (the server refuses otherwise, after the user approved a signature for nothing)
  const closed = joinClosed(c)
  const joinOpen = c.status === 'live' && c.tickets != null && !closed
  const notNew = me?.status === 'not_new'
  const excluded = me?.status === 'excluded'

  if (!join) {
    return out({
      success: true, campaign: summary(c), ...(me && { mine: me }),
      ...(!me?.tickets?.base && joinOpen && !notNew && !excluded && { next: `gang campaign join ${slug}` }),
      note: noteFor(c),
    })
  }

  // an earlier sign-up keeps its ticket, also once the sign-up closed or the campaign ended; an excluded wallet has none
  if (excluded) fail(`${w} is not eligible for ${slug}`, { apiCode: 'not_eligible', code: 'ERROR' })
  if (me?.joined) return out({ success: true, campaign: slug, wallet: w.toLowerCase(), alreadyJoined: true, mine: me, url: campaignUrl(slug) })
  // the only live campaign takes no sign-up: the same refusal as when several are live and none does (live slugs in campaigns)
  const listed = liveSlugs && { campaigns: liveSlugs }
  if (closed && c.status === 'live') fail(CLOSED_MSG(slug), { apiCode: 'closed', code: 'ERROR', ...listed, campaign: summary(c), note: CAMPAIGN_NOTE_CLOSED })
  if (!joinOpen && c.status === 'live' && listed) fail(`no live gang.fun campaign takes a free sign-up now (live: ${slug}); gang campaign ${slug} shows how its tickets come. ${NO_TICKET_TRADES}`, { apiCode: 'closed', code: 'ERROR', ...listed, campaign: summary(c) })
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

