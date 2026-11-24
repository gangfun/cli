import { encodeFunctionData, parseAbi } from 'viem'
import { missingRead } from './base.js'
import { PAD3_GEN } from './gangpad.js'

/**
 * The agent window (GangLaunchpad 3.0, docs/SPEC-AGENT-WINDOW-2026-11-20.md): a curve token created through
 * `createWithAgentWindow(minutes, <the create call>)` opens to every wallet `minutes` after its create block. Until then
 * only Agent ID holders trade it on the curve, under the 1% wallet cap; from then on any wallet does (contracts too) and
 * the cap is off, for good. No window = agent only for good. A pad without MAX_AGENT_WINDOW_MINUTES() has no window
 * (mainnet before its upgrade): the CLI then builds nothing with --agent-window and shows nothing for it.
 */
export const AGENT_WINDOW_ABI = parseAbi([
  'function createWithAgentWindow(uint16 windowMinutes, bytes data) payable returns (address token)',
  'function agentOpenAt(address token) view returns (uint40)',
  'function agentWindowOpen(address token) view returns (bool)',
  'function canTradeCurve(address token, address account) view returns (bool)',
  'function walletCapOn(address token) view returns (bool)',
  'function MIN_AGENT_WINDOW_MINUTES() view returns (uint16)',
  'function MAX_AGENT_WINDOW_MINUTES() view returns (uint16)',
  'event AgentWindowSet(address indexed token, uint40 openAt)',
  'error BadAgentWindow()', 'error BadAgentWindowCall()', 'error AgentWindowNotUsed()',
])

export const MIN_WINDOW_MINUTES = 1
export const MAX_WINDOW_MINUTES = 1440

export const HINTS = {
  BadAgentWindow: `--agent-window must be whole minutes, ${MIN_WINDOW_MINUTES}–${MAX_WINDOW_MINUTES} (24 hours)`,
  BadAgentWindowCall: '--agent-window wraps a V3 curve create only (not 打新 / 铸币飞轮)',
  AgentWindowNotUsed: 'the create inside --agent-window made no curve token for this wallet (a 打新 / 铸币飞轮 create takes no window)',
}

const USAGE = `--agent-window takes whole minutes, ${MIN_WINDOW_MINUTES}–${MAX_WINDOW_MINUTES} (24 hours), e.g. --agent-window 60`

/** --agent-window <minutes>: { minutes } or { error, got }. Whole minutes only (no 1h / 30m forms). */
export function parseAgentWindow(raw) {
  const s = String(raw ?? '').trim()
  if (!/^\d+$/.test(s)) return { error: USAGE, got: raw ?? null }
  const minutes = Number(s)
  if (minutes < MIN_WINDOW_MINUTES || minutes > MAX_WINDOW_MINUTES) return { error: USAGE, got: raw }
  return { minutes }
}

/**
 * Whether the create target serves the window: { open: true, min, max } | { open: false, why } | { unread }. Asked of
 * MAX_AGENT_WINDOW_MINUTES(): a bare revert is a pad without it (not upgraded), anything else an RPC error.
 */
export async function agentWindowSupport(ctx) {
  const where = ctx.chainId === '97' || Number(ctx.chainId) === 97 ? 'the BSC testnet' : 'BSC mainnet'
  if (ctx.gen !== PAD3_GEN) return { open: false, why: `GangLaunchpad ${ctx.gen ?? ctx.pad} has no agent window (3.0 only)` }
  let min, max
  try {
    [max, min] = await Promise.all([
      ctx.read(ctx.pad, AGENT_WINDOW_ABI, 'MAX_AGENT_WINDOW_MINUTES'),
      ctx.read(ctx.pad, AGENT_WINDOW_ABI, 'MIN_AGENT_WINDOW_MINUTES'),
    ])
  } catch (e) {
    if (missingRead(e)) return { open: false, why: `GangLaunchpad 3.0 on ${where} has no agent window yet (the pad is not upgraded for it)` }
    return { unread: e.shortMessage || e.message.split('\n')[0] }
  }
  return { open: true, min: Number(min), max: Number(max) }
}

/** The create call (`createWithSalt(…)` with abcd on, else the entry itself) inside createWithAgentWindow. */
export const wrapCreate = (minutes, data) => encodeFunctionData({ abi: AGENT_WINDOW_ABI, functionName: 'createWithAgentWindow', args: [minutes, data] })

/** "1h 5m", "3m 20s", "45s". */
export function formatLeft(sec) {
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`, (!d && !h && r) && `${r}s`].filter(Boolean)
  return parts.length ? parts.join(' ') : '0s'
}

export const WINDOW_RULE = 'until openAt only Agent ID holders trade it on the curve, under the 1% wallet cap; from openAt on anyone does, contracts included, and there is no 1% cap: one buy can take the rest of the curve to graduation. Fixed at the create for good: nobody (not the creator, not gang) can change, extend or cancel it'

/** E-4 (spec §4 / §7.2): what an open token with a graduation reward means for its pool. */
export const GRAD_OPEN_WARNING = 'after this token opens to every wallet, the graduation reward pool may be taken by one large buyer: anyone can push the curve near graduation (contracts too, no 1% cap), then fill the list with buys from one Agent ID and take the graduating buy. Only Agent ID wallets\' buys count for the list'

/** What the create preview says about --agent-window. */
export function windowCreateView(minutes, { gradReward = false, vault = false, promote = false } = {}) {
  const hours = minutes >= 60 ? ` (${formatLeft(minutes * 60)})` : ''
  return {
    minutes,
    openAt: `${minutes} minute${minutes === 1 ? '' : 's'}${hours} after the create block: openAt = the create block's time + ${minutes * 60}s (gang info shows it once the token exists)`,
    untilOpen: 'only Agent ID holders buy and sell it on the curve, each wallet under the 1% wallet cap (as every agent-only token)',
    afterOpen: 'any wallet buys and sells it on the curve, contracts and aggregators included, with NO 1% wallet cap: one buyer can take the rest of the curve up to graduation in one block. "about 80 wallets to graduate" no longer holds',
    stillAgentOnly: 'creating, promoter binding and graduation-reward entries stay Agent ID only',
    ...(gradReward && { gradReward: GRAD_OPEN_WARNING }),
    ...(vault && { vault: 'after it opens, wallets without an Agent ID can buy but can\'t lock in the token\'s vault (locks stay Agent ID only); with no 1% cap an agent can lock more than 1%' }),
    ...(promote && { promote: 'after it opens, wallets without an Agent ID buy without binding a promoter (no share is paid on their trades)' }),
    warning: `IRREVERSIBLE: the window is written once, at this create, and nobody can change, extend or cancel it. After ${minutes} minute${minutes === 1 ? '' : 's'} this curve is open to every wallet for good`,
  }
}

/**
 * The token's window as the pad says: null on a pad without the window; { set: false } for a token with none (agent
 * only for good); else openAt, open, time left and whether the 1% cap applies now. Reads the chain's views, the time
 * left from the latest block. `graduated`: the curve is done, the window no longer matters.
 */
export async function agentWindowOf(ctx, token, { graduated = false, venue = 'PancakeSwap' } = {}) {
  if (ctx.gen !== PAD3_GEN) return null
  let openAt
  try { openAt = Number(await ctx.read(ctx.pad, AGENT_WINDOW_ABI, 'agentOpenAt', [token])) } catch (e) {
    if (missingRead(e)) return null
    return { error: `could not read the token's agent window (${e.shortMessage || e.message.split('\n')[0]})`, retry: 'same command again' }
  }
  if (!openAt) {
    return { set: false, raw: { openAt: 0, open: false, capOn: true }, note: 'no agent window: only Agent ID holders trade this token on the curve, for good' }
  }
  let open, capOn, now
  try {
    [open, capOn, now] = await Promise.all([
      ctx.read(ctx.pad, AGENT_WINDOW_ABI, 'agentWindowOpen', [token]),
      ctx.read(ctx.pad, AGENT_WINDOW_ABI, 'walletCapOn', [token]),
      ctx.client?.getBlock?.().then((b) => Number(b.timestamp)).catch(() => null) ?? null,
    ])
  } catch (e) {
    return { error: `could not read the token's agent window (${e.shortMessage || e.message.split('\n')[0]})`, retry: 'same command again' }
  }
  const nowSec = now ?? Math.floor(Date.now() / 1000)
  const left = Math.max(0, openAt - nowSec)
  return {
    set: true, openAt: new Date(openAt * 1000).toISOString(), openAtUnix: openAt, open,
    ...(!open && { opensIn: formatLeft(left), secondsLeft: left }),
    walletCap: capOn,
    status: graduated ? `graduated: the curve is done; the ${venue} pool is open to everyone anyway`
      : open ? 'open to every wallet (contracts included); no 1% wallet cap'
        : `agent only for ${formatLeft(left)} more: only Agent ID holders trade it now, under the 1% cap; then anyone, with no cap`,
    rule: WINDOW_RULE,
    raw: { openAt, open, capOn },
  }
}

/** The window without its raw reads, as results show it. */
export const shownWindow = (w) => {
  if (!w) return null
  const { raw: _r, ...rest } = w
  return rest
}
