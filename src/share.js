/**
 * Ready-to-post text for X (GET /api/share): after a note is published (?note=<trade tx>) or a token is created
 * (?token=<addr>&event=create). gang.fun returns { text, url, image }: English, at most 240 characters, the page link
 * whose card X renders from its og tags. The agent offers it to the user; nothing is ever posted from here.
 * A tx gang.fun hasn't indexed yet answers 404: one retry after 3s, then the result goes without `share`.
 */
import { API } from './discover.js'
import { UA } from './version.js'

const TIMEOUT_MS = 5_000
const RETRY_MS = 3_000
export const SHARE_NOTE = 'Offer this to the user to post on X: text already ends with the link. Never post it on their behalf.'

async function fetchShare(q) {
  try {
    const r = await fetch(`${API}/share?${q}`, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (r.status === 404) return 'retry'
    if (!r.ok) return null
    const b = await r.json()
    return typeof b?.text === 'string' && typeof b?.url === 'string' ? { text: b.text, url: b.url, image: b.image ?? null } : null
  } catch { return null }
}

/** { text, url, image, note } or null. `note`: a trade tx with a published note; else `token` (+ `event: 'create'`). */
export async function shareFor({ note, token, event }, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const q = new URLSearchParams(note ? { note } : { token, ...(event && { event }) })
  if (!note && !token) return null
  let s = await fetchShare(q)
  if (s === 'retry') {
    await wait(RETRY_MS)
    s = await fetchShare(q)
  }
  return s && s !== 'retry' ? { ...s, note: SHARE_NOTE } : null
}
