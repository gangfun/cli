/**
 * Trades waiting for the user's approval in the Binance App (`gang execute` → PENDING_CONFIRMATION). baw hands back no tx
 * hash for them, and its tx history has no order id, so a hash could only be found by a person (or an agent with a shell)
 * reading `baw wallet tx-history`. `gang tx --pending` finds it instead: every preview records the call it made (target +
 * a hash of the calldata, baw.js bawPreview); a pending execute marks that record with the chain's block number then; a
 * confirmed wallet tx answers it when its own on-chain input is that exact call and it landed in a later block. The same
 * call can be made twice (a withdraw of 1 share, again): only the block tells the second approval from the first.
 */
import { createHash } from 'node:crypto'

/** The fingerprint of a call: target (lower case) + sha256 of its calldata (lower case hex). */
export const callPrint = (to, data) => `${String(to).toLowerCase()}:${createHash('sha256').update(String(data).toLowerCase()).digest('hex')}`

/**
 * Pending records → their txs. pending: [{ requestId, orderId, pendingAt (ms), pendingBlock, print, chainId }], oldest
 * first; history: baw tx-history rows [{ txHash, txTime, status }]; txOf(hash) → { to, input, blockNumber }; claimed:
 * tx hashes earlier runs already gave to a record. A tx answers the first record whose print is its own call and that
 * went pending before it landed: blockNumber > pendingBlock, or (no block recorded) sent after pendingAt. Each tx answers
 * one record at most. → [{ ...record, txHash | null }]
 */
export async function matchPending(pending, history, txOf, claimed = []) {
  const used = new Set(claimed)
  const out = []
  const confirmed = history.filter((h) => h.status === 'confirmed' && /^0x[0-9a-fA-F]{64}$/.test(h.txHash ?? ''))
    .sort((a, b) => Date.parse(a.txTime) - Date.parse(b.txTime))
  const read = new Map() // txHash → { print, block } | null, read once
  for (const p of pending) {
    let found = null
    for (const h of confirmed) {
      if (used.has(h.txHash)) continue
      if (p.pendingBlock == null && !(Date.parse(h.txTime) > p.pendingAt)) continue
      if (!read.has(h.txHash)) {
        const tx = await txOf(h.txHash).catch(() => null)
        read.set(h.txHash, tx ? { print: callPrint(tx.to, tx.input), block: Number(tx.blockNumber) } : null)
      }
      const t = read.get(h.txHash)
      if (!t || t.print !== p.print) continue
      if (p.pendingBlock != null && !(t.block > p.pendingBlock)) continue
      found = h.txHash
      break
    }
    if (found) used.add(found)
    out.push({ ...p, txHash: found })
  }
  return out
}
