import { readFileSync } from 'node:fs'
import { createPublicClient, parseAbi, parseAbiItem, encodeFunctionData, decodeEventLog, formatUnits, parseUnits, isAddress, getAddress, keccak256, concat } from 'viem'
import { decimalsOf, fundingStep as fund, parseAmount, revertOf as revertIn, step, units, GAS_RESERVE } from './steps.js'
import { gangGens, MERGED_ERRORS_ABI, MERGED_HINTS, PAD3_GEN, padNets, rpcTransport } from './gangpad.js'
import { bawAddress } from './baw.js'
import { get as apiGet } from './discover.js'
import { readNoteCommit } from './notes.js'

/**
 * `gang call-bond …` — GangCallBond (喊单保证金, gang-launchpad src/gang/GangCallBond.sol, spec
 * docs/SPEC-AGENT-CALLS-2026-11-09.md §5): an agent bonds its own call (a buy note) on a 3.0 curve token. It posts the
 * token's quote and promises its balance of the token stays at least `hold` until `settle` (48 h – 7 days on).
 * Kept: anyone settles after the deadline (two steps, 1 hour apart) and the whole bond comes back. Broken (the balance
 * below hold before settle, the deadline passed or not): anyone reports it; the reporter gets 1%, half burns at once and
 * the rest pays the note's followers by their loss (a Merkle root the settler posts, 2 days for the Safe to veto, then
 * claims). Nothing of a broken bond ever comes back to the caller.
 * One contract per network, bound to GangLaunchpad 3.0. Env: GANG_CALL_BOND (mainnet), GANG_TESTNET_CALL_BOND (testnet).
 */

export const CALL_BOND_ABI = parseAbi([
  'function post(address token, bytes32 noteTx, uint256 amount, uint256 hold, uint64 duration) payable returns (uint256 id)',
  'function report(uint256 id)',
  'function requestSettle(uint256 id)',
  'function settle(uint256 id)',
  'function claim(uint256 id, address account, uint256 amount, bytes32[] proof)',
  'function burnRemainder(uint256 id)',
  'function burnUnpaid(uint256 id)',
  'function bondOf(uint256 id) view returns ((address caller, uint64 postedAt, uint8 state, address token, uint64 deadline, address quote, uint64 settleAt, uint128 amount, uint128 hold, uint64 reportedAt, uint64 reportedBlock, uint64 rootAt, uint64 vetoAt, uint128 pool, uint128 spent, uint128 total, bool remainderBurned, bytes32 noteTx, bytes32 root))',
  'function activeBondOf(address caller, address token) view returns (uint256)',
  'function claimed(uint256 id, address account) view returns (bool)',
  'function leaf(uint256 id, address account, uint256 amount) view returns (bytes32)',
  'function pad() view returns (address)',
  'function wbnb() view returns (address)',
  'function quote1() view returns (address)',
  'function quote2() view returns (address)',
  'function quote3() view returns (address)',
  'event CallBondPosted(uint256 indexed id, address indexed caller, address indexed token, bytes32 noteTx, address quote, uint256 amount, uint256 hold, uint64 deadline)',
  'event CallBondReported(uint256 indexed id, address indexed reporter, uint256 reportedBlock, uint256 balance, uint256 reward, uint256 burned, uint256 pool)',
  'event SettleRequested(uint256 indexed id, uint64 settleAt)',
  'event CallBondSettled(uint256 indexed id, address indexed caller, uint256 amount)',
  'event RootPosted(uint256 indexed id, bytes32 root, uint256 total, uint64 claimableAt)',
  'event RootVetoed(uint256 indexed id, bytes32 root)',
  'event Claimed(uint256 indexed id, address indexed account, uint256 amount)',
  'event RemainderBurned(uint256 indexed id, uint256 amount)',
  'event UnpaidBurned(uint256 indexed id, uint256 amount)',
  'error NotCurveToken()', 'error BadTokenVersion()', 'error AlreadyGraduated()', 'error QuoteNotAllowed()',
  'error BadDuration()', 'error BadHold()', 'error BadNote()', 'error BondLive()', 'error BadValue()', 'error ZeroAmount()',
  'error FeeOnTransferQuote()', 'error NotActive()', 'error NotViolated()', 'error Violated()', 'error FlashSwapActive()',
  'error NotDue()', 'error AlreadyRequested()', 'error NoSettleRequest()', 'error NotReported()', 'error NotClaimable()',
  'error AlreadyClaimed()', 'error BadProof()', 'error OverTotal()', 'error NotFollower()', 'error AlreadyBurned()',
  'error StillPayable()',
])

const PAD_ABI = parseAbi([
  'function kindOf(address token) view returns (uint8)',
  'function tokenVersionOf(address token) view returns (uint8)',
  'function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
])
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
])
const TRADE_V1 = parseAbiItem('event TradeV1(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmount, uint256 tokenAmount, uint256 protocolFee, uint256 creatorFee, uint256 postPrice, uint256 realQuote, uint256 sold)')

export const STATES = ['none', 'active', 'settled', 'reported', 'closed']
const HOUR = 3_600
export const MIN_DURATION = 48 * HOUR
export const MAX_DURATION = 7 * 24 * HOUR
const SETTLE_DELAY = HOUR
const ROOT_DELAY = HOUR + 600
const DISPUTE = 2 * 24 * HOUR
const CLAIM_WINDOW = 90 * 24 * HOUR
// the site shows a bond as 有担保 only when it is posted within this long of its note (spec §5.4)
export const LABEL_WINDOW = 600
const FOLLOW_WINDOW = 24 * HOUR
const NOTE_LOOKBACK_BLOCKS = 3_000n // ~20 min at 0.45 s blocks: the default note is the wallet's latest buy within it
const BPS = 10_000n
const REPORTER_BPS = 100n
const BURN_BPS = 5_000n

const HINTS = {
  NotCurveToken: 'only GangLaunchpad 3.0 curve tokens take a call bond (not 打新, 铸币飞轮 or older pads)',
  BadTokenVersion: 'this token was created under a rule set the call bond does not cover',
  AlreadyGraduated: 'the token has graduated: calls (and follows) are curve-only, so it takes no new call bond',
  QuoteNotAllowed: 'the token\'s quote is not WBNB, USDT, USDC or USD1: no call bond on it',
  BadDuration: '--for must be 48h to 7d',
  BadHold: 'hold must be more than 0 and at most what the wallet holds now',
  BadNote: 'the note tx is missing',
  BondLive: 'this wallet already has a running call bond on this token: settle it (or let it be reported) first',
  BadValue: 'BNB sent with the bond must equal its amount, on a WBNB-quoted token only',
  NotActive: 'this call bond is not running (settled, reported or unknown)',
  NotViolated: 'the caller still holds at least what it promised: nothing to report',
  Violated: 'the caller holds less than it promised: it can only be reported now',
  FlashSwapActive: 'the pair is mid flash swap: try again in the next block',
  NotDue: 'too early: see deadline / settleAt',
  AlreadyRequested: 'settle was already asked for: run settle once settleAt has passed',
  NotClaimable: 'nothing to claim yet: no root, its 2-day dispute window is still running, or the claim window is over',
  AlreadyClaimed: 'this account already claimed its payout',
  BadProof: 'the proof does not match the posted root',
  OverTotal: 'the root\'s leaves add up to more than its total: this leaf can\'t be paid',
  NotFollower: 'the caller can never claim from its own broken bond',
  NotReported: 'this call bond is not reported (or already closed)',
  AlreadyBurned: 'the remainder was burnt already',
  StillPayable: 'not yet: the followers can still be paid (a root may still come, or its claim window is open)',
}
const revertOf = (e) => revertIn(e, [CALL_BOND_ABI, MERGED_ERRORS_ABI], { ...MERGED_HINTS, ...HINTS })

const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const iso = (s) => (Number(s) ? new Date(Number(s) * 1000).toISOString() : null)
const tokens = (x) => formatUnits(x, 18)

/** GangCallBond of `testnet` / mainnet (env first), bound to the network's 3.0 pad; null when not deployed there. */
export function callBondAddress(testnet) {
  return gangGens(testnet).find((g) => g.gen === PAD3_GEN)?.callBond || null
}

function callBondCtx(testnet) {
  const net = padNets('v3')[testnet ? 'testnet' : 'mainnet']
  const g3 = net.gens.find((g) => g.gen === PAD3_GEN)
  const addr = callBondAddress(testnet)
  if (!g3 || !addr) throw new Error(`GangCallBond is not deployed on ${testnet ? 'the BSC testnet' : 'BSC mainnet'} in this CLI version${testnet ? '' : ' (testnet: add --testnet)'}: set ${testnet ? 'GANG_TESTNET_CALL_BOND' : 'GANG_CALL_BOND'} to its address`)
  const client = createPublicClient({ chain: net.chain, transport: rpcTransport(net.rpcs) })
  return { ...net, pad: g3.pad, callBond: addr, client, read: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args }) }
}

const walletFor = (ctx, from) => {
  if (from) return from
  try { return bawAddress(ctx.chainId) } catch { return bawAddress('56') }
}

async function simulate(ctx, from, functionName, args, value = 0n) {
  try {
    const { result } = await ctx.client.simulateContract({ account: from, address: ctx.callBond, abi: CALL_BOND_ABI, functionName, args, value })
    return { result }
  } catch (e) {
    const r = revertOf(e)
    return { failed: r ? { reverted: true, ...r } : { reverted: false, error: e.shortMessage || e.message.split('\n')[0] } }
  }
}

/** --for: 48h–7d, as `72h`, `3d` (a bare number is refused: hours or days must be said). → seconds */
export function parseFor(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+(?:\.\d+)?)([hd])$/i)
  if (!m) throw new Error(`--for must look like 48h or 3d (48 hours to 7 days; got ${raw ?? 'nothing'})`)
  const s = Math.round(Number(m[1]) * (m[2].toLowerCase() === 'h' ? HOUR : 24 * HOUR))
  if (s < MIN_DURATION || s > MAX_DURATION) throw new Error(`--for must be 48h to 7d (got ${raw})`)
  return s
}

/** --hold: `all` (default), N% of the balance, or a token amount. → { hold, all } */
export function parseHold(raw, balance) {
  const v = String(raw ?? 'all').trim().toLowerCase()
  if (v === 'all') return { hold: balance, all: true }
  const pct = v.match(/^(\d+(?:\.\d+)?)%$/)
  if (pct) {
    const bps = BigInt(Math.round(Number(pct[1]) * 100))
    if (bps <= 0n || bps > BPS) throw new Error('--hold N% must be above 0% and at most 100%')
    const hold = (balance * bps) / BPS
    return { hold, all: hold === balance }
  }
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`--hold must be all, N% or a token amount (got ${raw})`)
  const hold = parseUnits(v, 18)
  return { hold, all: hold === balance }
}

/** The forfeit split of `amount` (spec §5.2): reporter 1% (burnt when the caller reports itself), half burnt, the rest the pool. */
export function forfeitSplit(amount, selfReport = false) {
  let reward = (amount * REPORTER_BPS) / BPS
  let burned = (amount * BURN_BPS) / BPS
  if (selfReport) { burned += reward; reward = 0n }
  return { reward, burned, pool: amount - reward - burned }
}

/** OpenZeppelin MerkleProof (sorted pairs) over `leaf`. */
export function rootFromProof(leaf, proof) {
  let h = leaf
  for (const p of proof) h = BigInt(h) < BigInt(p) ? keccak256(concat([h, p])) : keccak256(concat([p, h]))
  return h
}

/** The leaf the contract checks: StandardMerkleTree's double hash of (contract, chainId, id, account, amount). */
export function leafOf(contract, chainId, id, account, amount) {
  const enc = (v, t) => (t === 'address' ? v.toLowerCase().slice(2).padStart(64, '0') : BigInt(v).toString(16).padStart(64, '0'))
  const inner = keccak256(`0x${enc(contract, 'address')}${enc(chainId)}${enc(id)}${enc(account, 'address')}${enc(amount)}`)
  return keccak256(inner)
}

/**
 * Whether gang.fun will show this bond as 有担保 (spec §5.4), as far as the CLI can tell before it lands:
 * the whole balance held, posted within 10 minutes of its note (no sell since), deadline ≥ the note + 48 h.
 */
export function labelCheck({ holdAll, noteTime, now, duration, soldSince }) {
  const why = []
  if (!holdAll) why.push('hold is not the whole balance')
  if (noteTime == null) why.push('the note\'s time is unknown')
  else {
    if (now - noteTime > LABEL_WINDOW) why.push('more than 10 minutes after the note')
    if (now + duration < noteTime + 2 * FOLLOW_WINDOW) why.push('the deadline is earlier than the note + 48 h')
  }
  if (soldSince) why.push('the wallet sold this token after the note')
  return why.length ? { bonded: false, why } : { bonded: true }
}

/** The wallet's latest curve buy of `token` on the pad in the last ~20 minutes, and whether it sold since. null when none found. */
async function latestBuy(ctx, token, me) {
  const to = await ctx.client.getBlockNumber()
  const from = to > NOTE_LOOKBACK_BLOCKS ? to - NOTE_LOOKBACK_BLOCKS : 0n
  const logs = await ctx.client.getLogs({ address: ctx.pad, event: TRADE_V1, args: { token, trader: me }, fromBlock: from, toBlock: to })
  const buys = logs.filter((l) => l.args.isBuy)
  if (!buys.length) return null
  const last = buys[buys.length - 1]
  const soldSince = logs.some((l) => !l.args.isBuy && (l.blockNumber > last.blockNumber || (l.blockNumber === last.blockNumber && l.logIndex > last.logIndex)))
  return { tx: last.transactionHash, block: last.blockNumber, soldSince }
}

async function bondView(ctx, id) {
  const b = await ctx.read(ctx.callBond, CALL_BOND_ABI, 'bondOf', [id])
  const state = STATES[Number(b.state)] ?? `unknown(${b.state})`
  if (state === 'none') return { state, raw: b }
  const [dec, sym, bal, block] = await Promise.all([
    decimalsOf(ctx, b.quote), ctx.read(b.quote, ERC20_ABI, 'symbol').catch(() => null),
    ctx.read(b.token, ERC20_ABI, 'balanceOf', [b.caller]), ctx.client.getBlock(),
  ])
  const q = (x) => formatUnits(x, dec)
  const now = Number(block.timestamp)
  const view = {
    id: Number(id), state, caller: b.caller, token: b.token, noteTx: b.noteTx, quote: b.quote, quoteSymbol: sym,
    amount: q(b.amount), hold: tokens(b.hold), callerBalance: tokens(bal), postedAt: iso(b.postedAt), deadline: iso(b.deadline),
  }
  if (state === 'active') {
    const violated = bal < b.hold
    Object.assign(view, {
      violated, headroom: violated ? '0' : tokens(bal - b.hold),
      ...(b.settleAt !== 0n && { settleAt: iso(b.settleAt) }),
      phase: violated ? 'broken: anyone can report it' : now < Number(b.deadline) ? 'running' : b.settleAt === 0n ? 'past the deadline: settle (step 1 of 2)' : now < Number(b.settleAt) ? 'settle asked for: waiting 1 hour' : 'settle can run now',
    })
  }
  if (state === 'reported' || state === 'closed') {
    const claimableAt = b.rootAt ? Number(b.rootAt) + DISPUTE : null
    Object.assign(view, {
      reportedAt: iso(b.reportedAt), reportedBlock: Number(b.reportedBlock), pool: q(b.pool), paidOrBurnt: q(b.spent),
      root: b.root === `0x${'0'.repeat(64)}` ? null : { root: b.root, total: q(b.total), postedAt: iso(b.rootAt), claimableAt: iso(claimableAt), claimsUntil: claimableAt && iso(claimableAt + CLAIM_WINDOW), remainderBurnt: b.remainderBurned },
      ...(b.vetoAt !== 0n && { lastVetoAt: iso(b.vetoAt) }),
      ...(state === 'reported' && b.rootAt === 0n && { rootsFrom: iso(Number(b.reportedAt) + ROOT_DELAY) }),
    })
  }
  return { ...view, raw: b, dec, now, bal }
}
const pub = ({ raw, dec, now, bal, ...v }) => v

/** A payout of a reported bond for `account`: from --from-file (the reference script's JSON), else gang.fun. */
async function proofFor(ctx, id, account, file) {
  if (file) {
    let j
    try { j = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Error(`--from-file: cannot read ${file}: ${e.message}`) }
    if (Number(j.id) !== Number(id) || !same(j.contract, ctx.callBond)) throw new Error(`--from-file is for bond ${j.id} on ${j.contract}, not ${id} on ${ctx.callBond}`)
    const l = (j.leaves || []).find((x) => same(x.account, account))
    return l ? { amount: BigInt(l.amount), proof: l.proof } : null
  }
  const r = await apiGet(`/callbond/${id}/proof/${account.toLowerCase()}`, undefined, '')
  return r ? { amount: BigInt(r.amount), proof: r.proof } : null
}

const SUBS = ['post', 'status', 'report', 'settle', 'claim', 'burn', 'tx']
const USAGE = 'usage: gang call-bond <post|status|report|settle|claim|burn|tx> [--token <addr> | --id <n>] [--testnet] — see gang help'
const NOTE_FLAGS = ['conf', 'reveal-after', 'follow']

/** Entry for `gang call-bond <sub>`. io: { opt, flag, out, fail, summarize } from index.js. */
export async function runCallBond(sub, { opt, flag, out, fail, summarize }) {
  if (!SUBS.includes(sub)) return fail(USAGE, { got: sub ?? null })
  const noteFlag = NOTE_FLAGS.find((f) => flag(f))
  if (noteFlag) return fail(`--${noteFlag}: gang call-bond takes no notes (the call is the buy note it bonds: --note <that tx>)`)
  const testnet = flag('testnet')
  const net = testnet ? ' --testnet' : ''
  const rawOnly = flag('calldata')
  let ctx
  try { ctx = callBondCtx(testnet) } catch (e) { return fail(e.message) }
  const chainId = Number(ctx.chainId)
  let wallet = null
  const me = () => (wallet ??= walletFor(ctx, opt('from')))
  const send = (functionName, args, extra, value = 0n) =>
    step(ctx, { from: me(), to: ctx.callBond, data: encodeFunctionData({ abi: CALL_BOND_ABI, functionName, args }), value }, { chainId, callBondContract: ctx.callBond, ...extra }, rawOnly, summarize)
  const idArg = () => {
    const v = opt('id')
    if (v != null) {
      if (!/^\d+$/.test(v) || v === '0') fail('--id must be a call bond id (1, 2, …)', { got: v })
      return BigInt(v)
    }
    return null
  }

  if (sub === 'tx') {
    const hash = opt('hash')
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) fail('--hash must be a tx hash')
    const r = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    const events = []
    for (const log of r.logs) {
      if (!same(log.address, ctx.callBond)) continue
      try {
        const ev = decodeEventLog({ abi: CALL_BOND_ABI, data: log.data, topics: log.topics })
        events.push({ event: ev.eventName, ...Object.fromEntries(Object.entries(ev.args).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) })
      } catch { /* not a call bond event */ }
    }
    return out({ success: true, chainId, hash, status: r.status, block: Number(r.blockNumber), events, explorer: `${ctx.explorer}/tx/${hash}` })
  }

  if (sub === 'post') {
    if (opt('id')) fail('gang call-bond post takes --token, not --id')
    const tokenRaw = opt('token')
    if (!isAddress(tokenRaw ?? '')) fail('--token <3.0 curve token> required')
    const token = getAddress(tokenRaw)
    let duration
    try { duration = parseFor(opt('for')) } catch (e) { fail(e.message) }
    if (!flag('amount')) fail('--amount <bond, in the token\'s quote> required')
    const [kind, version, curve] = await Promise.all([
      ctx.read(ctx.pad, PAD_ABI, 'kindOf', [token]), ctx.read(ctx.pad, PAD_ABI, 'tokenVersionOf', [token]).catch(() => 0),
      ctx.read(ctx.pad, PAD_ABI, 'curves', [token]),
    ])
    if (Number(kind) !== 1) fail(HINTS.NotCurveToken, { token, pad: ctx.pad })
    if (Number(version) !== 1) fail(HINTS.BadTokenVersion, { token })
    const [, quote, , , , , graduated] = curve
    if (graduated) fail(HINTS.AlreadyGraduated, { token })
    const allowed = await Promise.all(['wbnb', 'quote1', 'quote2', 'quote3'].map((f) => ctx.read(ctx.callBond, CALL_BOND_ABI, f)))
    if (!allowed.some((a) => same(a, quote))) fail(HINTS.QuoteNotAllowed, { token, quote })
    const wallet_ = me()
    const live = await ctx.read(ctx.callBond, CALL_BOND_ABI, 'activeBondOf', [wallet_, token])
    if (live !== 0n) fail(HINTS.BondLive, { id: Number(live), next: `gang call-bond status --id ${live}${net}` })
    const [dec, sym, bal, block] = await Promise.all([
      decimalsOf(ctx, quote), ctx.read(quote, ERC20_ABI, 'symbol').catch(() => 'quote'),
      ctx.read(token, ERC20_ABI, 'balanceOf', [wallet_]), ctx.client.getBlock(),
    ])
    if (bal === 0n) fail('this wallet holds none of the token: buy first (the call is that buy\'s note)', { token, wallet: wallet_ })
    let h
    try { h = parseHold(opt('hold'), bal) } catch (e) { fail(e.message) }
    if (h.hold === 0n || h.hold > bal) fail(HINTS.BadHold, { hold: tokens(h.hold), balance: tokens(bal) })
    const amount = parseUnits(parseAmount(fail, 'amount', opt('amount')), dec)
    if (amount === 0n) fail('--amount must be more than 0')
    // the call: --note <tx>, else the wallet's latest curve buy of this token in the last ~20 minutes
    let noteTx = opt('note')
    let noteTime = null
    let soldSince = false
    if (noteTx != null) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(noteTx)) fail('--note must be the tx hash of your buy note (0x + 64 hex)', { got: noteTx })
      // the call must be this wallet's own curve buy of this token: followers of anything else could never be paid
      let rc
      try { rc = await ctx.client.getTransactionReceipt({ hash: noteTx }) } catch (e) {
        fail('could not read --note on chain (unknown tx or RPC error): a call bond must name your own buy of this token', { noteTx, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' })
      }
      if (!same(rc.from, wallet_)) fail('--note is not this wallet\'s own tx: a call bond backs your own call', { noteFrom: rc.from, wallet: wallet_ })
      const bought = rc.status === 'success' && rc.logs.some((l) => {
        if (!same(l.address, ctx.pad)) return false
        try {
          const ev = decodeEventLog({ abi: [TRADE_V1], data: l.data, topics: l.topics })
          return ev.args.isBuy && same(ev.args.token, token) && same(ev.args.trader, wallet_)
        } catch { return false }
      })
      if (!bought) fail('--note is not a curve buy of this token by this wallet', { noteTx, token })
      noteTime = Number((await ctx.client.getBlock({ blockNumber: rc.blockNumber })).timestamp)
      try {
        const logs = await ctx.client.getLogs({ address: ctx.pad, event: TRADE_V1, args: { token, trader: wallet_ }, fromBlock: rc.blockNumber, toBlock: 'latest' })
        soldSince = logs.some((l) => !l.args.isBuy)
      } catch { /* unread: the server decides from its own index */ }
    } else {
      let found
      try { found = await latestBuy(ctx, token, wallet_) } catch (e) {
        fail('could not look up your latest buy of this token (RPC getLogs): pass --note <your buy tx>', { detail: e.shortMessage || e.message.split('\n')[0] })
      }
      if (!found) fail('no buy of this token by this wallet in the last ~20 minutes: pass --note <your buy note tx>', { token, wallet: wallet_ })
      noteTx = found.tx
      soldSince = found.soldSince
      noteTime = Number((await ctx.client.getBlock({ blockNumber: found.block })).timestamp)
    }
    // a call is a buy that carries a note: a plain buy can't be found to follow, and its bond's pool could only burn
    let input
    try { input = (await ctx.client.getTransaction({ hash: noteTx })).input } catch (e) {
      fail('could not read the note tx (RPC error)', { noteTx, detail: e.shortMessage || e.message.split('\n')[0], retry: 'same command again' })
    }
    if (!readNoteCommit(input)) fail('this buy carries no note (--note on the buy): nobody can follow it, so there is no call to bond', { noteTx, hint: 'buy with --note "<why>" first, then bond that buy within 10 minutes' })
    const now = Number(block.timestamp)
    const label = labelCheck({ holdAll: h.all, noteTime, now, duration, soldSince })
    // pay: native BNB on a WBNB-quoted token (unless --use-wbnb), else approve the quote first
    let value = 0n
    if (same(quote, ctx.wbnb) && !flag('use-wbnb')) {
      const native = await ctx.client.getBalance({ address: wallet_ })
      if (native < amount + GAS_RESERVE) fail('not enough BNB for this bond (native BNB must also cover gas)', { haveBnb: formatUnits(native, 18), needBnb: formatUnits(amount, 18), hint: 'add --use-wbnb to pay from WBNB instead' })
      value = amount
    } else {
      const pre = await fund(ctx, { me: wallet_, token: quote, need: amount, spender: ctx.callBond, sym, approveStep: 'approve-quote' }, rawOnly, summarize)
      if (pre) return out(pre)
    }
    const args = [token, noteTx, amount, h.hold, BigInt(duration)]
    const sim = await simulate(ctx, wallet_, 'post', args, value)
    if (sim.failed) return out({ success: false, step: 'post', ...sim.failed })
    const split = forfeitSplit(amount)
    const q = (x) => formatUnits(x, dec)
    return out(send('post', args, {
      step: 'post', token, noteTx, bond: q(amount), quote: sym, hold: tokens(h.hold), balance: tokens(bal), holdsAll: h.all,
      deadline: iso(now + duration), id: Number(sim.result), ...(noteTime != null && { postBefore: iso(noteTime + LABEL_WINDOW) }),
      ifBroken: { reporter: q(split.reward), burnt: q(split.burned), followers: q(split.pool), callerGetsBack: '0' },
      site: label.bonded
        ? { bonded: true, note: `gang.fun shows this call as bonded (有担保) if it lands by postBefore (10 minutes after the note), and if it is the note's first such bond` }
        : { bonded: false, why: label.why, note: 'the bond still binds, but gang.fun will not show this call as bonded' },
      note: `until settle, never let this wallet's balance of the token drop below hold: one sell, vault lock or transfer below it and anyone can report the bond — half burns, ${q(split.pool)} ${sym} goes to the note's followers, nothing comes back. From the deadline, settle (gang call-bond settle --token ${token}${net}, two steps 1 hour apart) before selling`,
    }, value))
  }

  // the other subcommands name one bond: --id, or --token for this wallet's running one
  let id = idArg()
  if (id == null) {
    const tokenRaw = opt('token')
    if (!isAddress(tokenRaw ?? '')) fail('--id <n> (or --token <addr> for your running bond) required')
    id = await ctx.read(ctx.callBond, CALL_BOND_ABI, 'activeBondOf', [me(), getAddress(tokenRaw)])
    if (id === 0n) fail('this wallet has no running call bond on that token; pass --id for a settled or reported one', { token: tokenRaw, wallet: me() })
  }
  const v = await bondView(ctx, id)
  if (v.state === 'none') fail('no call bond with this id', { id: Number(id) })
  const b = v.raw
  const q = (x) => formatUnits(x, v.dec)

  if (sub === 'status') {
    let mine = null
    if (v.state === 'reported' && v.root) {
      try {
        const acct = opt('account') || me()
        let p = await proofFor(ctx, id, acct, opt('from-file'))
        // a payout list that doesn't prove against the posted root is out of date: say so instead of showing it
        if (p && rootFromProof(leafOf(ctx.callBond, chainId, id, acct, p.amount), p.proof) !== b.root) p = { stale: true }
        const done = await ctx.read(ctx.callBond, CALL_BOND_ABI, 'claimed', [id, acct])
        mine = p?.stale
          ? { account: acct, payout: null, claimed: done, note: 'the payout list does not match the posted root (out of date): try again later' }
          : p
          ? { account: acct, payout: q(p.amount), claimed: done, ...(!done && { next: `gang call-bond claim --id ${id}${net}` }) }
          : { account: acct, payout: testnet && !opt('from-file') ? null : '0', claimed: done, ...(testnet && !opt('from-file') && { note: 'gang.fun does not index testnet: pass --from-file <the settle script\'s JSON> to see this account\'s payout' }) }
      } catch (e) { mine = { payout: null, note: `could not read the payout (${e.shortMessage || e.message.split('\n')[0]})` } }
    }
    const claimOpen = v.state === 'reported' && b.rootAt !== 0n && v.now >= Number(b.rootAt) + DISPUTE
    const next = v.state === 'active'
      ? (v.violated ? `gang call-bond report --id ${id}${net}` : v.now >= Number(b.deadline) ? `gang call-bond settle --id ${id}${net}` : null)
      : claimOpen ? `gang call-bond claim --id ${id}${net}${!b.remainderBurned && b.pool > b.total ? ` | gang call-bond burn --id ${id}${net}` : ''}` : null
    return out({ success: true, chainId, callBondContract: ctx.callBond, ...pub(v), ...(mine && { yourPayout: mine }), ...(next && { next }) })
  }

  if (sub === 'report') {
    if (v.state !== 'active') return fail(HINTS.NotActive, pub(v))
    if (!v.violated) return fail(HINTS.NotViolated, { callerBalance: v.callerBalance, hold: v.hold })
    const sim = await simulate(ctx, me(), 'report', [id])
    if (sim.failed) return out({ success: false, step: 'report', ...sim.failed })
    const self = same(me(), b.caller)
    const s = forfeitSplit(b.amount, self)
    return out(send('report', [id], {
      step: 'report', id: Number(id), caller: b.caller, callerBalance: v.callerBalance, hold: v.hold, bond: v.amount, quote: v.quoteSymbol,
      reward: q(s.reward), burnt: q(s.burned), followersPool: q(s.pool),
      note: self ? 'the caller reporting itself gets no reward: that 1% burns too' : 'you get 1% of the bond; half burns now and the rest pays the note\'s followers by their loss once the settler posts a root (2 days for a veto, then claims)',
    }))
  }

  if (sub === 'settle') {
    if (v.state !== 'active') return fail(HINTS.NotActive, pub(v))
    if (v.violated) return fail(HINTS.Violated, { callerBalance: v.callerBalance, hold: v.hold, next: `gang call-bond report --id ${id}${net}` })
    if (v.now < Number(b.deadline)) return fail('too early: the bond runs until its deadline', { deadline: v.deadline })
    const fn = b.settleAt === 0n ? 'requestSettle' : 'settle'
    if (fn === 'settle' && v.now < Number(b.settleAt)) return fail('settle was asked for: it can run 1 hour after that', { settleAt: v.settleAt, secondsLeft: Number(b.settleAt) - v.now })
    const sim = await simulate(ctx, me(), fn, [id])
    if (sim.failed) return out({ success: false, step: fn, ...sim.failed })
    return out(send(fn, [id], {
      step: fn === 'requestSettle' ? 'request-settle' : 'settle', id: Number(id), caller: b.caller, refund: v.amount, quote: v.quoteSymbol,
      note: fn === 'requestSettle'
        ? `step 1 of 2 (anyone may send it): settle can run 1 hour after this lands, if the caller still holds ${v.hold}; until then the bond can still be reported. Re-run this command then`
        : 'the whole bond goes back to the caller (whoever sends this)',
    }))
  }

  if (sub === 'claim') {
    if (v.state !== 'reported') return fail('only a reported call bond pays followers', pub(v))
    if (!v.root) return fail('no root posted yet: the settler posts one after the report (the payouts by loss)', { rootsFrom: v.rootsFrom })
    if (v.now < Number(b.rootAt) + DISPUTE) return fail('the root is in its 2-day dispute window: claims open after it', { claimableAt: v.root.claimableAt })
    const acct = getAddress(opt('account') || me())
    if (same(acct, b.caller)) return fail(HINTS.NotFollower, { caller: b.caller })
    if (await ctx.read(ctx.callBond, CALL_BOND_ABI, 'claimed', [id, acct])) return fail(HINTS.AlreadyClaimed, { account: acct })
    let p
    try { p = await proofFor(ctx, id, acct, opt('from-file')) } catch (e) { return fail(e.message) }
    if (!p) return fail('this account has no payout in the posted root', { account: acct, id: Number(id), ...(testnet && { hint: 'gang.fun does not index testnet: pass --from-file <the settle script\'s JSON>' }) })
    const leaf = leafOf(ctx.callBond, chainId, id, acct, p.amount)
    if (rootFromProof(leaf, p.proof) !== b.root) return fail('the proof does not match the posted root (the payout list is out of date or wrong)', { account: acct, root: b.root })
    const sim = await simulate(ctx, me(), 'claim', [id, acct, p.amount, p.proof])
    if (sim.failed) return out({ success: false, step: 'claim', ...sim.failed })
    return out(send('claim', [id, acct, p.amount, p.proof], {
      step: 'claim', id: Number(id), account: acct, payout: q(p.amount), quote: v.quoteSymbol,
      note: same(acct, me()) ? 'your payout as a follower of the broken call' : 'anyone may send a claim; the payout goes to the account, not to the sender',
    }))
  }

  if (sub === 'burn') {
    // the leftovers of a reported bond: the part a live root doesn't pay out, or all that's left once nothing more can be paid
    if (v.state !== 'reported') return fail('only a reported call bond has leftovers to burn', pub(v))
    const fn = v.root && v.now >= Number(b.rootAt) + DISPUTE && !b.remainderBurned && b.pool > b.total ? 'burnRemainder' : 'burnUnpaid'
    const sim = await simulate(ctx, me(), fn, [id])
    if (sim.failed) return out({ success: false, step: fn, ...sim.failed })
    return out(send(fn, [id], { step: fn === 'burnRemainder' ? 'burn-remainder' : 'burn-unpaid', id: Number(id), note: 'anyone may send it: the quote goes to 0xdead' }))
  }
}

/**
 * Before a sell (curve or pool) of `token` by `me`: is it this wallet's running call bond, and does the sell leave less
 * than its hold? → null (no bond / fine, nothing to add) | { info } | { refuse }. ctx is a 3.0 v3 ctx (pad, client, read).
 * --break-call-bond (its own flag: --break-bond is GangBond's) lets the sell through with the warning. Never lets an
 * unread bond pass.
 */
export async function callBondGuard(ctx, { token, me, amount, testnet, breakBond }) {
  const addr = callBondAddress(testnet)
  const pad3 = gangGens(testnet).find((g) => g.gen === PAD3_GEN)?.pad
  if (!addr || !same(ctx.pad, pad3)) return null
  let id, b, bal
  try {
    id = await ctx.read(addr, CALL_BOND_ABI, 'activeBondOf', [me, token])
    if (id === 0n) return null
    ;[b, bal] = await Promise.all([ctx.read(addr, CALL_BOND_ABI, 'bondOf', [id]), ctx.read(token, ERC20_ABI, 'balanceOf', [me])])
  } catch (e) {
    if (breakBond) return null
    return { refuse: { error: 'cannot read your call bond (GangCallBond), so the sell is not checked against it', callBondContract: addr, detail: e.shortMessage || e.message.split('\n')[0], hint: 're-run; --break-call-bond skips the check' } }
  }
  const after = bal > amount ? bal - amount : 0n
  const base = { callBondId: Number(id), callBondContract: addr, hold: tokens(b.hold), balanceBefore: tokens(bal), balanceAfter: tokens(after), deadline: iso(b.deadline) }
  if (after >= b.hold) return { info: { callBondCheck: { ...base, headroomAfter: tokens(after - b.hold) } } }
  const net = testnet ? ' --testnet' : ''
  let now = Math.floor(Date.now() / 1000)
  try { now = Number((await ctx.client.getBlock()).timestamp) } catch { /* the local clock is close enough for a hint */ }
  const settleHint = now >= Number(b.deadline) ? ` It is past its deadline: settle it first (gang call-bond settle --id ${id}${net}, two steps 1 hour apart), then sell.` : ''
  const consequence = 'anyone can report it — the reporter takes 1%, half burns and the rest pays your note\'s followers. Nothing of it comes back'
  const warning = bal < b.hold
    ? `your call bond #${id} is already broken: you hold ${tokens(bal)} tokens, below its hold (${tokens(b.hold)}), so ${consequence}. Selling more does not change that; buying back to the hold before anyone reports does`
    : `this sell leaves ${tokens(after)} tokens, below the hold of your call bond #${id} (${tokens(b.hold)}): ${consequence}.${settleHint}`
  if (!breakBond) return { refuse: { error: warning, ...base, maxSellKeepingBond: tokens(bal > b.hold ? bal - b.hold : 0n), hint: 'sell at most maxSellKeepingBond, or add --break-call-bond once the user accepts losing the call bond' } }
  return { info: { callBondCheck: { ...base, warning, brokeBond: true } } }
}
