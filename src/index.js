#!/usr/bin/env node
import { CONFIG, listTokens, tokenInfo, quoteBuy, quoteSell, isAgent, balanceOf, allowance, calldata, decodeTx, parseEther, fmt, fmtTok } from './chain.js'
import { bawAddress, bawSettings, bawStatus, bawPreview, bawExecute } from './baw.js'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def }
const flag = (name) => args.includes(`--${name}`)
const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const fail = (msg, extra = {}) => { out({ success: false, error: msg, ...extra }); process.exit(1) }

const parseSlippage = (raw) => {
  const s = Number(raw)
  if (!Number.isFinite(s) || s < 0 || s > 50) fail('--slippage must be a number between 0 and 50', { got: raw })
  return s
}

const HELP = `gang — agent-only launchpad on BNB Chain (Binance Agentic Wallet)

  gang preflight                         check sign-in, Developer Mode, tradeAllTokens, Agent ID
  gang list                              all tokens with price, progress, my balance
  gang token --token <addr>              one token in detail
  gang quote --token <addr> --bnb <n>    buy quote for my wallet (fee, cap, refund)
  gang buy --token <addr> --bnb <n> [--slippage 1]      preview a buy  -> requestId
  gang sell --token <addr> (--amount <tokens> | --all) [--slippage 1]  preview approve or sell -> requestId
  gang create --name <n> --symbol <s>    preview token creation -> requestId
  gang execute --request-id <id>         broadcast a previewed call
  gang tx --hash <0x..>                  wait for receipt and decode Gang events

env: GANG_LAUNCHPAD (default ${CONFIG.launchpad}), GANG_RPC_URL`

function summarizePreview(p, extra = {}) {
  if (!p.success) return { success: false, step: extra.step, error: p.error }
  const d = p.data
  const changes = (d.simulationResult?.balanceChanges || []).map((b) => ({ token: b.contractAddress, type: b.tokenType, change: b.change }))
  return {
    success: true, ...extra,
    requestId: d.requestId, expiresAt: d.expiresAt,
    requireConfirmation: d.requireConfirmation,
    risks: d.risks?.riskDetails || [],
    simulatedChanges: changes,
    next: `gang execute --request-id ${d.requestId}`,
  }
}

async function main() {
  switch (cmd) {
    case 'preflight': {
      const issues = []
      const status = bawStatus()
      if (status !== 'CONNECTED') issues.push({ code: 'NOT_SIGNED_IN', fix: 'Run `baw auth signin` and confirm in the Binance App.' })
      let me = null, settings = null, agent = false
      if (status === 'CONNECTED') {
        me = bawAddress(); settings = bawSettings()
        if (!settings.devMode?.enabled) issues.push({ code: 'DEV_MODE_OFF', fix: 'Enable Developer Mode in Binance App → Agentic Wallet settings.' })
        if (!settings.tradeAllTokens) issues.push({ code: 'TRADE_ALL_TOKENS_OFF', fix: 'Enable "Trade all tokens" in Binance App → Agentic Wallet settings, otherwise SELLING Gang tokens is blocked by risk control (buying still works).' })
        agent = await isAgent(me)
        if (!agent) issues.push({ code: 'NO_AGENT_ID', fix: 'Claim a .ai Agent ID in Binance Wallet (Agent ID banner). Gang only lets Agent ID holders buy.' })
      }
      return out({ success: issues.length === 0, status, address: me, launchpad: CONFIG.launchpad, isAgent: agent, devMode: settings?.devMode?.enabled ?? null, tradeAllTokens: settings?.tradeAllTokens ?? null, issues })
    }
    case 'list': {
      const me = bawStatus() === 'CONNECTED' ? bawAddress() : undefined
      return out({ success: true, launchpad: CONFIG.launchpad, tokens: await listTokens(me) })
    }
    case 'token': {
      const token = opt('token'); if (!token) fail('--token required')
      const me = bawStatus() === 'CONNECTED' ? bawAddress() : undefined
      return out({ success: true, ...(await tokenInfo(token, me)) })
    }
    case 'quote': {
      const token = opt('token'), bnb = opt('bnb'); if (!token || !bnb) fail('--token and --bnb required')
      const me = bawAddress()
      const q = await quoteBuy(token, me, bnb)
      return out({ success: true, token, buyer: me, tokensOut: q.tokensOutFmt, bnbSpent: q.bnbInFmt, fee: q.feeFmt, refund: q.refundFmt, note: q.refund > 0n ? 'Part of the BNB would be refunded (wallet 1% cap or graduation cap).' : undefined })
    }
    case 'buy': {
      const token = opt('token'), bnb = opt('bnb'); if (!token || !bnb) fail('--token and --bnb required')
      const slippage = parseSlippage(opt('slippage', '1'))
      const me = bawAddress()
      const info = await tokenInfo(token, me)
      if (info.graduated) fail('token already graduated; trade it on PancakeSwap', { pair: info.pair })
      if (!(await isAgent(me))) fail('this wallet holds no Agent ID (.ai); buying is gated', { address: me })
      const q = await quoteBuy(token, me, bnb)
      if (q.tokensOut === 0n) fail('wallet cap reached: this wallet already holds 1% of supply', { myBalance: info.myBalance })
      const minOut = (q.tokensOut * BigInt(Math.round((100 - slippage) * 100))) / 10000n
      const data = calldata.buy(token, minOut)
      const p = bawPreview({ from: me, to: CONFIG.launchpad, value: parseEther(bnb), data })
      return out(summarizePreview(p, { step: 'buy', token, symbol: info.symbol, bnbSent: bnb, expectTokens: q.tokensOutFmt, expectBnbSpent: q.bnbInFmt, fee: q.feeFmt, expectRefund: q.refundFmt, minTokensOut: fmtTok(minOut) }))
    }
    case 'sell': {
      const token = opt('token'); if (!token) fail('--token required')
      const me = bawAddress()
      const info = await tokenInfo(token, me)
      if (info.graduated) fail('token already graduated; sell on PancakeSwap', { pair: info.pair })
      const bal = await balanceOf(token, me)
      if (bal === 0n) fail('no balance to sell')
      if (!flag('all') && !opt('amount')) fail('pass --amount <tokens> or --all (full sell is no longer the default)')
      if (flag('all') && opt('amount')) fail('use either --all or --amount, not both')
      const amount = flag('all') ? bal : parseEther(opt('amount'))
      if (amount > bal) fail('amount exceeds balance', { balance: fmtTok(bal) })
      const allow = await allowance(token, me)
      if (allow < amount) {
        const p = bawPreview({ from: me, to: token, data: calldata.approve(amount) })
        return out(summarizePreview(p, { step: 'approve', token, symbol: info.symbol, amount: fmtTok(amount), note: 'Approve first. After it confirms on-chain, run the same `gang sell` again to preview the sell.' }))
      }
      const slippage = parseSlippage(opt('slippage', '1'))
      const q = await quoteSell(token, amount)
      const minOut = (q.bnbToUser * BigInt(Math.round((100 - slippage) * 100))) / 10000n
      const p = bawPreview({ from: me, to: CONFIG.launchpad, data: calldata.sell(token, amount, minOut) })
      return out(summarizePreview(p, { step: 'sell', token, symbol: info.symbol, amount: fmtTok(amount), expectBnb: q.bnbToUserFmt, fee: q.feeFmt, minBnbOut: fmt(minOut) }))
    }
    case 'create': {
      const name = opt('name'), symbol = opt('symbol'); if (!name || !symbol) fail('--name and --symbol required')
      const me = bawAddress()
      const p = bawPreview({ from: me, to: CONFIG.launchpad, data: calldata.create(name, symbol) })
      return out(summarizePreview(p, { step: 'create', name, symbol, note: 'No creation fee. The token address appears in the Created event: run `gang tx --hash <txHash>` after execute.' }))
    }
    case 'execute': {
      const id = opt('request-id'); if (!id) fail('--request-id required')
      const r = bawExecute(id)
      if (!r.success) return out({ success: false, error: r.error })
      const d = r.data
      const pending = d.status === 'PENDING_CONFIRMATION'
      return out({ success: true, status: d.status, txHash: d.txHash, orderId: d.orderId, pendingConfirmation: pending, next: pending ? 'Ask the user to approve this transaction in the Binance App, then poll `baw wallet tx-history --binanceChainId 56 --type confirmed --json` for the tx hash and run `gang tx --hash <hash>`.' : (d.txHash ? `gang tx --hash ${d.txHash}` : undefined) })
    }
    case 'tx': {
      const hash = opt('hash'); if (!hash) fail('--hash required')
      return out({ success: true, ...(await decodeTx(hash)) })
    }
    default:
      console.log(HELP); process.exit(cmd ? 1 : 0)
  }
}

main().catch((e) => fail(e.message))
