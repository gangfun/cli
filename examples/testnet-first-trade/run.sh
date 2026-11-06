#!/usr/bin/env bash
# A first trade on BSC testnet: register a test Agent ID, create a token, buy it, sell it.
# Needs: gang (@gangfun/cli), cast (Foundry), jq, and a throwaway wallet holding a little testnet BNB.
#
#   export TEST_PRIVATE_KEY=0x…   # a key made for this test: never one that holds real funds
#   ./run.sh
set -euo pipefail

: "${TEST_PRIVATE_KEY:?set TEST_PRIVATE_KEY to a throwaway wallet key}"
export ETH_RPC_URL="${GANG_TESTNET_RPC_URL:-https://bsc-testnet-rpc.publicnode.com}"
AGENT_ID=0x24D0A2106AC3Ebf7d770d19f4aF0a5149ebe5B2a # anyone can register here, testnet only; mainnet needs a real .ai Agent ID
GAS=(--legacy --gas-price 100000000) # the BSC testnet doesn't mine cast's default tip
WALLET=$(cast wallet address --private-key "$TEST_PRIVATE_KEY")
echo "wallet: $WALLET"
[ "$(cast chain-id)" = 97 ] || { echo "the RPC is not BSC testnet" >&2; exit 1; }

# Sends a --calldata result: its steps[] in order, or its tx. Prints the last hash. Refuses anything not for chain 97.
send() {
  jq -e '.success == true and ([(.steps // [{tx: .tx}])[].tx.chainId] | all(. == 97))' <<<"$1" >/dev/null || { echo "not sending: $(jq -c '{error, code}' <<<"$1")" >&2; exit 1; }
  local tx hash
  while read -r tx; do
    hash=$(cast send --chain 97 --private-key "$TEST_PRIVATE_KEY" "${GAS[@]}" --value "$(jq -r '.value // "0"' <<<"$tx")" \
      "$(jq -r .to <<<"$tx")" "$(jq -r .data <<<"$tx")" --json | jq -r 'if .status == "0x1" then .transactionHash else error("tx reverted: \(.transactionHash)") end') || exit 1 # set -e doesn't reach inside $()
  done < <(jq -c '(.steps // [{tx: .tx}])[].tx' <<<"$1")
  echo "$hash"
}

HAS_ID=$(cast call --chain 97 "$AGENT_ID" 'balanceOf(address)(uint256)' "$WALLET")
if [ "$HAS_ID" = 0 ]; then
  echo "registering a test Agent ID…"
  cast send --chain 97 --private-key "$TEST_PRIVATE_KEY" "${GAS[@]}" "$AGENT_ID" 'register()' >/dev/null
fi

echo "creating a token…"
TX=$(send "$(gang create --name "${TOKEN_NAME:-First Trade}" --symbol "${TOKEN_SYMBOL:-FIRST}" --testnet --calldata --from "$WALLET")")
TOKEN=$(gang tx --hash "$TX" --testnet | jq -r '.events[] | select(.event == "Created") | .token')
echo "token: $TOKEN"

echo "buying 0.001 testnet BNB of it…"
send "$(gang buy --token "$TOKEN" --amount 0.001 --testnet --calldata --from "$WALLET")" >/dev/null
gang status --token "$TOKEN" --from "$WALLET" --testnet | jq '{balance, progressPct}'

echo "selling it all…"
SELL=$(gang sell --token "$TOKEN" --all --testnet --calldata --from "$WALLET")
if [ "$(jq -r .step <<<"$SELL")" = approve ]; then # setup step: send it, then run the same command again
  send "$SELL" >/dev/null
  SELL=$(gang sell --token "$TOKEN" --all --testnet --calldata --from "$WALLET")
fi
TX=$(send "$SELL")
gang tx --hash "$TX" --testnet | jq '{status, events: [.events[].event]}'
echo "done"
