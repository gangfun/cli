import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { UA } from './version.js'

const MAX_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 20_000
// a POST to /api/logos carries up to 512 KB of image (or 256 KB of JSON): give it longer than a fetch of headers
const UPLOAD_TIMEOUT_MS = 60_000

export const LOGO_API = (process.env.GANG_LOGO_API || 'https://gang.fun/api/logos').replace(/\/+$/, '')
export const LOGO_UI = 'https://gang.fun/dev/logo'
// the upload endpoint stores files in an IPFS bucket as ipfs/<cid>, served by this CDN
// (where --logo-uri ipfs://<cid> is checked; an upload's own url comes from the endpoint)
export const CDN_BASE = (process.env.GANG_CDN_BASE || 'https://cdn.gang.fun').replace(/\/+$/, '')
// CIDv1 (raw, sha2-256, base32) as the upload endpoint makes it
const CID_RE = /^b[a-z2-7]{58}$/

// file hosts that delete uploads after hours or days: a logoURI there turns into a broken image, and it can't be changed on-chain
const TEMP_HOSTS = ['litter.catbox.moe', 'tmpfiles.org', '0x0.st', 'uguu.se', 'file.io', 'transfer.sh']

// network failures, timeouts and 5xx / 429 may pass on a retry; a missing or wrong image won't (follow.js uses these too)
// fetch wraps every failure (also ipfs://, bad URL, expired TLS) in a cause; only these codes and timeouts are transient
const NET_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']
export const fetchError = (msg, e) => Object.assign(new Error(msg), {
  retryable: ['TimeoutError', 'AbortError'].includes(e.name) || NET_CODES.includes(e.cause?.code),
})
export const statusError = (msg, status) => Object.assign(new Error(msg), { retryable: status >= 500 || status === 429 })
export const why = (e) => e.cause?.message || e.message

/** The image type from its first bytes; only the types gang.fun makes thumbnails for (png / jpeg / gif / webp). */
function sniffMime(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** On-chain form of an uploaded file: ipfs://<cid>, not the CDN URL. */
export const ipfsUri = (cid) => `ipfs://${cid}`
export const cdnUrl = (cid) => `${CDN_BASE}/ipfs/${cid}`

export const isIpfsUri = (uri) => /^ipfs:\/\//i.test(String(uri || '').trim())

/**
 * The cid in ipfs://<cid> (also ipfs://ipfs/<cid>) or <CDN>/ipfs/<cid>, when it is a CIDv1 like ours; else null. A
 * ?query / #hash / trailing slash is dropped: the CDN's ?x-tos-process=… thumbnail still names the original file.
 */
export function ipfsCid(uri) {
  const s = String(uri || '').trim()
  const cid = s.startsWith(`${CDN_BASE}/ipfs/`) ? s.slice(CDN_BASE.length + 6) : s.replace(/^ipfs:\/\/(ipfs\/)?/i, '')
  if (cid === s) return null
  const bare = cid.replace(/[?#].*$/s, '').replace(/\/+$/, '')
  return CID_RE.test(bare) ? bare : null
}

/** The upload response's cid (or the one in its URL); an upload without one has nothing to put on-chain. */
function uploadedCid(json, what, status) {
  const cid = CID_RE.test(json?.cid) ? json.cid : ipfsCid(json?.url || json?.logoUrl)
  if (!cid) {
    throw statusError(`${what} upload returned no cid (${status}), so there is no ipfs:// URI to put on-chain; ${LOGO_API} `
      + `must answer like gang.fun's upload endpoint (GANG_LOGO_API): ${JSON.stringify(json).slice(0, 200)}`, status)
  }
  return cid
}

/** Image bytes → data URL → POST /api/logos → { logoUrl: ipfs://<cid>, url: the endpoint's CDN URL, cid, id, bytes }. */
async function postLogo(buf, what) {
  if (buf.length <= 0) throw new Error(`empty image: ${what}`)
  if (buf.length > MAX_BYTES) throw new Error(`logo too large: ${buf.length} bytes (max ${MAX_BYTES}): ${what}`)
  const mime = sniffMime(buf)
  if (!mime) throw new Error(`not a png/jpeg/webp/gif image: ${what}`)
  const image = `data:${mime};base64,${buf.toString('base64')}`
  let res, text
  try {
    res = await fetch(LOGO_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
      body: JSON.stringify({ image }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
    text = await res.text()
  } catch (e) {
    throw fetchError(`logo upload failed: ${why(e)}`, e)
  }
  let json
  try { json = JSON.parse(text) } catch { throw statusError(`logo upload non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status) }
  if (!res.ok || !json?.ok || !json?.logoUrl) {
    throw statusError(`logo upload failed (${res.status}): ${json?.error || text.slice(0, 200)}`, res.status)
  }
  const cid = uploadedCid(json, 'logo', res.status)
  return { logoUrl: ipfsUri(cid), url: json.url || cdnUrl(cid), cid, id: json.id, bytes: json.bytes ?? buf.length, api: LOGO_API }
}

/**
 * Token metadata JSON (the token's contractURI / metaURI, permanent on-chain) → POST /api/logos as application/json →
 * { uri: ipfs://<cid>, url: the endpoint's CDN URL, cid, id, bytes }. Keys with no value are left out. Same upload endpoint and CDN as logos.
 */
export async function uploadMetadata(meta) {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null && v !== ''))
  const buf = Buffer.from(JSON.stringify(clean))
  if (buf.length > 256 * 1024) throw new Error(`metadata too large: ${buf.length} bytes (max 256 KB)`)
  let res, text
  try {
    res = await fetch(LOGO_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
      body: JSON.stringify({ file: `data:application/json;base64,${buf.toString('base64')}` }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
    text = await res.text()
  } catch (e) {
    throw fetchError(`metadata upload failed: ${why(e)}`, e)
  }
  let json
  try { json = JSON.parse(text) } catch { throw statusError(`metadata upload non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status) }
  if (!res.ok || !json?.ok || !(json?.url || json?.logoUrl)) {
    throw statusError(`metadata upload failed (${res.status}): ${json?.error || text.slice(0, 200)}`, res.status)
  }
  const cid = uploadedCid(json, 'metadata', res.status)
  return { uri: ipfsUri(cid), url: json.url || cdnUrl(cid), cid, id: json.id, bytes: json.bytes ?? buf.length, metadata: clean }
}

/** Read a local image → POST /api/logos → { logoUrl, url, cid, id, bytes }. */
export async function uploadLogoFile(filePath) {
  const abs = resolve(filePath)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`not a file: ${abs}`)
  if (st.size > MAX_BYTES) throw new Error(`logo too large: ${st.size} bytes (max ${MAX_BYTES})`)
  return postLogo(readFileSync(abs), abs)
}

/** True when the URL is an old gang.fun logo, from before the IPFS bucket (nothing to copy). */
export const isGangLogo = (uri) => uri.startsWith(`${LOGO_API}/`)

/** Throw unless a gang.fun logo URL serves an image (a typo'd id would go on-chain as a broken logo). Reads headers only. */
export async function checkGangLogo(uri) {
  let res
  try {
    // the logo route answers HEAD with 405, so GET and drop the body
    res = await fetch(uri, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    await res.body?.cancel()
  } catch (e) {
    throw fetchError(`could not check logo ${uri}: ${why(e)}`, e)
  }
  if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) {
    throw statusError(`no logo at ${uri} (HTTP ${res.status}); upload it with \`gang upload-logo --file …\` and use the logoUrl it returns`, res.status)
  }
}

/** The temporary file host a URL points at, or null. */
export function tempHost(uri) {
  let host
  try { host = new URL(uri).hostname.toLowerCase() } catch { return null }
  return TEMP_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) || null
}

/** Download an image URL (≤512 KB) → POST /api/logos → { logoUrl, url, cid, id, bytes, source }. */
export async function rehostLogoUrl(uri) {
  const msg = `could not download logo ${uri}`
  let res
  try {
    res = await fetch(uri, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'image/*', 'user-agent': UA } })
  } catch (e) {
    throw fetchError(`${msg}: ${why(e)}`, e)
  }
  if (!res.ok) throw statusError(`${msg}: HTTP ${res.status}`, res.status)
  const len = Number(res.headers.get('content-length'))
  if (len > MAX_BYTES) throw new Error(`${msg}: logo too large: ${len} bytes (max ${MAX_BYTES})`)
  // read with a cap: content-length can be missing or wrong
  const chunks = []
  let size = 0
  try {
    for await (const c of res.body) {
      size += c.length
      if (size > MAX_BYTES) break
      chunks.push(c)
    }
  } catch (e) {
    throw fetchError(`${msg}: ${why(e)}`, e)
  }
  if (size > MAX_BYTES) throw new Error(`${msg}: logo too large: over ${MAX_BYTES} bytes`)
  return { ...(await postLogo(Buffer.concat(chunks), uri)), source: uri }
}
