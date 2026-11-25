/**
 * `--venue` on a create: where the curve graduates to. `pancake` (the default) is PancakeSwap V2 as before; `gangswap`
 * makes a GangSwap curve token (kind 4, gangswap.js). Everything here is decided from the flags alone, before any chain
 * read, wallet step or upload.
 */
import { isAddress } from 'viem'
import { CD_FLAGS } from './countdown.js'
import { FLY_CREATE_FLAGS } from './fly.js'
import { LAUNCH_FLAGS } from './launch.js'
import { padNets } from './gangpad.js'

export const VENUES = ['pancake', 'gangswap']
const USAGE = '--venue must be pancake (PancakeSwap V2, the default) or gangswap (GangSwap)'

const isZero = (v) => /^0+(\.0+)?$/.test(String(v ?? ''))

/** --venue: { venue } or { error, got }. Left out: pancake. */
export function parseVenue(opt, flag) {
  if (!flag('venue')) return { venue: 'pancake' }
  const v = opt('venue')
  return VENUES.includes(v) ? { venue: v } : { error: USAGE, got: v ?? null }
}

const only = (f, why) => `--${f} can't go with --venue gangswap: ${why}`
const MODULES = 'a GangSwap token is untaxed and takes no module, bond or chained launch (a dev buy is its own gang buy after the create lands)'

/**
 * What stops this create from being a GangSwap one: { error, … } for fail(), or null. `fair` / `fly`: the command itself
 * is gang fair / fly create. Only --grad, --agent-window, --grad-reward (without a carry), the logo, links, metadata and notes
 * go with --venue gangswap.
 */
export function venueRefusal({ opt, flag, testnet = false, fair = false, fly = false }) {
  const p = parseVenue(opt, flag)
  if (p.error) return p
  if (p.venue !== 'gangswap') return null
  if (fair || flag('fair')) return { error: only('fair', 'a 打新 (fair-mint) sale always launches on PancakeSwap: drop one of them') }
  if (fly || flag('fly')) return { error: only('fly', 'a 铸币飞轮 (Mint Flywheel) sale always launches on PancakeSwap: drop one of them') }
  for (const f of ['buy-tax', 'sell-tax']) if (flag(f) && !isZero(opt(f))) return { error: only(f, 'a GangSwap token is untaxed') }
  for (const f of ['dividend', 'recipient']) if (flag(f)) return { error: only(f, 'a GangSwap token is untaxed: no dividend and no tax recipient') }
  if (flag('quote')) {
    const wbnb = padNets('v3')[testnet ? 'testnet' : 'mainnet'].wbnb
    if (!isAddress(opt('quote') ?? '') || opt('quote').toLowerCase() !== wbnb.toLowerCase()) return { error: only('quote', 'a GangSwap token is quoted in WBNB (leave --quote out)'), got: opt('quote') ?? null }
  }
  if (flag('ref-pool')) return { error: only('ref-pool', 'a GangSwap token is quoted in WBNB and needs no reference pool') }
  for (const f of ['promote', 'promote-days']) if (flag(f)) return { error: only(f, 'a GangSwap token takes no promoter share, with --grad-reward or without') }
  for (const f of ['base', 'base-vest']) if (flag(f)) return { error: only(f, 'a GangSwap token takes no opening base') }
  if (flag('vault')) return { error: only('vault', 'a GangSwap token is not bound to a vault') }
  // --grad-reward itself goes with it (createGangSwapWithGradReward, where the pad serves it): its carry does not
  if (flag('gr-carry')) return { error: only('gr-carry', 'a carry goes into the token\'s countdown reward, and a GangSwap token is untaxed, so it has none: what nobody claims goes back to you. Leave --gr-carry out') }
  const cd = ['countdown-reward', ...CD_FLAGS].find((f) => flag(f))
  if (cd) return { error: only(cd, 'a GangSwap token is untaxed, so it takes no countdown reward') }
  const launch = LAUNCH_FLAGS.find((f) => flag(f))
  if (launch) return { error: only(launch, MODULES) }
  const other = FLY_CREATE_FLAGS.filter((f) => !['sell-tax'].includes(f)).concat('cap', 'shares').find((f) => flag(f))
  if (other) return { error: only(other, 'it is a setting of another kind of sale') }
  return null
}
