import { createTransport, http, parseAbi } from 'viem'
import { bsc, bscTestnet } from 'viem/chains'

/**
 * GangLaunchpad (contract merge, 2026-10-27): V3 tax tokens (bonding curve) and 打新 (fair-mint) sales live on ONE pad —
 * one address, one state, one tax handler, one GangRouter. `gang v3` and `gang fair` both talk to it; `kindOf(token)`
 * on the pad says which kind a token is (0 = not this pad's, 1 = V3 curve, 2 = 打新). The two `create` overloads keep
 * their old selectors, so each command keeps its own ABI fragment.
 *
 * Each network may have several generations of this pad (GANG_GENS: 1.0, 2.0); kindOf on each tells which one has a token.
 *
 * Env (new name first; the old per-command names still work as aliases). The contracts set the create target (gangGens):
 *   mainnet: GANG_PAD (aliases GANG_V3_PAD / GANG_FAIR_PAD), GANG_ROUTER, GANG_BOND, GANG_SPLITTER_FACTORY,
 *            GANG_SPLIT_FACTORY, GANG_LP_FACTORY, GANG_RPC_URL
 *   testnet: GANG_TESTNET_PAD (aliases GANG_V3_TESTNET_PAD / GANG_FAIR_TESTNET_PAD),
 *            GANG_TESTNET_ROUTER (alias GANG_ROUTER_TESTNET), GANG_TESTNET_BOND, GANG_TESTNET_SPLITTER_FACTORY,
 *            GANG_TESTNET_SPLIT_FACTORY, GANG_TESTNET_LP_FACTORY,
 *            GANG_TESTNET_RPC_URL (aliases GANG_V3_TESTNET_RPC_URL / GANG_FAIR_TESTNET_RPC_URL)
 * An RPC variable takes one URL or a comma-separated list; set, it replaces the public nodes below.
 */

/**
 * GangLaunchpad generations on each network, newest first. A create goes to the first; a token already out stays on the
 * pad that created it and is served with that generation's GangRouter, GangBond and module factories (each of them is
 * bound to one pad). 2.0 (docs/SPEC-CURVE-CREATOR-FEE-2026-10-31.md) has the same V3 curves and 打新 sales, and keeps
 * 70% of the 1% curve fee for the token's creator (creatorFeeOf / claimCreatorFee); a 1.0 pad has neither.
 */
export const GANG_GENS = {
  mainnet: [
    // 2026-10-31, pad block 130874052: 2.0 with the creator fee and the graduation target the creator picks; its own
    // GangRouter, GangBond, buy-back factory (buyback-burn-v4), split-v1, lp-burn-v1 and combo-v1 factories, all bound to
    // this pad and listed on its own GangHandlerAdmin
    {
      gen: '2.0', pad: '0x770331a9accdb53ACb4a45B6c5B7D151fADCe557', router: '0xa83209d6bfC2B220cD86410cCDDC71FEb354844a',
      bond: '0x231339463d04A2127E6dD5756756Dd56853AE0D8', splitterFactory: '0x77e499c892e5E6B3eEe1721e6821e9DA1293803C',
      splitFactory: '0xa73dC3d63AAf72E70b1cb012e5f3A541360Bec59', lpFactory: '0x8ac85f150f87B536fb05eA163908b1077D95c0E4',
      comboFactory: '0xcCeA388DbC0Edb206eC25C9715546d57029198Be',
    },
    // 2026-10-27, pad block 130104322. router = the GangRouter proxy: BNB buys and every PancakeSwap trade of a graduated
    // token (V3, 打新 and V2 / Soft / U / S alike). GangBond 2026-10-29 with the re-review L-1 fix; it replaces 0xf26F…C817
    // (never used; CLI 0.15.1–0.16.1) (docs/MAINNET-GANG-BOND-2026-10-29.md). Buy-back factory v3 (one chunk per 4 minutes;
    // docs/MAINNET-BUYBACK-SPLITTER-2026-10-28.md; v2 0x9346…8F2f and v1 0x6bcd…8546 are stopped, their clones keep
    // working). Split factory 2026-10-30 (docs/MAINNET-SPLIT-MODULE-2026-10-30.md), LP factory 2026-10-31
    {
      gen: '1.0', pad: '0x15CFD2dc8278Fb87a1783ef42111618E20874365', router: '0xE040445690Aa56C8b68B7f7038C7b2562B5079C4',
      bond: '0xe92dC940CB23Dc328639A7334e69F9CCdf3a14E4', splitterFactory: '0xf1d5CA816d72e6F130f42662d11b238312A7F1Cd',
      splitFactory: '0x27e08271E52B2D129c824CD245e69471a8d3067c', lpFactory: '0xE0436867dAFcf42Ee1418083251a9B8B61F0C248',
      // combo-v1, 2026-10-31 (the Safe allowed it on GangHandlerAdmin at block 130811492)
      comboFactory: '0xd33C38BE3f8472b3013167830F0638C1704e1DBd',
    },
  ],
  testnet: [
    // 2026-10-31, pad block 139940227: 2.0 with the graduation target the creator picks (GRAD_BNB_TIERS, createWithGradTarget;
    // docs/SPEC-CURVE-GRAD-TARGET-2026-10-31.md); buy-back factory buyback-burn-v4, split-v1, lp-burn-v1, its own GangBond
    {
      gen: '2.0', pad: '0xb14d415f70D7F99f0D93Bd3BF76e0D6b38b53B3E', router: '0x5a4FA2D91638a305EdF027894753c943f095dDAA',
      bond: '0x39749B59066d9cd1c55E2Fc48B31a3978C9951F9', splitterFactory: '0xDC9EdA9a29F4Ff66E7dAb6E5A2142df5a7aC0f6e',
      splitFactory: '0xb9ab949C717a4F7f05c7B003C612C437280C3513', lpFactory: '0xAEec7e7948FfDb7a212E14c0b9cc1DA2922436E4',
      comboFactory: '0x312c86F7139b3e3a75ee66b4D5Bfdbe5077584BD',
    },
    // 2026-10-31, pad block 139866088: the first 2.0 (creator fee, no graduation pick), no longer creating; its tokens trade
    // and claim here. Its modules from the same scripts as 1.0's (docs/TESTNET-GANGLAUNCHPAD2-2026-10-31.md)
    {
      gen: '2.0', pad: '0x6381707406eb7E8EF8EdaF2DedBfFcEFFC0b39be', router: '0xb21828C49A526FA293C48990070a518e9ab9FC08',
      bond: '0x913966122b9f8CC00C0d81000988A483c6B7F97f', splitterFactory: '0xBc26A6585B3Dc2Cbf1522475fB5b18df6C1033AE',
      splitFactory: '0x860D51808E9FBB4f887FC7d0Aa9e1F8E19E00879', lpFactory: '0x4f1544e4e8853fC62088f0A4eCbEF409D2e11619',
      comboFactory: null, // none: its tokens can't have a combined recipient
    },
    // set 10 (2026-10-27: §23 aggregator entries). GangBond 2026-10-29, block 139463214 — the audited version (earlier:
    // 0x587f…5d7E, 0x5a99…d716, 0xB034…EBE3; docs/TESTNET-GANG-BOND-2026-10-28.md); split and LP factories
    // docs/TESTNET-SPLIT-MODULE-2026-10-30.md, docs/TESTNET-LP-MODULE-2026-10-30.md
    {
      gen: '1.0', pad: '0xFebF58ba418ab4a3B3f054827eb11E99369C5BB1', router: '0x6bB660f310a9644Dc173E7Cf2F73498716D9C9F6',
      bond: '0xd6a8dd5d1E6641a34A255f25Db2B3ED397CB1086', splitterFactory: '0x7E63fF8A9FB9Ab1BE4e2128e9f6C8D1054292BBe',
      splitFactory: '0x5F7dC7502E945A860Cf49cca72dA8bD60Fb1567E', lpFactory: '0xA729C60FCa0Bd0D28a55E22126D3fE412AA41591',
      comboFactory: '0x52a8f90a92E5C1828b4436a0B99C6b293f7F4CFE',
    },
  ],
}
// what a generation brings to a ctx (gen: '1.0' | '2.0', null for a pad named by the env that this CLI does not know)
const GEN_FIELDS = ['gen', 'pad', 'router', 'bond', 'splitterFactory', 'splitFactory', 'lpFactory', 'comboFactory']
// the env names of each field, per network (new name first; the old per-command names still work as aliases)
const GEN_ENV = {
  mainnet: {
    pad: ['GANG_PAD', 'GANG_V3_PAD', 'GANG_FAIR_PAD'], router: ['GANG_ROUTER'], bond: ['GANG_BOND'],
    splitterFactory: ['GANG_SPLITTER_FACTORY'], splitFactory: ['GANG_SPLIT_FACTORY'], lpFactory: ['GANG_LP_FACTORY'],
    comboFactory: ['GANG_COMBO_FACTORY'],
  },
  testnet: {
    pad: ['GANG_TESTNET_PAD', 'GANG_V3_TESTNET_PAD', 'GANG_FAIR_TESTNET_PAD'], router: ['GANG_TESTNET_ROUTER', 'GANG_ROUTER_TESTNET'],
    bond: ['GANG_TESTNET_BOND'], splitterFactory: ['GANG_TESTNET_SPLITTER_FACTORY'], splitFactory: ['GANG_TESTNET_SPLIT_FACTORY'],
    lpFactory: ['GANG_TESTNET_LP_FACTORY'], comboFactory: ['GANG_TESTNET_COMBO_FACTORY'],
  },
}

// Public BSC nodes, tried in this order (2026-10-30: each answered eth_call with revert data, tx and receipt reads).
// Several operators, so one node's rate limit or outage does not stop a preview.
export const MAINNET_RPCS = [
  'https://bsc-dataseed.binance.org', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io', 'https://bsc-rpc.publicnode.com',
]
// publicnode first: the data-seed nodes keep little state and answer `missing trie node` sooner
export const TESTNET_RPCS = [
  'https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet.bnbchain.org',
  'https://data-seed-prebsc-1-s1.bnbchain.org:8545', 'https://data-seed-prebsc-2-s1.bnbchain.org:8545',
]

/** An RPC variable's value → its URLs (one, or a comma-separated list), or null when unset / empty. */
export const rpcList = (v) => {
  const urls = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return urls.length ? urls : null
}

// what every node would answer alike: the contract's revert, gas or funds the call lacks. Thrown at once, not retried
const SAME_ON_EVERY_NODE = /execution reverted|gas required exceeds allowance|insufficient funds/i
const sameOnEveryNode = (e) => e?.code === 3 || SAME_ON_EVERY_NODE.test(e?.details ?? '')
// list → the index of the node that answered last; the next call (of any client on that list) starts there
const lastGood = new Map()

/**
 * viem transport over a list of nodes. A call goes to the node that answered last and moves down the list when it
 * fails (rate limit, timeout, the node's own error), so a dead node costs one timeout, not one per call. A revert is the
 * contract's answer and is thrown as it is. One URL: plain http with viem's retries, as before. (viem's fallback()
 * starts every call at the first node, and its ranking keeps a timer that holds the process open.)
 */
export function rpcTransport(urls) {
  if (urls.length === 1) return http(urls[0])
  const key = urls.join(',')
  const nodes = urls.map((u) => http(u, { retryCount: 0, timeout: 8_000 }))
  return ({ chain }) => {
    const live = nodes.map((n) => n({ chain }))
    return createTransport({
      key: 'gang', name: 'Gang RPC', type: 'gang', retryCount: 1,
      async request({ method, params }) {
        const first = lastGood.get(key) ?? 0
        let error
        for (let k = 0; k < live.length; k++) {
          const i = (first + k) % live.length
          try {
            const r = await live[i].request({ method, params })
            lastGood.set(key, i)
            return r
          } catch (e) {
            if (sameOnEveryNode(e)) throw e
            error = e
          }
        }
        throw error
      },
    })
  }
}

const env = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n]
  return null
}

const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/**
 * The generations of a network as this run sees them, newest first. The env overrides the create target (the first):
 * a GANG_PAD naming a known pad makes that generation the target, with its own contracts; an unknown pad gets only the
 * router, bond and factories the env names. Every contract the env does not override stays the generation's own, so a
 * pad is never paired with another generation's router or bond: a variable naming another built-in generation's
 * contract (an old GANG_TESTNET_ROUTER set for set 10, say) is left out — that generation's tokens use it anyway.
 */
export function gangGens(testnet) {
  const net = testnet ? 'testnet' : 'mainnet'
  const set = Object.fromEntries(Object.entries(GEN_ENV[net]).map(([k, names]) => [k, env(...names)]))
  const list = GANG_GENS[net]
  const first = { ...(set.pad ? (list.find((g) => sameAddr(g.pad, set.pad)) ?? { gen: null, pad: set.pad }) : list[0]) }
  for (const k of GEN_FIELDS.slice(2)) {
    if (set[k] && !list.some((g) => !sameAddr(g.pad, first.pad) && sameAddr(g[k], set[k]))) first[k] = set[k]
  }
  return [first, ...list.filter((g) => !sameAddr(g.pad, first.pad))].map(genFields)
}

/** A generation's contracts as ctx fields (missing ones null). */
export const genFields = (g) => Object.fromEntries(GEN_FIELDS.map((k) => [k, g?.[k] ?? null]))

/**
 * Network settings for `gang v3` (kind 'v3') or `gang fair` (kind 'fair'): the same pad on a merged deployment. pad,
 * router, bond and the factories are the create target's; `gens` lists every generation (atTokenPad moves a ctx to the
 * one that has a token).
 */
export function padNets(kind) {
  const alias = kind === 'v3' ? 'V3' : 'FAIR'
  const [main, test] = [gangGens(false), gangGens(true)]
  return {
    mainnet: {
      chainId: '56', chain: bsc, ...genFields(main[0]), gens: main,
      rpcs: rpcList(env('GANG_RPC_URL')) || MAINNET_RPCS,
      wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', explorer: 'https://bscscan.com',
    },
    testnet: {
      chainId: '97', chain: bscTestnet, ...genFields(test[0]), gens: test,
      rpcs: rpcList(env('GANG_TESTNET_RPC_URL', `GANG_${alias}_TESTNET_RPC_URL`)) || TESTNET_RPCS,
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
  // 2.0, both kinds: the graduation amount / raise in the quote is more than a PancakeSwap pair can hold
  'error QuoteAmountTooLarge()',
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
  QuoteAmountTooLarge: 'in this quote the graduation target / raise is more than a PancakeSwap pair can hold (the quote is priced far below BNB, often by a skewed --ref-pool): pick another quote or reference pool',
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
 * Which generation's pad has `token`, asked of every pad of ctx.gens at once: { g, kind } with kind 'v3' | 'fair';
 * { g: null, kind: 'none' } when no pad has it; kind null when a pad could not be read and no other one has it.
 */
export async function genOf(ctx, token) {
  const gens = ctx.gens ?? [ctx]
  const kinds = await Promise.all(gens.map((g) => kindOf({ ...ctx, pad: g.pad }, token)))
  const i = kinds.findIndex((k) => k === 'v3' || k === 'fair')
  if (i >= 0) return { g: gens[i], kind: kinds[i] }
  return { g: null, kind: kinds.includes(null) ? null : 'none' }
}

/**
 * Move ctx to the generation whose pad has `token`: its pad, router, GangBond and factories. ctx stays on the create
 * target when no pad has the token (the caller then says what it is not). → the token's kind as genOf gives it (null:
 * a pad could not be read, see KIND_UNREAD); undefined when `token` is not an address (the caller refuses it).
 */
export async function atTokenPad(ctx, token) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token ?? '')) return undefined
  const { g, kind } = await genOf(ctx, token)
  if (g && !sameAddr(g.pad, ctx.pad)) {
    Object.assign(ctx, genFields(g))
    delete ctx._tax // the tax handler and the fee constants are the pad's
    delete ctx.fees
  }
  return kind
}

/**
 * Point ctx at the generation whose pad is `pad` (a module's own pad()), as atTokenPad does for a token; false when `pad`
 * is none of this network's GangLaunchpad pads.
 */
export function atPad(ctx, pad, testnet) {
  const g = gangGens(testnet).find((x) => sameAddr(x.pad, pad))
  if (!g) return false
  if (!sameAddr(g.pad, ctx.pad)) {
    Object.assign(ctx, genFields(g))
    delete ctx._tax
    delete ctx.fees
  }
  return true
}

const LISTING_ABI = parseAbi([
  'function taxHandler() view returns (address)',
  'function owner() view returns (address)',
  'function moduleOf(address module) view returns (address)',
])
/**
 * The factory that listed `module` on ctx.pad's tax handler (GangHandlerAdmin, the handler's owner: moduleOf), or null
 * when it never listed it: not one of the platform's modules, whatever its moduleType() says.
 */
export async function listedBy(ctx, module) {
  const handler = await ctx.read(ctx.pad, LISTING_ABI, 'taxHandler')
  const admin = await ctx.read(handler, LISTING_ABI, 'owner')
  const factory = await ctx.read(admin, LISTING_ABI, 'moduleOf', [module])
  return /^0x0{40}$/.test(factory) ? null : factory
}

/** What a command says when atTokenPad could not read every pad (null): retry rather than a wrong "not this kind". */
export const KIND_UNREAD = { error: 'could not read which GangLaunchpad has this token (kindOf; RPC error)', retry: 'same command again' }

/** The 2.0 creator fee: 70% of the 1% curve fee of each V3 curve trade, kept on the pad for the token's creator. */
export const CREATOR_FEE_ABI = parseAbi([
  'function CREATOR_FEE_SHARE_BPS() view returns (uint256)',
  'function creatorFeeOf(address token) view returns (uint256)',
  'function claimCreatorFee(address token, address to) returns (uint256 amount)',
  'error NotCreator()',
  'event CreatorFeeAccrued(address indexed token, address indexed creator, uint256 amount)',
  'event CreatorFeeClaimed(address indexed token, address indexed creator, address indexed to, uint256 amount)',
])
const feeShares = new Map()
// a call that hit a contract without the function: no return data, or a revert without data. An RPC's internal error
// (-32603) also comes back from viem as a revert, so it is told apart by its code
const noSuchFunction = (e) => !e?.walk?.((x) => x?.code === -32603)
  && !!e?.walk?.((x) => x?.name === 'ContractFunctionZeroDataError' || (x?.name === 'ContractFunctionRevertedError' && !x.data && (!x.raw || x.raw === '0x')))
/**
 * The pad's creator share of the curve fee in bps (7000 on 2.0); null on a 1.0 pad. A built-in generation is known
 * without a call (1.0: null); a pad named by the env is asked: a 1.0 pad has no CREATOR_FEE_SHARE_BPS (the call reverts
 * without data). Any other error (the RPC) is thrown, so a 2.0 token is never shown as 1.0.
 */
export async function creatorFeeShareOf(ctx, pad = ctx.pad) {
  const known = [...GANG_GENS.mainnet, ...GANG_GENS.testnet].find((g) => sameAddr(g.pad, pad))
  if (known?.gen === '1.0') return null
  const key = `${ctx.chainId}:${pad.toLowerCase()}`
  if (!feeShares.has(key)) {
    const p = ctx.read(pad, CREATOR_FEE_ABI, 'CREATOR_FEE_SHARE_BPS').then(Number).catch((e) => {
      if (!known && noSuchFunction(e)) return null
      feeShares.delete(key)
      throw e
    })
    feeShares.set(key, p)
  }
  return feeShares.get(key)
}

/**
 * The V3 curve graduation target (GangLaunchpad 2.0): the creator picks one of GRAD_BNB_TIERS (BNB raised) with
 * createWithGradTarget, create takes TARGET_GRAD_BNB (9 on 2.0). 1.0 has neither pick nor tiers: every curve 15 BNB.
 */
export const GRAD_TARGET_ABI = parseAbi([
  'function GRAD_BNB_TIERS() pure returns (uint256[4])',
  'function TARGET_GRAD_BNB() view returns (uint256)',
  'function gradTargetOf(address token) view returns (uint256)',
  'function graduationAmountFor(address quote, address refPool, uint256 gradBnb) view returns (uint256)',
  'error BadGradTarget()',
  'event GradTargetSet(address indexed token, uint256 gradBnb)',
])
const gradTiers = new Map()
const bnbNum = (wei) => Number(wei / 10n ** 15n) / 1000
/**
 * The graduation targets a creator may pick on `pad`, in BNB ([6, 9, 12, 15]); null on a pad without the pick (1.0,
 * known without a call, or an older 2.0 build: GRAD_BNB_TIERS reverts without data). An RPC error is thrown.
 */
export async function gradTiersOf(ctx, pad = ctx.pad) {
  const known = [...GANG_GENS.mainnet, ...GANG_GENS.testnet].find((g) => sameAddr(g.pad, pad))
  if (known?.gen === '1.0') return null
  const key = `${ctx.chainId}:${pad.toLowerCase()}`
  if (!gradTiers.has(key)) {
    const p = ctx.read(pad, GRAD_TARGET_ABI, 'GRAD_BNB_TIERS').then((t) => t.map(bnbNum)).catch((e) => {
      if (noSuchFunction(e)) return null
      gradTiers.delete(key)
      throw e
    })
    gradTiers.set(key, p)
  }
  return gradTiers.get(key)
}
/** A token's graduation target in BNB raised: its pick (gradTargetOf) where the pad has one, else the pad's TARGET_GRAD_BNB. */
export async function gradTargetBnbOf(ctx, token) {
  if (await gradTiersOf(ctx)) {
    const v = await ctx.read(ctx.pad, GRAD_TARGET_ABI, 'gradTargetOf', [token])
    if (v > 0n) return bnbNum(v)
  }
  return bnbNum(await ctx.read(ctx.pad, GRAD_TARGET_ABI, 'TARGET_GRAD_BNB'))
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
