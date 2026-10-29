import { execFileSync } from 'node:child_process'
import { callPrint } from './pending.js'
import { rememberPreview } from './previews.js'

/** Run a `baw` command and parse its --json output. Throws with the CLI's error payload on failure. */
export function baw(args) {
  let out
  try {
    out = execFileSync('baw', [...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20 })
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('baw (the Binance Agentic Wallet CLI) is not installed or not on PATH: npm i -g @binance/agentic-wallet, then baw auth signin. Under an MCP host, start gang mcp with a PATH that has baw\'s directory (which baw)')
    }
    const text = (e.stdout || '') + (e.stderr || '')
    try { return JSON.parse(e.stdout) } catch { throw new Error(`baw ${args[0]} failed: ${text.trim() || e.message}`) }
  }
  return JSON.parse(out)
}

export function bawAddress(chainId = '56') {
  const r = baw(['wallet', 'address'])
  if (!r.success) throw new Error(JSON.stringify(r.error))
  const a = r.data.addresses.find((x) => x.binanceChainId === chainId)
  if (!a) throw new Error(`Agentic Wallet has no address on chain ${chainId}`)
  return a.address
}

export function bawSettings() {
  const r = baw(['wallet', 'settings'])
  if (!r.success) throw new Error(JSON.stringify(r.error))
  return r.data
}

export function bawStatus() {
  const r = baw(['wallet', 'status'])
  return r.success ? r.data.status : 'UNCONNECTED'
}

/** Preview an external contract call through Binance's risk engine. */
export function bawPreview({ from, to, value = 0n, data = '0x', chainId = '56' }) {
  const p = baw(['contract-call', 'preview', '--binanceChainId', chainId, '--from', from, '--to', to, '--value', value.toString(), '--inputData', data])
  // what this preview will send, so `gang tx --pending` can tell its tx once the user approves it in the App
  if (p?.success && p.data?.requestId) rememberPreview(p.data.requestId, { print: callPrint(to, data), chainId: String(chainId) })
  return p
}

export function bawExecute(requestId) {
  return baw(['contract-call', 'execute', '--requestId', requestId])
}
