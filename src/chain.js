import { createPublicClient, http, formatEther, parseEther, encodeFunctionData, decodeEventLog } from 'viem'
import { bsc } from 'viem/chains'
import { LAUNCHPAD_ABI, ERC20_ABI } from './abi.js'

export const CONFIG = {
  rpc: process.env.GANG_RPC_URL || 'https://bsc-dataseed.binance.org',
  launchpad: process.env.GANG_LAUNCHPAD || '0x315Ba2e8952D06094CC636b2B84229FA32fb23A7',
  chainId: '56',
}

export const client = createPublicClient({ chain: bsc, transport: http(CONFIG.rpc) })
const pad = (functionName, args = []) => client.readContract({ address: CONFIG.launchpad, abi: LAUNCHPAD_ABI, functionName, args })
const erc = (address, functionName, args = []) => client.readContract({ address, abi: ERC20_ABI, functionName, args })

export const fmt = (wei) => formatEther(wei)
export const fmtTok = (units) => Number(formatEther(units)).toLocaleString('en-US', { maximumFractionDigits: 2 })
export { parseEther, encodeFunctionData }

export async function tokenInfo(token, me) {
  const [c, name, symbol, locked, grad, cap] = await Promise.all([
    pad('curves', [token]), erc(token, 'name'), erc(token, 'symbol'), erc(token, 'locked'),
    pad('GRADUATION_BNB'), pad('MAX_PER_WALLET'),
  ])
  const [creator, realBnb, sold, graduated, pair] = c
  if (creator === '0x0000000000000000000000000000000000000000') throw new Error(`not a Gang token: ${token}`)
  // curve end price (1e-7 BNB) for graduated tokens; live spot otherwise
  const price = graduated ? 100000000000n : await pad('spotPrice', [token])
  const info = {
    token, name, symbol, creator, graduated, pair: graduated ? pair : null, locked,
    priceBnb: Number(price) / 1e18,
    fdvBnb: (Number(price) / 1e18) * 1e9,
    raisedBnb: fmt(realBnb), graduationBnb: fmt(grad),
    progressPct: Number((realBnb * 10000n) / grad) / 100,
    soldTokens: fmtTok(sold), walletCapTokens: fmtTok(cap),
  }
  if (me) {
    const [bal, room] = await Promise.all([erc(token, 'balanceOf', [me]), pad('walletRoom', [token, me])])
    info.myBalance = fmtTok(bal); info.myBalanceRaw = bal.toString(); info.myRoomTokens = fmtTok(room); info.myRoomRaw = room.toString()
  }
  return info
}

export async function listTokens(me) {
  const n = await pad('tokenCount')
  const addrs = await Promise.all(Array.from({ length: Number(n) }, (_, i) => pad('allTokens', [BigInt(i)])))
  return Promise.all(addrs.map((a) => tokenInfo(a, me)))
}

export async function quoteBuy(token, buyer, bnb) {
  const gross = parseEther(bnb)
  const [tokensOut, bnbIn, fee, refund] = await pad('quoteBuy', [token, buyer, gross])
  return { bnbGross: bnb, tokensOut, bnbIn, fee, refund, tokensOutFmt: fmtTok(tokensOut), bnbInFmt: fmt(bnbIn), feeFmt: fmt(fee), refundFmt: fmt(refund) }
}

export async function quoteSell(token, tokensIn) {
  const [bnbToUser, fee] = await pad('quoteSell', [token, tokensIn])
  return { tokensIn, bnbToUser, fee, tokensInFmt: fmtTok(tokensIn), bnbToUserFmt: fmt(bnbToUser), feeFmt: fmt(fee) }
}

export const isAgent = (a) => pad('isAgent', [a])
export const balanceOf = (token, a) => erc(token, 'balanceOf', [a])
export const allowance = (token, a) => erc(token, 'allowance', [a, CONFIG.launchpad])

export const calldata = {
  buy: (token, minTokensOut) => encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: 'buy', args: [token, minTokensOut] }),
  sell: (token, tokensIn, minBnbOut) => encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: 'sell', args: [token, tokensIn, minBnbOut] }),
  approve: (amount) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [CONFIG.launchpad, amount] }),
  create: (name, symbol) => encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: 'create', args: [name, symbol] }),
}

export async function decodeTx(hash) {
  const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  const events = []
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== CONFIG.launchpad.toLowerCase()) continue
    try {
      const ev = decodeEventLog({ abi: LAUNCHPAD_ABI, data: log.data, topics: log.topics })
      const a = Object.fromEntries(Object.entries(ev.args).map(([k, v]) => [k, typeof v === 'bigint' ? (k.toLowerCase().includes('token') && k !== 'token' ? fmtTok(v) : fmt(v)) : v]))
      events.push({ event: ev.eventName, ...a })
    } catch { /* not ours */ }
  }
  return { hash, status: r.status, block: Number(r.blockNumber), events }
}
