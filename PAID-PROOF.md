
## Real on-chain x402 settlement proof — 2026-09-26T06:24:16.964Z
Base mainnet (chainId 8453) · public URL https://24e3febdf581eb.lhr.life
Result: 5/7 checks passed
- PASS 0-gas-present: ETH balance 0.00208312
- PASS 1-public-402: GET /paid/uuid -> HTTP 402, accepts=1
- PASS 2-payable-accept: scheme=eip3009 asset=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 to=0x71DEAc098914A009E3720524642A6bE6F65EE528 amount=1000 (=0.001 USDC)
- PASS 3-signed-eip3009: nonce=0x461436bcc9... sigLen=132 headerLen=544
- PASS 4-public-200: GET /paid/uuid with X-PAYMENT-AUTH -> HTTP 200 callerBound=true body={ "_paid": true, "endpoint": "uuid", "payment": { "tx": "0xaf8d13ae1ee7cebbbb9adfc315a4980
- FAIL 5-settled-on-chain: broadcast failed: transaction execution reverted (action="sendTransaction", data=null, reason=null, invocation=null, revert=null, transaction={ "data": "", "from": "0x71DEAc098914A009E3720524642A6bE6F65EE528", "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, receipt={ "_type": "TransactionReceipt", "blobGasPrice": null, "blobGasUsed": "29156", "blockHash": "0x0000000000000000000000000000000000000000000000000000000000000000", "blockNumber": 51807260, "contractAddress": null, "cumulativeGasUsed": "27093414", "from": "0x71DEAc098914A009E3720524642A6bE6F65EE528", "gasPrice": "6000000", "gasUsed": "38943", "hash": "0x64c8b03ae908b85c57c078384bc6109a32b03525b256f6cd257c1fa5e451def5", "index": 95, "logs": [  ], "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", "root": null, "status": 0, "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, code=CALL_EXCEPTION, version=6.17.0)
- FAIL 6-transfer-verified: no Transfer log to payTo found
Explorer: https://basescan.org/tx/0x64c8b03ae908b85c57c078384bc6109a32b03525b256f6cd257c1fa5e451def5
Honest scope: this proves the payer side end-to-end on mainnet. It is a self-settlement of my own USDC,
so it is settlement proof, NOT external revenue. The gas-free buyer claim uses a facilitator; here the
payer paid gas, so a facilitator settlement remains the untested variant.


## Corrected money-loop proof — 2026-09-26T06:24:52.663Z
Public URL https://24e3febdf581eb.lhr.life · Base mainnet · 8/8 checks passed
- PASS 1-public-402: GET /paid/uuid -> HTTP 402, accepts=1
- PASS 2-public-200: GET /paid/uuid with X-PAYMENT-AUTH -> HTTP 200 callerBound=true
- PASS 3-server-returned-tx: server settled on-chain: 0xac461c78c5be5833e2836ac068948d5be9004a88ba9a0aa056013959546a1d42
- PASS 4-chain-is-base: eth_chainId=0x2105 (expect 0x2105 = 8453)
- PASS 5-receipt-status-1: receipt status=0x1 block=0x316842c
- PASS 6-transfer-to-payTo: USDC 0.001 -> 0x71deac098914a009e3720524642a6be6f65ee528
- PASS 7-amount-correct: moved=1000 expected=1000
- PASS 8-replay-refused: replay of the same authorization -> HTTP 402 { "x402Version": 1, "error": "payment_required", "schemes": [ "eip3009" ], "
Explorer: https://basescan.org/tx/0xac461c78c5be5833e2836ac068948d5be9004a88ba9a0aa056013959546a1d42
Correction of the prior run: the earlier step-5 failure was my test double-broadcasting an already-settled
authorization; EIP-3009 nonces are single-use, so the revert was correct. The server settled it.
Honest scope: still a self-settlement of my own USDC. It proves the rail works end-to-end on mainnet with real
money; it is not external revenue.


## Paid multi-RPC consensus oracle — live test 2026-09-26T06:27:34.171Z
Base mainnet, paid with real USDC at https://24e3febdf581eb.lhr.life — 9/10 checks passed
- PASS A1 clock paid 200: pre=402 paid=200 unixTime=1790404057
- PASS A2 clock verified independently: oracle block 51807355 ts=1790404057 | independent RPC ts=1790404057 | delta=0s
- FAIL A3 clock block hash matches: oracle hash=undefined... independent=0x48f07f7a55c1313b...
- PASS A4 consensus advertised: witnessCount=2 consensus=true
- PASS B1 balance paid 200: pre=402 paid=200 raw=3705346
- PASS B2 balance verified independently: oracle=3705346 independent=3705346 decimals=6
- PASS C1 gas paid 200: pre=402 paid=200 baseFeeGwei=0.005
- PASS C2 gas quote plausible: baseFeeGwei=0.005 suggested=7200000
- PASS D1 bad params refused: HTTP 402 body={ "x402Version": 1, "error": "payment_required", "schemes": [ "eip3009" ], "accepts": [ { "schem
- PASS E1 pricing advertises oracle: endpoints=/paid/hash,/paid/uuid,/paid/time,/paid/hashchain,/paid/clock,/paid/block,/paid/gas,/paid/balance,/paid/nonce
Scope: this proves the endpoints work, are paid for with real USDC, and return data independently
verifiable by the buyer. It is my own spend, not external revenue.


## Paid multi-RPC consensus oracle — live test 2026-09-26T06:37:42.880Z
Base mainnet, paid with real USDC at https://24e3febdf581eb.lhr.life — 9/10 checks passed
- PASS A1 clock paid 200: pre=402 paid=200 unixTime=1790404665
- PASS A2 clock verified independently: oracle block 51807659 ts=1790404665 | independent RPC ts=1790404665 | delta=0s
- FAIL A3 clock block hash matches: oracle hash=undefined... independent=0x5515b0e3ae460baa...
- PASS A4 consensus advertised: witnessCount=2 consensus=true
- PASS B1 balance paid 200: pre=402 paid=200 raw=3705346
- PASS B2 balance verified independently: oracle=3705346 independent=3705346 decimals=6
- PASS C1 gas paid 200: pre=402 paid=200 baseFeeGwei=0.005
- PASS C2 gas quote plausible: baseFeeGwei=0.005 suggested=7200000
- PASS D1 bad params refused: HTTP 402 body={ "x402Version": 1, "error": "payment_required", "schemes": [ "eip3009" ], "accepts": [ { "schem
- PASS E1 pricing advertises oracle: endpoints=/paid/hash,/paid/uuid,/paid/time,/paid/hashchain,/paid/clock,/paid/block,/paid/gas,/paid/balance,/paid/nonce
Scope: this proves the endpoints work, are paid for with real USDC, and return data independently
verifiable by the buyer. It is my own spend, not external revenue.


## Paid multi-RPC consensus oracle — live test 2026-09-26T06:47:40.737Z
Base mainnet, paid with real USDC at https://daff83232a8ffe.lhr.life — 10/10 checks passed
- PASS A1 clock paid 200: pre=402 paid=200 unixTime=1790405263
- PASS A2 clock verified independently: oracle block 51807958 ts=1790405263 | independent RPC ts=1790405263 | delta=0s
- PASS A3 clock block hash matches: oracle hash=0x5fe3dfd9fce16ec8... independent=0x5fe3dfd9fce16ec8...
- PASS A4 consensus advertised: witnessCount=2 consensus=true
- PASS B1 balance paid 200: pre=402 paid=200 raw=3705346
- PASS B2 balance verified independently: oracle=3705346 independent=3705346 decimals=6
- PASS C1 gas paid 200: pre=402 paid=200 baseFeeGwei=0.005
- PASS C2 gas quote plausible: baseFeeGwei=0.005 suggested=7200000
- PASS D1 bad params refused: HTTP 402 body={ "x402Version": 1, "error": "payment_required", "schemes": [ "eip3009" ], "accepts": [ { "schem
- PASS E1 pricing advertises oracle: endpoints=/paid/hash,/paid/uuid,/paid/time,/paid/hashchain,/paid/clock,/paid/block,/paid/gas,/paid/balance,/paid/nonce
Scope: this proves the endpoints work, are paid for with real USDC, and return data independently
verifiable by the buyer. It is my own spend, not external revenue.

