/**
 * `gang weekly`: Gang's weekly launch event (gang.fun/weekly). Each week the team picks one application; the pick launches
 * on GangLaunchpad 3.0 (V3 curve) on Friday 20:00 UTC+8 from the wallet that applied, and is featured for 7 days: on the
 * gang.fun homepage, in gang.fun's X / TG posts and in the `events` rows of `gang trending` / `preflight` / `list`. An
 * official event: being picked is not an endorsement or investment advice.
 *
 *   gang weekly                          the issue open for applications, the current pick, past issues, my application
 *   gang weekly apply …                  preview the application; with --yes sign it with the Agent wallet and submit it
 *   gang weekly withdraw [--yes]         withdraw my application while applications are open
 *
 * The application is signed as EIP-712 typed data (domain "gang.fun weekly launch", chainId 56) by the baw wallet, which
 * proves the wallet applying is the one that will create. Its `contact` is only seen by the gang.fun team.
 */
import { statSync } from 'node:fs'
import { keccak256, toBytes } from 'viem'
import { API, get as apiGet } from './discover.js'
import { baw, bawAddress, bawFailed, bawStatus } from './baw.js'
import { localTime } from './follow.js'
import { cdnUrl, checkGangLogo, ipfsCid, ipfsUri } from './logo.js'
import { normalizeTwitter, normalizeWebsite } from './links.js'
import { UA } from './version.js'

export const WEEKLY_NOTE = "Gang's official weekly launch event: being picked is not an endorsement or investment advice. Never buy from it on your own."
export const WEEKLY_URL = 'https://gang.fun/weekly'
export const WEEKLY_MODULES = ['buyback', 'lp', 'split', 'combo', 'capped', 'bond', 'dividend', 'promote', 'tax']
export const APPLY_FLAGS = ['name', 'symbol', 'logo', 'logo-file', 'file-logo', 'logo-uri', 'description', 'contact',
  'twitter', 'telegram', 'website', 'modules', 'issue', 'yes', 'keep-logo-uri']

export const WEEKLY_DOMAIN = { name: 'gang.fun weekly launch', version: '1', chainId: 56 }
const DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }]
export const WEEKLY_TYPES = {
  WeeklyApply: [{ name: 'wallet', type: 'address' }, { name: 'issue', type: 'string' }, { name: 'digest', type: 'bytes32' }, { name: 'expires', type: 'uint256' }],
  WeeklyWithdraw: [{ name: 'wallet', type: 'address' }, { name: 'issue', type: 'string' }, { name: 'expires', type: 'uint256' }],
}
const SIGN_TTL_S = 30 * 60 // the signature's expires: the server takes up to 1 hour ahead
const ISSUE_RE = /^\d{4}-\d{2}-\d{2}$/
const POST_TIMEOUT_MS = 20_000

/** JSON with object keys sorted at every level, arrays in order, no whitespace: what the digest hashes (server does the same). */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** keccak256 of the canonical application, wallet in lower case. */
export const applicationDigest = (app) => keccak256(toBytes(canonical({ ...app, wallet: String(app.wallet).toLowerCase() })))

/** The typed data baw signs (eth_signTypedData_v4 shape: EIP712Domain included in types). */
export function typedData(primaryType, message) {
  return { types: { EIP712Domain: DOMAIN_TYPE, [primaryType]: WEEKLY_TYPES[primaryType] }, primaryType, domain: WEEKLY_DOMAIN, message }
}

/** baw's { signature: r‖s hex, signatureRecovery: '00' | '01' } → a 65-byte 0x signature with v = 27 / 28. */
export function joinSignature(sig, recovery) {
  const rs = String(sig ?? '').replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{128}$/.test(rs)) {
    // some answers carry the full 65 bytes already
    if (/^[0-9a-fA-F]{130}$/.test(rs)) return `0x${rs}`
    throw new Error('baw returned no signature')
  }
  // without the recovery byte half the signatures would be wrong: refuse rather than guess
  if (recovery == null || !/^(?:0x)?[0-9a-fA-F]{1,2}$/.test(String(recovery))) throw new Error('baw returned a signature without its recovery byte')
  const rec = Number.parseInt(String(recovery).replace(/^0x/, ''), 16)
  if (!(rec >= 0 && rec <= 1) && !(rec === 27 || rec === 28)) throw new Error(`baw returned an unknown signature recovery ${recovery}`)
  return `0x${rs}${(rec >= 27 ? rec : 27 + rec).toString(16)}`
}

/**
 * Sign typed data with the baw wallet: preview, then execute. A signature that waits for the Binance App is polled for up
 * to ~2 minutes. → 0x signature.
 */
export function bawSignTyped(wallet, td, { sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_signTypedData_v4', params: [wallet, JSON.stringify(td)] })
  const p = baw(['sign-message', 'preview', '--binanceChainId', '56', '--signType', 'EIP712', '--message', message])
  if (!p.success) throw bawFailed('sign-message preview', p.error)
  let r = baw(['sign-message', 'execute', '--requestId', p.data.requestId])
  if (!r.success) throw bawFailed('sign-message execute', r.error)
  for (let i = 0; r.data?.status !== 'COMPLETED' && r.data?.orderId && i < 40; i++) {
    if (['FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(r.data.status)) throw new Error(`the signature was ${r.data.status.toLowerCase()} in the wallet`)
    sleep(3000)
    const q = baw(['sign-message', 'result', '--order-id', r.data.orderId])
    if (q.success) r = q
  }
  if (r.data?.status !== 'COMPLETED') throw Object.assign(new Error('the signature was not completed: approve it in the Binance App if it asks, then run the same command again'), { retryable: true })
  return joinSignature(r.data.signature, r.data.signatureRecovery)
}

/** --telegram as typed (@name, name, t.me/… link) → https://t.me/<name> ('' when empty). Throws bad_telegram. */
export function normalizeTelegram(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const bad = () => new Error(`bad_telegram: --telegram takes a TG handle (@name) or a t.me link (got ${JSON.stringify(s)})`)
  const handle = /^@?([A-Za-z0-9_]{4,32})$/.exec(s)
  if (handle) return `https://t.me/${handle[1]}`
  let u
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`) } catch { throw bad() }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port || !['t.me', 'www.t.me', 'telegram.me'].includes(u.hostname)) throw bad()
  const path = u.pathname.replace(/\/+$/, '')
  if (!/^(?:\/\+?[A-Za-z0-9_-]{1,64}){1,2}$/.test(path)) throw bad()
  return `https://t.me${path}`
}

const chars = (s) => [...String(s ?? '')].length
// what gang.fun takes (its weekly.js): a symbol of letters, digits and CJK / kana / hangul; no control characters in name / contact
export const SYMBOL_RE = /^[A-Za-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u
const CTRL_RE = /[\u0000-\u001f\u007f]/
// zero-width and bidi override / isolate characters: refused everywhere (they can disguise text in gang.fun's posts)
const HIDDEN_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/
// the description may span lines and use tabs, nothing else below U+0020
const DESC_CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/

/**
 * The application's fields from the flags (without wallet / issue / logo), or throws Error('bad_field: …').
 * Limits as gang.fun checks them; optional links left out when not given.
 */
export function applicationFields({ opt, flag }) {
  const bad = (field, why) => Object.assign(new Error(`bad_field: --${field} ${why}`), { field })
  const val = (name) => (flag(name) ? opt(name) : undefined)
  const need = (name) => {
    const v = val(name)
    if (v == null || String(v).startsWith('--') || !String(v).trim()) throw bad(name, 'is required')
    return String(v).trim()
  }
  const name = need('name'); if (chars(name) > 32 || CTRL_RE.test(name) || HIDDEN_RE.test(name)) throw bad('name', 'is at most 32 characters, on one line, no invisible characters')
  const symbol = need('symbol')
  if (chars(symbol) > 12 || !SYMBOL_RE.test(symbol)) throw bad('symbol', 'is at most 12 letters or digits (CJK, kana and hangul too), no spaces or signs')
  // Windows line ends (a file, some agents) are plain newlines: the digest covers what is sent, so this is safe
  const description = need('description').replace(/\r\n?/g, '\n')
  if (chars(description) > 500 || DESC_CTRL_RE.test(description) || HIDDEN_RE.test(description)) throw bad('description', 'is at most 500 characters, no control or invisible characters')
  const contact = need('contact'); if (chars(contact) > 64 || CTRL_RE.test(contact) || HIDDEN_RE.test(contact)) throw bad('contact', 'is at most 64 characters, on one line, no invisible characters')
  const f = { name, symbol, description, contact }
  const link = (flagName, norm) => {
    const v = val(flagName)
    if (v === undefined) return undefined
    if (v == null || String(v).startsWith('--')) throw bad(flagName, 'needs a value')
    try { return norm(v) || undefined } catch (e) { throw bad(flagName, e.message.replace(/^bad_\w+: --[\w-]+ /, '')) }
  }
  const x = link('twitter', normalizeTwitter); if (x) f.x = x
  const tg = link('telegram', normalizeTelegram); if (tg) f.tg = tg
  const website = link('website', normalizeWebsite)
  if (website && !website.startsWith('https://')) throw bad('website', 'must be an https link')
  if (website) f.website = website
  if (flag('modules')) {
    const raw = opt('modules')
    if (raw == null || raw.startsWith('--')) throw bad('modules', `needs a list, e.g. lp,buyback (from ${WEEKLY_MODULES.join(', ')})`)
    const list = [...new Set(raw.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean))]
    const unknown = list.filter((m) => !WEEKLY_MODULES.includes(m))
    if (unknown.length) throw bad('modules', `knows ${WEEKLY_MODULES.join(', ')} (got ${unknown.join(', ')})`)
    if (list.length) f.modules = list
  }
  return f
}

/** IssueView times → local text next to the unix seconds. */
const TIME_KEYS = ['applyOpensAt', 'applyClosesAt', 'opensAt', 'closesAt', 'teaserAt', 'launchAt', 'detectUntil', 'featuredUntil', 'until']
export function withTimes(v) {
  if (!v || typeof v !== 'object') return v ?? null
  const o = { ...v }
  for (const k of TIME_KEYS) if (Number.isFinite(o[k]) && o[k] > 0) o[`${k}Local`] = localTime(o[k])
  if (o.token?.address) o.token = { ...o.token, link: `https://gang.fun/token/${o.token.address}` }
  return o
}

/** `event` of GET /trending → the row the CLI prints first (null when absent or malformed). */
export function eventRow(e) {
  if (!e || e.kind !== 'weekly-launch' || !e.issue) return null
  return withTimes({
    kind: 'weekly-launch', issue: e.issue, number: e.number ?? null, status: e.status ?? null,
    name: e.name ?? null, symbol: e.symbol ?? null, creatorHandle: e.creatorHandle ?? null,
    launchAt: e.launchAt ?? null, until: e.until ?? null,
    token: /^0x[0-9a-fA-F]{40}$/.test(e.token?.address ?? '') ? { address: e.token.address, symbol: e.token.symbol ?? e.symbol ?? null, progressPct: e.token.progressPct ?? null } : null,
    url: WEEKLY_URL, note: WEEKLY_NOTE,
  })
}

async function post(path, body) {
  let r
  try {
    r = await fetch(`${API}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
      body: JSON.stringify(body), signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
  } catch (e) {
    throw Object.assign(new Error(`gang API unreachable (${API}${path}): ${e.cause?.message || e.message}`), { retryable: true })
  }
  let j = null
  try { j = await r.json() } catch { /* below */ }
  if (!r.ok || !j?.ok) {
    const code = j?.error || `http_${r.status}`
    throw Object.assign(new Error(`gang.fun refused it: ${j?.message || code}`), { apiCode: code, field: j?.field, retryable: r.status >= 500 || r.status === 429 })
  }
  return j
}

const SIGN_IN = 'sign in to baw (baw auth signin): the application is signed by the wallet that will create the token'
const LOGO_FLAGS = ['logo', 'logo-file', 'file-logo']
// gang.fun's refusal → the CLI's code (DEVELOPERS.md): a bad field is the command's fault, the rest is state; apiCode keeps it
const API_CODES = { bad_field: 'USAGE', no_agent_id: 'NO_AGENT_ID', rate_limited: 'NETWORK' }

/** runWeekly(sub, io): io = { opt, flag, out, fail, resolveLogo } from index.js. */
export async function runWeekly(sub, { opt, flag, out, fail, resolveLogo }) {
  const signedIn = () => { try { return bawStatus() === 'CONNECTED' } catch { return false } }
  const wallet = () => { try { return bawAddress() } catch (e) { return fail(`${SIGN_IN} (${e.message})`) } }
  const refused = (e) => fail(e.message, {
    ...(e.apiCode && { apiCode: e.apiCode, code: API_CODES[e.apiCode] || 'ERROR' }), ...(e.field && { field: e.field }),
    ...(e.retryable && { retry: 'same command again' }),
  })
  const board = async () => {
    let b
    try { b = await apiGet('/weekly', undefined, '') } catch (e) { fail(e.message, { retry: 'same command again' }) }
    if (!b) fail(`gang.fun has no weekly launch event yet (${API}/weekly)`, { retry: 'later' })
    return b
  }
  const issueOf = (b) => {
    const i = flag('issue') ? opt('issue') : b.apply?.issue
    if (!i || !ISSUE_RE.test(i)) fail('--issue takes the issue\'s Friday date, e.g. 2026-11-13', { got: i ?? null })
    return i
  }
  const mine = async (issue, w) => {
    if (!w || !issue) return null
    try { return await apiGet(`/weekly/application?${new URLSearchParams({ issue, wallet: w.toLowerCase() })}`, undefined, '') } catch { return null }
  }
  const mineRow = (my) => (my ? { issue: my.issue, status: my.status, symbol: my.symbol, submittedAtLocal: localTime(my.submittedAt) } : null)

  if (sub === undefined || sub === 'status' || sub.startsWith('--')) {
    const b = await board()
    const me = signedIn() ? wallet() : null
    if (flag('issue')) {
      const issue = issueOf(b)
      let v
      try { v = await apiGet(`/weekly/${issue}`, undefined, '') } catch (e) { fail(e.message, { retry: 'same command again' }) }
      if (!v) fail(`gang.fun knows no weekly launch issue ${issue}`)
      return out({ success: true, issue: withTimes(v), ...(me && { mine: [mineRow(await mine(issue, me))].filter(Boolean) }), url: WEEKLY_URL, note: WEEKLY_NOTE })
    }
    // my applications: the open issue's, the week before it (closed, being picked: the previous pick may still be the
    // featured `current` then) and current's, newest first
    const live = Array.isArray(b.live) ? b.live : b.current && ['teaser', 'launching', 'featured'].includes(b.current.status) ? [b.current] : []
    const issues = [...new Set([b.apply?.issue, weekBefore(b.apply?.issue), b.current?.issue, ...live.map((v) => v?.issue)].filter((i) => ISSUE_RE.test(i ?? '')))]
      .sort().reverse()
    const mineRows = me ? (await Promise.all(issues.map((i) => mine(i, me)))).filter(Boolean).map(mineRow) : []
    return out({
      success: true,
      // live: every issue in teaser / launching / featured, newest first (two from Thursday 20:00 until the last pick's week ends)
      apply: withTimes(b.apply), current: withTimes(b.current), live: live.map(withTimes), past: (b.past || []).map(withTimes), rules: b.rules ?? null,
      ...(me && { mine: mineRows }),
      url: WEEKLY_URL, note: WEEKLY_NOTE,
      next: b.apply?.open ? 'gang weekly apply --name … --symbol … --logo ./logo.png --description "…" --contact @you  (preview; add --yes to sign and submit)' : null,
    })
  }

  if (sub === 'apply') {
    const unknown = Object.keys(Object.fromEntries(process.argv.slice(4).filter((a) => a.startsWith('--')).map((a) => [a.slice(2), 1])))
      .filter((f) => !APPLY_FLAGS.includes(f))
    if (unknown.length) fail(`gang weekly apply does not take --${unknown[0]} (it takes --${APPLY_FLAGS.filter((f) => f !== 'keep-logo-uri').join(', --')})`)
    if (flag('keep-logo-uri')) fail('--keep-logo-uri: the logo must be on gang.fun (--logo ./file.png, or --logo-uri with a gang upload-logo URL or another image URL, which is copied to gang.fun)')
    let fields
    try { fields = applicationFields({ opt, flag }) } catch (e) { fail(e.message, { code: 'USAGE', ...(e.field && { field: e.field }) }) }
    // the logo: exactly one of a local file or a URL, checked here so the preview can't promise what --yes then refuses
    const files = LOGO_FLAGS.filter((f) => flag(f))
    if (!files.length && !flag('logo-uri')) fail('bad_field: --logo ./file.png (or --logo-uri <image URL>) is required', { code: 'USAGE', field: 'logo' })
    if (files.length > 1 || (files.length && flag('logo-uri'))) fail('use either --logo <file> or --logo-uri <URL>, not both', { code: 'USAGE', field: 'logo' })
    const logoArg = files.length ? opt(files[0]) : opt('logo-uri')
    if (logoArg == null || logoArg.startsWith('--') || !logoArg.trim()) fail(`--${files[0] || 'logo-uri'} needs a value`, { code: 'USAGE', field: 'logo' })
    if (files.length) {
      try { if (!statSync(logoArg).isFile()) throw new Error('not a file') } catch { fail(`--${files[0]}: no file at ${logoArg}`, { code: 'USAGE', field: 'logo' }) }
    } else if (ipfsCid(logoArg)) {
      // ipfs://<cid> or the CDN URL must be a file on gang.fun's bucket (resolveLogoUri would offer --keep-logo-uri)
      try { await checkGangLogo(cdnUrl(ipfsCid(logoArg))) } catch (e) {
        fail(`--logo-uri: ${e.message}`, { field: 'logo', ...(e.retryable ? { retry: 'same command again' } : { code: 'USAGE' }) })
      }
    } else if (!/^https?:\/\//i.test(logoArg)) {
      fail('--logo-uri takes a gang.fun logo (ipfs://<cid> or its cdn.gang.fun URL) or an http(s) image URL to copy there', { code: 'USAGE', field: 'logo' })
    }
    const b = await board()
    const issue = issueOf(b)
    const open = b.apply?.issue === issue && b.apply.open
    if (!open) fail(`applications for ${issue} are not open${b.apply?.issue ? ` (open next: ${b.apply.issue}, ${localTime(b.apply.opensAt)} – ${localTime(b.apply.closesAt)})` : ''}`, { apply: withTimes(b.apply) })
    if (!signedIn()) fail(SIGN_IN)
    // gang.fun refuses a wallet without an Agent ID (no_agent_id); the create gate checks it again at launch
    const w = wallet()
    const rules = b.rules ?? {}
    const terms = [
      `If picked, launch it with gang create (a V3 curve token on ${rules.pad || 'GangLaunchpad 3.0'}, not --fair / --fly) from ${w} with symbol ${fields.symbol} at ${localTime(b.apply.launchAt) ?? 'Friday 20:00 UTC+8'}.`,
      `The pin is withdrawn early if the creator sells more than ${((rules.revokeSellBps ?? 2000) / 100).toFixed(0)}% of their holding during the 7-day featured week.`,
      'If picked: a gang.fun homepage card, X / TG posts and the first row of gang trending for the featured week.',
      'Only the gang.fun team sees contact; everything else may be shown publicly once picked.',
    ]
    if (!flag('yes')) {
      return out({
        success: true, preview: true, issue, number: b.apply.number ?? null,
        // what --yes signs and sends, but the logo: a local file / another host's image becomes ipfs://<cid> on upload
        application: { issue, wallet: w.toLowerCase(), ...fields, logo: ipfsCid(logoArg) ? ipfsUri(ipfsCid(logoArg)) : logoArg },
        ...(!ipfsCid(logoArg) && { logoNote: `${files.length ? 'the file' : 'the image'} is uploaded to gang.fun with --yes; the application carries its ipfs://<cid>` }),
        terms, confirm: `${['gang', ...process.argv.slice(2)].map(shellWord).join(' ')} --yes`, url: WEEKLY_URL,
        note: 'Nothing was signed or sent. Show this to the user; only on their OK run confirm (it uploads the logo, signs with the Agent wallet, no transaction, and submits). Applying again while open replaces the earlier application.',
      })
    }
    const logo = await resolveLogo()
    const cid = ipfsCid(logo.logoURI || '')
    if (!cid) fail('the logo must be on gang.fun\'s IPFS bucket: use --logo ./file.png or --logo-uri with a gang upload-logo URL', { got: logo.logoURI || null })
    const application = { issue, wallet: w.toLowerCase(), ...fields, logo: ipfsUri(cid) }
    const expires = Math.floor(Date.now() / 1000) + SIGN_TTL_S
    let signature
    try {
      signature = bawSignTyped(w, typedData('WeeklyApply', { wallet: w, issue, digest: applicationDigest(application), expires }))
    } catch (e) { fail(e.message, e.retryable ? { retry: 'same command again' } : {}) }
    let r
    try { r = await post('/weekly/apply', { application, expires, signature }) } catch (e) { refused(e) }
    return out({
      success: true, issue, status: r.status ?? 'pending', replaced: !!r.replaced, application,
      ...(logo.uploaded && { logoUploaded: logo.upload?.url ?? true }),
      note: `Submitted. The team picks one application on ${b.apply.launchAt > 0 ? localTime(b.apply.launchAt - 32 * 3600) : 'Thursday 12:00 UTC+8'} and contacts the pick; the pick goes public 24 hours before the launch. gang weekly lists it under mine, with its status.`,
      url: WEEKLY_URL,
    })
  }

  if (sub === 'withdraw') {
    const b = await board()
    const issue = issueOf(b)
    if (!(b.apply?.issue === issue && b.apply.open)) fail(`applications for ${issue} are closed: an application can only be withdrawn while they are open`)
    if (!signedIn()) fail(SIGN_IN)
    const w = wallet()
    const my = await mine(issue, w)
    if (!my) fail(`no application from ${w} for ${issue}`)
    if (my.status === 'withdrawn') fail(`the application from ${w} for ${issue} is already withdrawn`)
    if (!flag('yes')) {
      return out({
        success: true, preview: true, withdraw: { issue, wallet: w.toLowerCase(), status: my.status, symbol: my.symbol },
        confirm: `${['gang', ...process.argv.slice(2)].map(shellWord).join(' ')} --yes`,
        note: 'Nothing was signed or sent. On the user\'s OK run confirm.',
      })
    }
    const expires = Math.floor(Date.now() / 1000) + SIGN_TTL_S
    let signature
    try { signature = bawSignTyped(w, typedData('WeeklyWithdraw', { wallet: w, issue, expires })) } catch (e) { fail(e.message, e.retryable ? { retry: 'same command again' } : {}) }
    let r
    try { r = await post('/weekly/withdraw', { issue, wallet: w.toLowerCase(), expires, signature }) } catch (e) { refused(e) }
    return out({ success: true, issue, status: r.status ?? 'withdrawn' })
  }

  fail(`unknown gang weekly command: ${sub} (gang weekly | gang weekly apply … | gang weekly withdraw)`)
}

/** The issue a week before (YYYY-MM-DD), or null. */
function weekBefore(issue) {
  if (!ISSUE_RE.test(issue ?? '')) return null
  const t = Date.parse(`${issue}T00:00:00Z`)
  return Number.isFinite(t) ? new Date(t - 7 * 86400_000).toISOString().slice(0, 10) : null
}

/** A word as a POSIX shell reads it back: plain words as they are, the rest in single quotes. */
function shellWord(w) {
  return /^[A-Za-z0-9_./:@,=+-]+$/.test(w) ? w : `'${String(w).replace(/'/g, `'\\''`)}'`
}
