# Testnet first trade

Creates a token on BSC testnet, buys it and sells it, using `--calldata` and your own test key.

```bash
cast wallet new                    # make a throwaway wallet, and fund it from a BSC testnet faucet (0.01 tBNB is plenty)
export TEST_PRIVATE_KEY=0x…        # that wallet's key: never one that holds real funds
./run.sh
```

It needs `gang`, `cast` ([Foundry](https://getfoundry.sh)) and `jq`. It refuses to send anything that isn't for chain 97.
