import { parseAbi } from 'viem'
import { bsc, bscTestnet } from 'viem/chains'

/**
 * GangLaunchpad (contract merge, 2026-10-27): V3 tax tokens (bonding curve) and 打新 (fair-mint) sales live on ONE pad —
 * one address, one state, one tax handler, one GangRouter. `gang v3` and `gang fair` both talk to it; `kindOf(token)`
 * on the pad says which kind a token is (0 = not this pad's, 1 = V3 curve, 2 = 打新). The two `create` overloads keep
 * their old selectors, so each command keeps its own ABI fragment.
 *
 * Env (new name first; the old per-command names still work as aliases):
 *   mainnet: GANG_PAD (aliases GANG_V3_PAD / GANG_FAIR_PAD), GANG_ROUTER, GANG_RPC_URL
 *   testnet: GANG_TESTNET_PAD (aliases GANG_V3_TESTNET_PAD / GANG_FAIR_TESTNET_PAD),
 *            GANG_TESTNET_ROUTER (alias GANG_ROUTER_TESTNET),
 *            GANG_TESTNET_RPC_URL (aliases GANG_V3_TESTNET_RPC_URL / GANG_FAIR_TESTNET_RPC_URL)
 */

// the current testnet set (set 10, 2026-10-27: §23 aggregator entries); the name is kept from set 8
export const TESTNET_SET8 = { pad: '0xFebF58ba418ab4a3B3f054827eb11E99369C5BB1', router: '0x6bB660f310a9644Dc173E7Cf2F73498716D9C9F6' }
// Mainnet (2026-10-27, pad block 130104322). router = the GangRouter proxy: BNB buys and every PancakeSwap trade of a
// graduated token (V3, 打新 and V2 / Soft / U / S alike). GANG_PAD / GANG_ROUTER still override.
export const MAINNET_GANG = {
  pad: '0x15CFD2dc8278Fb87a1783ef42111618E20874365',
  router: '0xE040445690Aa56C8b68B7f7038C7b2562B5079C4',
}
// Unused while TESTNET_SET8 (set 10) is filled; kept as the fallback shape: testnet set 7 (one pad per kind, one router).
const TESTNET_SET7 = {
  v3: '0x771b6dAA5240e3Cc0F0819535E8200774AFedEED',
  fair: '0xF45C221cF453d3943b00F905f66d66e34380956A',
  router: '0x9dBb3D25Ff5c8107814fBD96A88D6eD015dfA279',
}

const env = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n]
  return null
}

/** Network settings for `gang v3` (kind 'v3') or `gang fair` (kind 'fair'): the same pad on a merged deployment. */
export function padNets(kind) {
  const alias = kind === 'v3' ? 'V3' : 'FAIR'
  // one deployment set at a time: never pair a set-8 pad with the set-7 router or the other way round
  const set = TESTNET_SET8.pad ? TESTNET_SET8 : { pad: TESTNET_SET7[kind], router: TESTNET_SET7.router }
  return {
    mainnet: {
      chainId: '56', chain: bsc,
      pad: env('GANG_PAD', `GANG_${alias}_PAD`) || MAINNET_GANG.pad || null,
      rpc: env('GANG_RPC_URL') || 'https://bsc-dataseed.binance.org',
      wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', explorer: 'https://bscscan.com',
      router: env('GANG_ROUTER') || MAINNET_GANG.router || null,
    },
    testnet: {
      chainId: '97', chain: bscTestnet,
      pad: env('GANG_TESTNET_PAD', `GANG_${alias}_TESTNET_PAD`) || set.pad,
      router: env('GANG_TESTNET_ROUTER', 'GANG_ROUTER_TESTNET') || set.router || null,
      rpc: env('GANG_TESTNET_RPC_URL', `GANG_${alias}_TESTNET_RPC_URL`) || 'https://bsc-testnet-rpc.publicnode.com',
      wbnb: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd', explorer: 'https://testnet.bscscan.com',
    },
  }
}

export const NOT_ON_MAINNET = 'no gang launchpad address for this network — set GANG_PAD (and GANG_ROUTER for BNB buys / mints and pool trades), or add --testnet to use the BSC testnet deployment'

/**
 * Errors of the merged token (GangToken) and handler (GangTaxHandler) that can surface through a pad call, plus the
 * pad's WrongKind (declared here in case the pad has it: decoding goes by selector, an unused entry costs nothing).
 */
export const MERGED_ERRORS_ABI = parseAbi([
  'error Untaxed()', 'error NotReclaimable()', 'error NotLocked()', 'error WrongKind()', 'error TransfersLocked()',
  'error StillLocked()', 'error SwapBackOutOfGas()', 'error SellDuringFlashSwap()', 'error BadKind()',
])
export const MERGED_HINTS = {
  Untaxed: 'this token is untaxed (0% / 0%): it never gets a pool tax, a tax route or dividends; nothing to release or claim on it',
  NotReclaimable: 'only a 打新 (fair-mint) token can be sold back to the pad; a V3 token is sold on its curve (gang sell)',
  NotLocked: 'the sale already launched (the token is unlocked): sell-back is over, trade the token on PancakeSwap',
  WrongKind: 'this token is the other kind on the merged pad: V3 tokens use `gang v3 …`, 打新 tokens use `gang fair …`',
  BadKind: 'the tax handler refused the token kind (a pad / handler wiring problem): report it to gang',
  TransfersLocked: 'the token is locked until graduation / launch: before that it moves only through the pad',
  StillLocked: 'the token has not graduated / launched yet',
  SwapBackOutOfGas: 'too little gas for the sell-time tax chunk: re-run with the estimated gas limit (do not cap it lower)',
  SellDuringFlashSwap: 'a sell paid in from a flash swap callback is refused by this token',
}

const KIND_ABI = parseAbi(['function kindOf(address token) view returns (uint8)'])
const KINDS = ['none', 'v3', 'fair']

/** 'v3' | 'fair' | 'none' from the merged pad's kindOf; null on a pad without kindOf (before the merge) or on an RPC error. */
export async function kindOf(ctx, token) {
  try {
    return KINDS[Number(await ctx.read(ctx.pad, KIND_ABI, 'kindOf', [token]))] ?? null
  } catch {
    return null
  }
}

/**
 * Why `token` is not a `want` ('v3' | 'fair') token on this pad, as { error, hint, kind } for fail(): points at the right
 * subcommand when kindOf says it is the other kind. `net` is appended to the suggested command (' --testnet' or '').
 */
export async function notThisKind(ctx, token, want, net = '') {
  const kind = await kindOf(ctx, token)
  const ask = want === 'v3' ? 'a LaunchpadV3 (tax) token' : 'a 打新 (fair-mint) sale'
  if (kind === 'fair' && want === 'v3') {
    return { error: `this is a 打新 (fair-mint) token, not a V3 token: gang info / buy / sell / mint / withdraw --token ${token}${net} pick the right pad code`, kind }
  }
  if (kind === 'v3' && want === 'fair') {
    return { error: `this is a V3 (bonding-curve) token, not a 打新 sale: gang info / buy / sell --token ${token}${net} pick the right pad code`, kind }
  }
  return { error: `not ${ask} on this pad`, kind }
}
