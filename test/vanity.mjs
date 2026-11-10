import assert from 'node:assert/strict'
import { ContractFunctionRevertedError, decodeFunctionData, encodeAbiParameters, getCreate2Address, keccak256, parseAbiParameters, zeroAddress } from 'viem'
import { mineSalt, VANITY_ABI, vanityCreate, vanityDeployer } from '../src/vanity.js'
import { PAD3_GEN } from '../src/gangpad.js'

const FACTORY = '0x1111111111111111111111111111111111111111'
const CREATOR = '0x2222222222222222222222222222222222222222'
const HASH = `0x${'33'.repeat(32)}`
const effectiveSalt = (creator, salt) => keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [creator, salt]))
const predicted = (creator, hash, salt) => getCreate2Address({ from: FACTORY, salt: effectiveSalt(creator, salt), bytecodeHash: hash }).toLowerCase()

const found = await mineSalt(FACTORY, CREATOR, HASH, 0n)
assert.equal(found.salt, `0x${'2d4e'.padStart(64, '0')}`)
assert.equal(found.token, predicted(CREATOR, HASH, found.salt))
assert.ok(found.token.endsWith('abcd'))
assert.notEqual(found.token, predicted(zeroAddress, HASH, found.salt), 'creator binding prevents copying a salt to take its address')
assert.notEqual(found.token, predicted(CREATOR, `0x${'44'.repeat(32)}`, found.salt), 'constructor parameters are part of the address')

// A previous 3.0 deployment reverts for the missing getter; RPC failures and empty data do not mean disabled.
const missing = new ContractFunctionRevertedError({ abi: VANITY_ABI, functionName: 'vanityDeployer', data: '0x' })
assert.equal(await vanityDeployer({ gen: PAD3_GEN, read: async () => { throw missing } }), null)
await assert.rejects(vanityDeployer({ gen: PAD3_GEN, read: async () => { throw new Error('RPC offline') } }), /RPC offline/)
assert.equal(await vanityDeployer({ gen: '2.0', read: async () => { assert.fail('must not probe older pads') } }), null)

const reads = [], checked = []
const ctx = {
  gen: PAD3_GEN, pad: CREATOR,
  read: async (to, _abi, fn, args) => {
    reads.push({ to, fn, args })
    if (fn === 'vanityDeployer') return FACTORY
    assert.equal(to, FACTORY)
    assert.equal(fn, 'tokenInitCodeHash')
    return HASH
  },
  client: { getBytecode: async ({ address }) => { checked.push(address); return checked.length === 1 ? '0x6000' : undefined } },
}
const args = ['Name', 'SYM', 'ipfs://metadata', zeroAddress, 0, 0, false]
const launch = await vanityCreate(ctx, CREATOR, '0x12345678', { args })
assert.equal(checked.length, 2, 'occupied candidates are skipped')
assert.equal(launch.token, predicted(CREATOR, HASH, launch.salt))
const decoded = decodeFunctionData({ abi: VANITY_ABI, data: launch.data })
assert.equal(decoded.functionName, 'createWithSalt')
assert.deepEqual(decoded.args, [launch.salt, '0x12345678'])
assert.deepEqual(reads[1].args, args)

// The mint path uses the final metadata and supply cap; a disabled factory preserves legacy calldata exactly.
ctx.read = async (_to, _abi, fn, actual) => {
  assert.equal(fn, 'mintInitCodeHash')
  assert.equal(actual[2], 'ipfs://final-metadata')
  assert.equal(actual[7], 200_000_000_000n * 10n ** 18n)
  return HASH
}
await vanityCreate(ctx, CREATOR, '0x87654321', { mint: true, args: ['Fly', 'FLY', 'ipfs://final-metadata', FACTORY, 100, 200, 0n, 200_000_000_000n * 10n ** 18n] })
assert.deepEqual(await vanityCreate({ gen: PAD3_GEN, read: async () => zeroAddress }, CREATOR, '0x12345678', { args }), { data: '0x12345678' })
console.log('vanity: ok')
