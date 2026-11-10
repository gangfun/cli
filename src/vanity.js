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

export async function vanityCreate(ctx, creator, data, { mint = false, args }) {
  const deployer = await vanityDeployer(ctx)
  if (!deployer) return { data }
  const initCodeHash = await ctx.read(deployer, VANITY_ABI, mint ? 'mintInitCodeHash' : 'tokenInitCodeHash', args)
  let found
  do { found = await mineSalt(deployer, creator, initCodeHash) }
  while (await ctx.client.getBytecode({ address: found.token }).then((code) => code && code !== '0x'))
  return {
    ...found,
    data: encodeFunctionData({ abi: VANITY_ABI, functionName: 'createWithSalt', args: [found.salt, data] }),
  }
}
