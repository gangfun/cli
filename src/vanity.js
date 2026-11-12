import { randomBytes } from 'node:crypto'
import { encodeFunctionData, hexToBytes, keccak256, parseAbi, toHex, zeroAddress } from 'viem'
import { PAD3_GEN } from './gangpad.js'

export const VANITY_ABI = parseAbi([
  'function vanityDeployer() view returns (address)',
  'function createWithSalt(bytes32 salt, bytes data) returns (address token)',
  'function tokenInitCodeHash(string name, string symbol, string uri, address handler, uint16 buyTaxBps, uint16 sellTaxBps, bool reclaimable) view returns (bytes32)',
  'function mintInitCodeHash(string name, string symbol, string uri, address handler, uint16 buyTaxBps, uint16 sellTaxBps, uint256 startSupply, uint256 maxSupply) view returns (bytes32)',
  'error InvalidSuffix()', 'error VanityContextRequired()', 'error BadVanityCall()',
])

/** The CREATE2 address `creator`'s user `salt` gives for `initCodeHash` (the pad binds the salt to the creator). */
export function vanityAddress(deployer, creator, initCodeHash, salt) {
  const bound = new Uint8Array(64)
  bound.set(hexToBytes(creator), 12)
  bound.set(hexToBytes(salt), 32)
  const preimage = new Uint8Array(85)
  preimage[0] = 0xff
  preimage.set(hexToBytes(deployer), 1)
  preimage.set(hexToBytes(keccak256(bound)), 21)
  preimage.set(hexToBytes(initCodeHash), 53)
  return `0x${keccak256(preimage).slice(-40)}`
}

/** No RPC calls per attempt. Only the chosen candidate is checked for existing code. */
export async function mineSalt(deployer, creator, initCodeHash, start = BigInt(toHex(randomBytes(32)))) {
  const bound = new Uint8Array(64)
  bound.set(hexToBytes(creator), 12)
  const preimage = new Uint8Array(85)
  preimage[0] = 0xff
  preimage.set(hexToBytes(deployer), 1)
  preimage.set(hexToBytes(initCodeHash), 53)
  for (let i = 0n; ; i++) {
    const salt = toHex((start + i) % (1n << 256n), { size: 32 })
    bound.set(hexToBytes(salt), 32)
    preimage.set(hexToBytes(keccak256(bound)), 21)
    const hash = keccak256(preimage)
    if (hash.endsWith('abcd')) return { salt, token: `0x${hash.slice(-40)}` }
    if (i % 4096n === 4095n) await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Probe only 3.0; a transport failure must never silently build an unsalted launch. */
export async function vanityDeployer(ctx) {
  if (ctx.gen !== PAD3_GEN && ctx.version !== 3) return null
  if (!ctx._vanityDeployer) ctx._vanityDeployer = (async () => {
    let deployer
    try { deployer = await ctx.read(ctx.pad, VANITY_ABI, 'vanityDeployer') } catch (e) {
      const reverted = e?.walk?.((x) => x?.name === 'ContractFunctionRevertedError')
      if (reverted && !reverted.data && (!reverted.raw || reverted.raw === '0x')) return null
      throw e
    }
    return deployer.toLowerCase() === zeroAddress ? null : deployer
  })()
  return ctx._vanityDeployer
}

/**
 * A salt whose address ends in abcd and has no code yet, for a token with these constructor `args`
 * (tokenInitCodeHash's / mintInitCodeHash's): the address the token will have, known before it exists. null on a pad
 * without the deployer.
 */
export async function mineToken(ctx, creator, { mint = false, args }) {
  const deployer = await vanityDeployer(ctx)
  if (!deployer) return null
  const initCodeHash = await ctx.read(deployer, VANITY_ABI, mint ? 'mintInitCodeHash' : 'tokenInitCodeHash', args)
  let found
  do { found = await mineSalt(deployer, creator, initCodeHash) }
  while (await ctx.client.getBytecode({ address: found.token }).then((code) => code && code !== '0x'))
  return { ...found, deployer, initCodeHash }
}

/**
 * The create through the deployer. `fixed` ({ salt, token }): a launch that already named the token's address (a floor
 * module is cloned for it) — the same salt is used, and when these `args` no longer lead to that address the result is
 * { mismatch: { expected, got } } instead of a tx: the token would land elsewhere.
 */
export async function vanityCreate(ctx, creator, data, { mint = false, args, fixed = null }) {
  if (fixed) {
    const deployer = await vanityDeployer(ctx)
    if (!deployer) return { mismatch: { expected: fixed.token, got: null } }
    const initCodeHash = await ctx.read(deployer, VANITY_ABI, mint ? 'mintInitCodeHash' : 'tokenInitCodeHash', args)
    const got = vanityAddress(deployer, creator, initCodeHash, fixed.salt)
    if (got.toLowerCase() !== String(fixed.token).toLowerCase()) return { mismatch: { expected: fixed.token, got } }
    return {
      salt: fixed.salt, token: got,
      data: encodeFunctionData({ abi: VANITY_ABI, functionName: 'createWithSalt', args: [fixed.salt, data] }),
    }
  }
  const found = await mineToken(ctx, creator, { mint, args })
  if (!found) return { data }
  return {
    salt: found.salt, token: found.token,
    data: encodeFunctionData({ abi: VANITY_ABI, functionName: 'createWithSalt', args: [found.salt, data] }),
  }
}
