/**
 * Token links (create --website / --twitter): what counts as a stored value and how typed input becomes one.
 * No imports, so discover.js can check what the API returns without an import cycle (notes.js imports discover.js).
 * The calldata codec is in notes.js (linksSuffix / readTokenLinks). Same rules as the server's noteCommit.js.
 */
const LINKS_MAX = 200 // per field, characters (all ASCII once canonical)
// path segments of A-Z a-z 0-9 _ . -, but not "." or ".." (a browser would resolve those away)
const X_URL = /^https:\/\/x\.com(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+)+$/
// the last label of a domain starts with a letter (TLDs, punycode xn--…); WHATWG URL reads an all-digit last label as IPv4
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/
const X_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'])

/** Error code for a stored website value, or null: a canonical http(s) URL on a domain (no IP), no port, no credentials. */
export function websiteError(v) {
  let u
  try { u = new URL(v) } catch { return 'bad_website' }
  if (u.href !== v || v.length > LINKS_MAX) return 'bad_website'
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port || !DOMAIN.test(u.hostname)) return 'bad_website'
  return null
}

/** Error code for a stored twitter value, or null: https://x.com/<path>, no query. */
export const twitterError = (v) => (X_URL.test(v) && v.length <= LINKS_MAX ? null : 'bad_twitter')

/** --website as typed → canonical URL ('' when empty). "example.com" means https://example.com/. Throws bad_website. */
export function normalizeWebsite(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const bad = (why) => new Error(`bad_website: --website ${why} (got ${JSON.stringify(s)})`)
  if (!/^https?:\/\//i.test(s) && s.includes('://')) throw bad('must be an http(s) link')
  let u
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`) } catch { throw bad('is not a valid link') }
  if (websiteError(u.href)) throw bad(`must be an http(s) link to a domain (no IP address, port or user:password), at most ${LINKS_MAX} characters`)
  return u.href
}

/** --twitter as typed (@handle, handle, x.com/… or twitter.com/… link) → https://x.com/<path> ('' when empty). Throws bad_twitter. */
export function normalizeTwitter(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const bad = () => new Error(`bad_twitter: --twitter takes an X handle (@name) or an x.com / twitter.com link (got ${JSON.stringify(s)})`)
  const handle = /^@?([A-Za-z0-9_]{1,15})$/.exec(s)
  if (handle) return `https://x.com/${handle[1]}`
  let u
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`) } catch { throw bad() }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port || !X_HOSTS.has(u.hostname)) throw bad()
  // query and fragment (?s=20 share tracking) are dropped; x.com/@name is x.com/name
  const v = `https://x.com${u.pathname.replace(/^\/@/, '/').replace(/\/+$/, '')}`
  if (twitterError(v)) throw bad()
  return v
}
