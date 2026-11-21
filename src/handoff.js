/**
 * `gang buy|sell … --handoff`: hand a curve trade to the user's own wallet through gang.fun's token page. The CLI runs
 * the read-only checks and the quote, then prints a prefilled link (and its QR code) to open in a wallet's in-app
 * browser; the user connects, approves and confirms there. Nothing is signed or sent here.
 * `gang handoff status`: watch the chain, read-only, for that wallet's trade on that token since the handoff.
 *
 * Only what the page's wallet box serves (gang-web-legacy walletTradeCore.js checkCurve): a token on the built-in
 * GangLaunchpad 3.0 pad on BSC mainnet, still on its curve, whose agent window has opened. Never an address from the
 * environment: the link points at gang.fun, and the page itself reads the built-in pad.
 *
 * Link format (the page's parsePrefill): /token/<token>?trade=buy&amount=<quote>|trade=sell&amount=all|<tokens>
 * [&from=<wallet>]; amount a plain decimal, at most 13 integer and 18 decimal digits, > 0 and ≤ 1e12.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatUnits, getAddress, isAddress, parseAbi, parseAbiItem, parseUnits, zeroAddress } from 'viem'
import { GANG_GENS, PAD3_GEN } from './gangpad.js'

export const SITE = 'https://gang.fun'
export const PAGE_SLIPPAGE_BPS = 300 // the page's default (walletTradeCore DEFAULT_SLIPPAGE_BPS); the user can change it there
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const GAS_RESERVE = 2_000_000_000_000_000n // 0.002 BNB, as gang buy keeps back

const PAD_ABI = parseAbi([
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function tokenVersionOf(address token) view returns (uint8)',
  'function agentOpenAt(address token) view returns (uint40)',
  'function canTradeCurve(address token, address account) view returns (bool)',
  'function tryBuy(address token, address trader, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
])
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'])
// the pad's trade events (v3.js PAD_ABI): Buy / Sell, and TradeV1 on newer pads
const EVENTS = [
  parseAbiItem('event Buy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 protocolFee, uint256 tax, uint256 tokensOut, uint256 realQuote)'),
  parseAbiItem('event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 protocolFee, uint256 tax, uint256 quoteOut, uint256 realQuote)'),
  parseAbiItem('event TradeV1(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmount, uint256 tokenAmount, uint256 protocolFee, uint256 creatorFee, uint256 postPrice, uint256 realQuote, uint256 sold)'),
]

/** The built-in GangLaunchpad 3.0 pad on mainnet (the one the page's wallet box reads). */
export const handoffPad = () => GANG_GENS.mainnet.find((g) => g.gen === PAD3_GEN).pad

export class HandoffError extends Error {
  constructor(message, code = 'ERROR', extra = {}) { super(message); this.code = code; this.extra = extra }
}

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
const sameQuote = (answered, quote) => same(answered, quote) || (same(quote, WBNB) && same(answered, zeroAddress))

/** A canonical decimal the page's parser takes (no exponent, no leading dot), or throws. */
export function linkAmount(raw, decimals) {
  const s = String(raw ?? '').trim()
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) throw new HandoffError('--amount must be a plain decimal (e.g. 0.05)', 'USAGE', { got: raw ?? null })
  // parseUnits rounds extra decimals: refuse them, so the link is exactly the amount typed
  if ((s.split('.')[1] ?? '').replace(/0+$/, '').length > decimals) throw new HandoffError(`--amount has more than ${decimals} decimals`, 'USAGE', { got: raw })
  const units = parseUnits(s, decimals)
  if (units <= 0n) throw new HandoffError('--amount must be more than 0', 'USAGE', { got: raw })
  const text = formatUnits(units, decimals)
  const [int, frac = ''] = text.split('.')
  if (int.length > 13 || frac.length > 18 || Number(text) > 1e12) throw new HandoffError('--amount is too large for a trade link (at most 1e12)', 'USAGE', { got: raw })
  return { units, text }
}

/** The prefilled page link. */
export function tradeLink({ token, side, amount, from = null }) {
  const q = new URLSearchParams({ trade: side, amount, ...(from && { from: getAddress(from) }) })
  return `${SITE}/token/${getAddress(token)}?${q.toString()}`
}

/** The link as a terminal QR code (light modules as blocks, for a dark terminal), or null when the QR module is missing. */
export async function qrText(text) {
  let qrcode
  try { qrcode = (await import('qrcode-generator')).default } catch { return null }
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount(), pad = 4 // the quiet zone the QR spec asks for
  const light = (r, c) => r < 0 || c < 0 || r >= n || c >= n || !qr.isDark(r, c)
  const rows = []
  for (let r = -pad; r < n + pad; r += 2) {
    let line = ''
    for (let c = -pad; c < n + pad; c++) {
      const top = light(r, c), bottom = light(r + 1, c)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    rows.push(line)
  }
  return rows.join('\n')
}

export const STEPS = {
  binance: '打开币安 App → Web3 钱包 → 发现（DApp 浏览器）→ 粘贴链接 / Binance app → Web3 Wallet → Discover (DApp browser) → paste the link',
  other: 'Or open the link in any wallet app\'s own browser (MetaMask, OKX, Trust, …)',
  scan: 'Scanning the QR code with the Binance app is not confirmed to open the Web3 browser yet: paste the link if it doesn\'t',
  user: 'On the page: connect the wallet, check the prefilled trade, then approve and confirm each step in the wallet. Nothing is sent before that',
}

/**
 * The read-only checks and quote of a handoff. → the result to print. Throws HandoffError for a refusal.
 * read: a viem public client on BSC mainnet.
 */
export async function buildHandoff({ side, token, amount, all = false, from = null, read, now = () => Math.floor(Date.now() / 1000) }) {
  if (!isAddress(token ?? '')) throw new HandoffError('--token must be a 0x address', 'USAGE')
  if (from != null && !isAddress(from)) throw new HandoffError('--from must be a 0x address', 'USAGE', { got: from })
  const pad = handoffPad()
  const r = (address, abi, functionName, args = []) => read.readContract({ address, abi, functionName, args })
  const [curve, version, openAt] = await Promise.all([
    r(pad, PAD_ABI, 'curves', [token]), r(pad, PAD_ABI, 'tokenVersionOf', [token]).catch(() => 0), r(pad, PAD_ABI, 'agentOpenAt', [token]).catch(() => 0),
  ])
  const [creator, quote, , , , , graduated] = curve
  if (same(creator, zeroAddress) || !(Number(version) > 0)) {
    throw new HandoffError('--handoff is for GangLaunchpad 3.0 curve tokens whose agent window is open: this token is not on that pad (an older pad or another track: use the Binance Agentic Wallet, or a DEX once it trades in a pool)', 'HANDOFF_NOT_SERVED', { token })
  }
  if (graduated) throw new HandoffError('this token has graduated: it trades in its PancakeSwap pool now, with any DEX or wallet (gang buy|sell --from <address> --calldata builds it through GangRouter)', 'HANDOFF_NOT_SERVED', { token, why: 'graduated' })
  if (!(Number(openAt) > 0)) throw new HandoffError('this token is agent only (no agent window): only a Binance Agentic Wallet with an Agent ID trades its curve, so leave --handoff out', 'HANDOFF_NOT_SERVED', { token, why: 'no_window' })
  if (Number(openAt) > now()) {
    throw new HandoffError(`this token is agent only until ${new Date(Number(openAt) * 1000).toISOString()}: its page opens to every wallet then; before that only a Binance Agentic Wallet with an Agent ID trades it`, 'HANDOFF_NOT_SERVED', { token, why: 'not_open', openAt: new Date(Number(openAt) * 1000).toISOString() })
  }
  if (from && !(await r(pad, PAD_ABI, 'canTradeCurve', [token, from]))) {
    throw new HandoffError('this wallet can\'t trade this token on the curve (a token\'s own vault never does)', 'HANDOFF_NOT_SERVED', { token, wallet: from })
  }
  const native = same(quote, WBNB)
  const [quoteDec, quoteSym, tokenSym] = await Promise.all([
    r(quote, ERC20, 'decimals').then(Number).catch(() => 18), native ? 'BNB' : r(quote, ERC20, 'symbol').catch(() => null), r(token, ERC20, 'symbol').catch(() => null),
  ])
  const min = (x) => { const m = (x * BigInt(10_000 - PAGE_SLIPPAGE_BPS)) / 10_000n; return m > 0n ? m : 1n }
  const quoteLine = { slippagePct: PAGE_SLIPPAGE_BPS / 100, note: 'an estimate now; the page quotes again when the user opens it, and its slippage (default 3%) can be changed there' }
  let linkAmt, quoted, funds = null
  if (side === 'buy') {
    if (all) throw new HandoffError('--all is for sells: a buy takes --amount <quote to spend>', 'USAGE')
    const a = linkAmount(amount, quoteDec)
    linkAmt = a.text
    const res = await r(pad, PAD_ABI, 'tryBuy', [token, from ?? zeroAddress, 0n, a.units])
    const [, q, tokensOut, spent, fee] = res
    if (!(tokensOut > 0n)) throw new HandoffError('the pad would not fill this buy now (closed to this wallet, or nothing left on the curve)', 'HANDOFF_NOT_SERVED', { token })
    if (!sameQuote(q, quote)) throw new HandoffError('the pad answered with another quote token: nothing is linked', 'ERROR', { token })
    quoted = {
      spend: a.text, spendIn: quoteSym, expectTokens: formatUnits(tokensOut, 18), minTokensOut: formatUnits(min(tokensOut), 18),
      spent: formatUnits(spent, quoteDec), fee: formatUnits(fee, quoteDec), ...(spent < a.units && { refund: formatUnits(a.units - spent, quoteDec), refundNote: 'the buy reaches graduation: the rest is refunded' }),
      ...quoteLine,
    }
    if (from) {
      const have = native ? await read.getBalance({ address: from }) : await r(quote, ERC20, 'balanceOf', [from])
      const need = native ? a.units + GAS_RESERVE : a.units
      funds = { have: formatUnits(have, quoteDec), need: formatUnits(need, quoteDec), in: quoteSym }
      if (have < need) throw new HandoffError(`not enough ${quoteSym ?? 'quote'} in ${from} for this buy${native ? ' (BNB must also cover gas)' : ''}`, 'NO_FUNDS', { token, ...funds })
    }
  } else {
    if (all && amount != null) throw new HandoffError('use either --all or --amount, not both', 'USAGE')
    if (!all && amount == null) throw new HandoffError('pass --amount <tokens> or --all', 'USAGE')
    let units
    if (all) {
      linkAmt = 'all'
      if (from) {
        units = await r(token, ERC20, 'balanceOf', [from])
        if (units === 0n) throw new HandoffError(`${from} holds none of this token`, 'NO_FUNDS', { token })
      }
    } else {
      const a = linkAmount(amount, 18)
      linkAmt = a.text
      units = a.units
      if (from) {
        const have = await r(token, ERC20, 'balanceOf', [from])
        funds = { have: formatUnits(have, 18), need: a.text, in: tokenSym }
        if (have < units) throw new HandoffError(`${from} holds less than that`, 'NO_FUNDS', { token, ...funds })
      }
    }
    if (units != null) {
      let res
      try { res = await r(pad, PAD_ABI, 'trySell', [token, units]) } catch { res = null }
      const [, q, out, fee] = res ?? []
      if (!(out > 0n)) throw new HandoffError('the pad would not take this sell now', 'HANDOFF_NOT_SERVED', { token })
      if (!sameQuote(q, quote)) throw new HandoffError('the pad answered with another quote token: nothing is linked', 'ERROR', { token })
      quoted = { amount: formatUnits(units, 18), expectOut: formatUnits(out, quoteDec), minOut: formatUnits(min(out), quoteDec), receiveIn: quoteSym, fee: formatUnits(fee, quoteDec), ...quoteLine }
    } else {
      quoted = { amount: 'all', note: 'all = the wallet\'s whole balance, read by the page once it is connected (pass --from for a quote here)' }
    }
  }
  const link = tradeLink({ token, side, amount: linkAmt, from })
  const sinceBlock = Number(await read.getBlockNumber())
  let balanceRaw = null
  if (from) {
    const bal = await r(token, ERC20, 'balanceOf', [from]).catch(() => null)
    remember({ token, from, side, sinceBlock, tokenBalance: bal == null ? null : bal.toString(), at: Date.now() })
    balanceRaw = bal == null ? null : bal.toString()
  }
  return {
    success: true, handoff: true, chainId: 56, side, token: getAddress(token), symbol: tokenSym, quote: getAddress(quote), quoteSymbol: quoteSym,
    ...(from && { wallet: getAddress(from) }), link, qr: await qrText(link), quoted, ...(funds && { funds }),
    agentWindow: { openAt: new Date(Number(openAt) * 1000).toISOString(), open: true },
    steps: [STEPS.binance, STEPS.other, STEPS.scan, STEPS.user], sinceBlock, ...(balanceRaw != null && { walletTokenBalanceRaw: balanceRaw }),
    signed: false,
    note: 'nothing was signed or sent: the user trades on the page, from their own wallet. Do not say it happened until gang handoff status shows the trade on chain',
    next: from ? `gang handoff status --token ${getAddress(token)} --from ${getAddress(from)} [--timeout 10m]` : 'gang handoff status --token <token> --from <the user\'s wallet> --since ' + sinceBlock,
  }
}

// ---------------------------------------------------------------- handoff status

const DIR = () => process.env.GANG_HANDOFF_DIR || join(homedir(), '.gang', 'handoffs')
const recPath = (token, from) => join(DIR(), `${String(token).toLowerCase()}-${String(from).toLowerCase()}.json`)
/** Where the last handoff of this token to this wallet started: { sinceBlock, tokenBalance, at }. Best effort. */
function remember(rec) {
  try {
    mkdirSync(DIR(), { recursive: true, mode: 0o700 })
    const p = recPath(rec.token, rec.from)
    writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify(rec), { mode: 0o600 })
    renameSync(`${p}.${process.pid}.tmp`, p)
  } catch { /* the status then needs --since */ }
}
const RECORD_TTL_MS = 24 * 3600_000
const OVERLAP = 10n
const recall = (token, from) => { try { return JSON.parse(readFileSync(recPath(token, from), 'utf8')) } catch { return null } }

// the indexed trader of each event: on 3.0 every entry (the pad, GangRouter) requires trader == tx.origin, so a
// trade naming the wallet was sent by that wallet itself
const TRADER_ARG = { Buy: 'buyer', Sell: 'seller', TradeV1: 'trader' }

/**
 * The wallet's trades of the token on the 3.0 pad from `since` to `latest` (both inclusive), by the events' indexed
 * token and trader. → [{ side, txHash, block, quote / tokens amounts }].
 */
async function tradesSince(read, token, from, since, latest) {
  const pad = handoffPad()
  const found = []
  for (let a = BigInt(since); a <= latest; a += 2000n) {
    const b = a + 1999n > latest ? latest : a + 1999n
    const logs = (await Promise.all(EVENTS.map((event) => read.getLogs({ address: pad, event, args: { token, [TRADER_ARG[event.name]]: from }, fromBlock: a, toBlock: b })))).flat()
    for (const l of logs) {
      if (!same(l.args.token, token) || !same(l.args[TRADER_ARG[l.eventName]], from)) continue
      const isBuy = l.eventName === 'Buy' || (l.eventName === 'TradeV1' && l.args.isBuy)
      found.push({
        side: isBuy ? 'buy' : 'sell', txHash: l.transactionHash, block: Number(l.blockNumber), event: l.eventName,
        quoteAmountRaw: String(l.args.quoteIn ?? l.args.quoteOut ?? l.args.quoteAmount ?? ''), tokenAmountRaw: String(l.args.tokensOut ?? l.args.tokensIn ?? l.args.tokenAmount ?? ''),
      })
    }
  }
  return [...new Map(found.map((t) => [`${t.txHash}:${t.side}`, t])).values()]
}

/**
 * gang handoff status: the wallet's trades of the token since the handoff (its block, or --since), and its balance then
 * and now. timeoutS > 0: wait until a trade shows (polling every 5 s). Read-only.
 */
export async function handoffStatus({ token, from, since = null, balanceAtHandoff = null, timeoutS = 0, read, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 5000, now = () => Date.now() }) {
  if (!isAddress(token ?? '')) throw new HandoffError('--token must be a 0x address', 'USAGE')
  if (!isAddress(from ?? '')) throw new HandoffError('--from <the user\'s wallet> is required: the trade is looked up by its sender', 'USAGE')
  // this machine's record of the last handoff, only while it is fresh: an old one would count old trades
  const saved = since == null ? recall(token, from) : null
  const rec = saved && now() - Number(saved.at) < RECORD_TTL_MS ? saved : null
  const start = since ?? rec?.sinceBlock
  if (start == null) {
    throw new HandoffError(saved ? 'the last handoff of this token to this wallet here is over a day old: pass --since <block> (the sinceBlock its handoff printed)' : 'no handoff of this token to this wallet on this machine: pass --since <block> (the sinceBlock a handoff printed)', 'USAGE')
  }
  const before = balanceAtHandoff != null ? BigInt(balanceAtHandoff) : rec?.tokenBalance != null ? BigInt(rec.tokenBalance) : null
  const until = now() + timeoutS * 1000
  const trades = []
  let next = BigInt(start)
  for (;;) {
    const latest = await read.getBlockNumber()
    // each round scans the new blocks plus the last OVERLAP again (the RPC fallback may answer getLogs from a node a
    // few blocks behind the one that gave latest); trades seen twice count once
    if (latest >= next) {
      for (const t of await tradesSince(read, token, from, next, latest)) if (!trades.some((x) => x.txHash === t.txHash && x.side === t.side)) trades.push(t)
      const back = latest + 1n - OVERLAP
      next = back > BigInt(start) ? back : BigInt(start)
    }
    const bal = await read.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [from] }).catch(() => null)
    const changed = bal != null && before != null && bal !== before
    if (trades.length || changed || now() >= until) {
      return {
        success: true, token: getAddress(token), wallet: getAddress(from), sinceBlock: Number(start), latestBlock: Number(latest),
        traded: trades.length > 0, trades: [...trades],
        ...(bal != null && { tokenBalanceNow: formatUnits(bal, 18) }), ...(before != null && { tokenBalanceAtHandoff: formatUnits(before, 18), balanceChanged: changed }),
        ...(!trades.length && changed && { note: 'the balance changed, but no pad trade by this wallet was found in the logs (a transfer, or the RPC missed the log): check the wallet\'s activity' }),
        ...(!trades.length && !changed && { note: timeoutS > 0 ? `no trade by this wallet within ${timeoutS} s` : 'no trade by this wallet yet', next: 'run it again later, or with --timeout 10m to wait' }),
        ...(trades.length && { next: `gang tx --hash ${trades.at(-1).txHash} for its details (and its events)` }),
      }
    }
    await sleep(pollMs)
  }
}
