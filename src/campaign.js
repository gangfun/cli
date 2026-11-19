/**
 * `gang campaign`: gang.fun's reward campaigns (gang.fun/campaign/<slug>), e.g. Agent Season (`agent-season`). A
 * campaign's rules are public and fixed per version; rewards follow those rules and are not investment advice.
 *
 *   gang campaign [<slug>]                 live campaigns; with a slug (or when one is live) its rules summary, its
 *                                          tickets and lottery, and the signed-in wallet's progress
 *   gang campaign join [<slug>] [--yes]    the free sign-up: a preview (nothing signed or sent); --yes signs it with the
 *                                          Agent wallet (EIP-712 typed data, no transaction, no gas) and submits it
 *
 * The sign-up proves which Agent wallet joins without a trade. It is a free way in: an agent never trades only to earn
 * campaign tickets, and never on its own.
 */
import { get as apiGet } from './discover.js'
import { bawAddress, bawStatus } from './baw.js'
import { localTime } from './follow.js'
import { bawSignTyped, post, shellWord } from './weekly.js'

export const CAMPAIGN_NOTE = 'A gang.fun reward campaign: rewards follow its public rules and are not investment advice. Never trade only to earn tickets: the free sign-up (gang campaign join) gives the same base ticket.'
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

const titleOf = (t) => (t && typeof t === 'object' ? t.en || t.zh || null : t ?? null)
const when = (ts) => (Number(ts) > 0 ? localTime(Number(ts)) : null)

/** The parts of GET /campaigns/:slug an agent needs (the page has the rest). */
export function summary(c) {
  const w = c.window ?? {}
  return {
    slug: c.slug, title: titleOf(c.title), status: c.status,
    start: when(w.start), end: when(w.ended_at ?? w.end),
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
  // the campaign this command is about: the slug given, else the only live one
  const pick = async () => {
    if (slugArg) return slugArg
    const l = await read('/campaigns?status=live')
    const items = Array.isArray(l?.items) ? l.items : []
    if (items.length === 1) return items[0].slug
    if (!items.length) return null
    if (!join) { out({ success: true, live: items.map((i) => ({ slug: i.slug, title: titleOf(i.title), status: i.status, url: campaignUrl(i.slug) })), note: CAMPAIGN_NOTE }); return PRINTED }
    return fail(`several campaigns are live: name one (${items.map((i) => i.slug).join(', ')})`, { campaigns: items.map((i) => i.slug) })
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
  const joinOpen = c.status === 'live' && c.tickets != null && c.rules?.ticket?.join !== false
  const notNew = me?.status === 'not_new'
  const excluded = me?.status === 'excluded'

  if (!join) {
    return out({
      success: true, campaign: summary(c), ...(me && { mine: me }),
      ...(!me?.tickets?.base && joinOpen && !notNew && !excluded && { next: `gang campaign join ${slug}` }),
      note: CAMPAIGN_NOTE,
    })
  }

  if (!joinOpen) fail(`${slug} is not open for sign-up (status ${c.status})`, { campaign: summary(c) })
  if (!w) fail(SIGN_IN)
  if (notNew) fail(`${w} traded on Gang before ${slug} started: the sign-up is for new wallets (invites still earn tickets)`, { apiCode: 'not_new', code: 'ERROR' })
  if (excluded) fail(`${w} is not eligible for ${slug}`, { apiCode: 'not_eligible', code: 'ERROR' })
  if (me?.joined) return out({ success: true, campaign: slug, wallet: w.toLowerCase(), alreadyJoined: true, mine: me, url: campaignUrl(slug) })
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

