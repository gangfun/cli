// Exercise the real three create commands, with metadata resolution and an activated factory, against a local RPC.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getCreate2Address, keccak256, parseAbi, parseAbiParameters, toFunctionSelector, toHex } from 'viem'
import { runV3, V3_EVENT_ABIS, V3_NETS } from '../src/v3.js'
import { runFair, FAIR_EVENT_ABIS, FAIR_NETS } from '../src/fair.js'
import { runFly, FLY_PAD_ABI, FLY_PAD_V2_ABI } from '../src/fly.js'
import { CREATOR_FEE_ABI, GRAD_TARGET_ABI } from '../src/gangpad.js'
import { VANITY_ABI } from '../src/vanity.js'

const FACTORY = '0x1111111111111111111111111111111111111111'
const CREATOR = '0x2222222222222222222222222222222222222222'
const HANDLER = '0x3333333333333333333333333333333333333333'
const abi = [...V3_EVENT_ABIS[0], ...FAIR_EVENT_ABIS[0], ...FLY_PAD_ABI, ...FLY_PAD_V2_ABI,
  ...CREATOR_FEE_ABI, ...GRAD_TARGET_ABI, ...VANITY_ABI,
  ...parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
    'function implementation() view returns (address)'])]
const functions = new Map(abi.filter((f) => f.type === 'function').map((f) => [toFunctionSelector(f), f]))
const hashOf = (args) => keccak256(toHex(JSON.stringify(args, (_key, x) => typeof x === 'bigint' ? x.toString() : x)))
const predicted = (salt, hash) => getCreate2Address({ from: FACTORY, bytecodeHash: hash,
  salt: keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [CREATOR, salt])),
}).toLowerCase()
let hashes = [], simulations = 0

const answer = (b) => {
  if (b.method === 'eth_chainId') return { result: '0x61' }
  if (b.method === 'eth_getCode') return { result: '0x' }
  assert.equal(b.method, 'eth_call')
  const { data } = b.params[0]
  const f = functions.get(data.slice(0, 10))
  if (!f) return { error: { code: 3, message: 'execution reverted', data: '0x' } }
  const { args = [] } = decodeFunctionData({ abi: [f], data })
  let result
  switch (f.name) {
    case 'vanityDeployer': result = FACTORY; break
    case 'taxHandler': case 'flyTaxHandler': case 'router': case 'recipientRegistry': case 'migrator': case 'implementation': result = HANDLER; break
    case 'tokenInitCodeHash': case 'mintInitCodeHash':
      result = hashOf(args); hashes.push({ name: f.name, args, hash: result }); break
    case 'createWithSalt': {
      const inner = decodeFunctionData({ abi, data: args[1] })
      assert.ok(['create', 'createWithGradTarget', 'createWithVault', 'createWithPromote'].includes(inner.functionName))
      result = predicted(args[0], hashes.at(-1).hash)
      assert.ok(result.endsWith('abcd'))
      simulations++
      break
    }
    case 'create': assert.fail('the CLI must wrap every create after activation'); break
    case 'checkTaxConfigFor': case 'checkTaxConfig': case 'checkConfig': result = [true, '']; break
    case 'isAgent': case 'agentGateEnabled': result = true; break
    case 'GRAD_BNB_TIERS': result = [6n, 9n, 12n, 15n].map((x) => x * 10n ** 18n); break
    case 'TARGET_GRAD_BNB': case 'graduationAmountOf': result = 9n * 10n ** 18n; break
    case 'graduationAmountFor': result = args[2]; break
    case 'previewCreate': result = [15n * 10n ** 18n, 15n * 10n ** 14n]; break
    case 'PROTOCOL_FEE_BPS': result = 100n; break
    case 'PLATFORM_TAX_BPS': result = 50n; break
    case 'CREATOR_FEE_SHARE_BPS': result = 7000n; break
    case 'symbol': result = 'WBNB'; break
    case 'decimals': result = 18; break
    case 'balanceOf': case 'allowance': result = 10n ** 30n; break
    default: return { error: { code: 3, message: 'execution reverted', data: '0x' } }
  }
  return { result: encodeFunctionResult({ abi: [f], functionName: f.name, result }) }
}
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const input = JSON.parse(body)
    const one = (b) => ({ jsonrpc: '2.0', id: b.id, ...answer(b) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(Array.isArray(input) ? input.map(one) : one(input)))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const rpc = `http://127.0.0.1:${server.address().port}`
process.env.GANG_TESTNET_RPC_URL = rpc
V3_NETS.testnet.rpcs = [rpc]
FAIR_NETS.testnet.rpcs = [rpc]
const io = (flags) => ({
  opt: (key, fallback) => flags[key] ?? fallback,
  flag: (key) => Object.hasOwn(flags, key),
  out: (x) => x,
  fail: (error, details) => { throw new Error(`${error} ${JSON.stringify(details ?? {})}`) },
  summarize: () => assert.fail('raw calldata needs no wallet preview'),
  checkMeta: () => {},
  resolveLogo: async () => ({ logoURI: 'ipfs://logo' }),
  resolveMeta: async () => ({ metaURI: 'ipfs://final-metadata', metadata: { name: 'Vanity' } }),
  notes: { step: (_ctx, tx, extra) => ({ success: true, ...extra, tx }), skipped: () => ({}) },
})
try {
  for (const [run, extra, mint] of [[runV3, {}, false], [runV3, { 'buy-tax': '2', 'sell-tax': '3' }, false],
    [runFair, {}, false], [runFly, {}, true]]) {
    hashes = []; simulations = 0
    const output = await run('create', io({ name: 'Vanity', symbol: 'VAN', from: CREATOR, testnet: true, calldata: true, ...extra }))
    assert.equal(output.success, true, JSON.stringify(output))
    assert.equal(output.addressSuffix, 'abcd')
    assert.equal(simulations, 1, 'a salted dry run happens before metadata upload')
    assert.equal(hashes[0].args[2], '')
    assert.equal(hashes.at(-1).args[2], 'ipfs://final-metadata')
    assert.equal(hashes.at(-1).name, mint ? 'mintInitCodeHash' : 'tokenInitCodeHash')
    const { args } = decodeFunctionData({ abi: VANITY_ABI, data: output.tx.data })
    assert.equal(output.tokenIfNext, predicted(args[0], hashes.at(-1).hash))
    const inner = decodeFunctionData({ abi, data: args[1] })
    assert.equal(mint ? inner.args[0][3] : inner.args[3], 'ipfs://final-metadata')
    if (mint) assert.equal(hashes.at(-1).args[7], 200_000_000_000n * 10n ** 18n)
    else if (extra['buy-tax']) assert.deepEqual(hashes.at(-1).args.slice(3), [HANDLER, 200, 300, false])
  }
  console.log('vanity-create: ok')
} finally { server.closeAllConnections(); server.close() }
