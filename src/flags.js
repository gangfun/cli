/**
 * The flags a create takes (gang create, gang v3 / fair / fly create, a launch in one command). Anything else is refused
 * before any wrap / approve round or upload: a token's links and metadata can never change after the create, and a
 * misspelled --website (--x, --website-url, --website=…) used to be dropped without a word.
 */
import { FLY_CREATE_FLAGS } from './fly.js'
import { LAUNCH_FLAGS } from './launch.js'

export const LINK_FLAGS = ['website', 'twitter']
// gang create: V3 by default, a 打新 sale with --fair; a setting of the other kind is refused, not ignored
export const V3_CREATE_FLAGS = ['buy-tax', 'sell-tax', 'dividend', 'recipient']
export const FAIR_CREATE_FLAGS = ['raise', 'cap', 'hold', 'mint-fee', 'exit-fee', 'shares']

export const CREATE_ACCEPTS = new Set([
  'name', 'symbol', 'logo', 'logo-file', 'file-logo', 'logo-uri', 'keep-logo-uri', ...LINK_FLAGS, 'description',
  'quote', 'ref-pool', 'grad', 'testnet', 'calldata', 'from', 'note', 'conf', 'reveal-after',
  'fair', 'fly', ...V3_CREATE_FLAGS, ...FAIR_CREATE_FLAGS, ...FLY_CREATE_FLAGS,
  // a launch in one command: its dev buy reads --slippage like gang buy, its bond --use-wbnb like gang bond post
  ...LAUNCH_FLAGS, 'slippage', 'use-wbnb',
  // refused further on, each with its own reason
  'follow', 'cover', 'taxed', 'pair', 'pair-or-quote', 'hours',
])

// what people type for the two link flags
const LINK_TYPOS = {
  website: ['url', 'site', 'web', 'homepage', 'link', 'website-url', 'web-url', 'site-url', 'websiteurl', 'www'],
  twitter: ['x', 'x-url', 'xurl', 'twitter-url', 'twitter-link', 'twitter-handle', 'tw', 'handle'],
}
const LINK_HINT = { website: '--website <URL>', twitter: '--twitter @handle (or an x.com link)' }

const distance = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}

/** The closest flag `accepts` has to a mistyped `name` (2 edits at most, case ignored), or null. */
export function suggestFlag(name, accepts) {
  const n = name.toLowerCase()
  for (const [to, typos] of Object.entries(LINK_TYPOS)) if (typos.includes(n)) return to
  let best = null, bestD = 3
  for (const f of accepts) {
    const d = distance(n, f)
    if (d < bestD) { best = f; bestD = d }
  }
  return best
}

/**
 * The error for the first flag in argv (process.argv.slice(2)) that `accepts` lacks, or null when every flag is known.
 * A flag is a word starting with "--" and a letter; values ("--- launch day ---") are left to the flag that reads them.
 */
export function unknownFlagError(argv, accepts, label) {
  for (const a of argv) {
    if (!/^--[A-Za-z]/.test(a)) continue
    const raw = a.slice(2)
    const [name, eq] = [raw.split('=')[0], raw.includes('=')]
    if (accepts.has(raw)) continue
    if (eq && accepts.has(name)) return `--${raw}: give the value after a space (--${name} ${raw.slice(name.length + 1) || '<value>'})`
    const to = suggestFlag(name, accepts)
    const hint = !to ? 'see gang help for its flags.' : LINK_HINT[to] ? `did you mean ${LINK_HINT[to]}?` : `did you mean --${to}?`
    return `--${raw} is not a flag of ${label}: ${hint} Nothing was uploaded or sent: unknown flags are refused, since a token's links and metadata can never change after the create`
  }
  return null
}
