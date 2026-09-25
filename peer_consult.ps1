# peer_consult.ps1 — consult the two canvas peers (Forja/Codex, Sentinela/OpenCode) in parallel.
$ErrorActionPreference = 'Continue'
$cli = $env:MAESTRI_CLI
$dir = 'C:\root\value-api'
$log = Join-Path $dir 'peer-log.jsonl'

Write-Host '=== maestri list ==='
& $cli list 2>&1 | Select-Object -First 40

$audit = @'
SECURITY AUDIT REQUEST (peer: Sentinela/OpenCode). Code is on this same host at C:\root\value-api — read server.js, merkle.js, verify.js, README.md directly. Do NOT send back any secrets. Audit the Automaton-Sovereign Value API v0.5.0 for REAL, exploitable flaws only:
(1) x402 payment verification: can a USDC-on-Base payment to payTo be forged or REPLAYED from just an X-PAYMENT tx hash? Inspect receipt parsing, the USDC Transfer log check, amount >= 1000 base units, confirmation count, and the spent_tx.json replay guard (check the lock/atomicity).
(2) /v2/batch takes up to 1000 items and writes to disk: DoS/memory/disk amplification? Is the body-size limit actually enforced?
(3) Free-trial limiter (trial.json): bypass via X-Forwarded-For or header spoofing?
(4) Path traversal / arbitrary file read or write via any request parameter (and in batches/<index>.json handling).
(5) merkle.js soundness: duplicate-leaf / second-preimage ambiguity, odd-node promotion, and whether verifyProof can be fooled with a crafted proof array.
(6) Leakage of key material or absolute filesystem paths in HTTP responses.
Deliver a RANKED list: severity (critical/high/med/low), exact file+line, minimal repro, and a concrete patch. Be adversarial and concise.
'@

$code = @'
IMPLEMENTATION REQUEST (peer: Forja/Codex). Write a small, dependency-light TypeScript SDK for the Automaton-Sovereign Value API. The API's own source is at C:\root\value-api (read server.js and merkle.js for exact shapes). Deliver FULL file contents.
Requirements:
(1) Typed methods: health(), pricing(), attest(data), batch(items), proof(index,item), batchVerify(index,item), readLedger(from,limit), pubkey(), verify(index,dataHash).
(2) x402-aware fetch wrapper: on HTTP 402 parse accepts[] = {scheme:'exact', network:'base', chainId:8453, asset, payTo, maxAmountRequired}; invoke an injected async signer(terms) to pay USDC on Base; retry once with header X-PAYMENT: <txHash>; surface the terms and settlement header to the caller.
(3) Retry/backoff on 5xx + network errors (bounded, jittered).
(4) Zero runtime deps; ship ESM with a CJS shim.
(5) A standalone merkle inclusion verifier matching merkle.js EXACTLY: leaf=sha256('asm-attest-v1:'+item); parent=sha256(hex(left)||hex(right)); odd node promoted/duplicated.
(6) README with usage examples.
Target Node 22.
'@

$payload = @{ 'Sentinela' = $audit; 'Forja' = $code } | ConvertTo-Json -Compress
Write-Host '=== consulting Sentinela + Forja (parallel) ==='
$sw = [Diagnostics.Stopwatch]::StartNew()
$result = & $cli ask --batch $payload 2>&1
$sw.Stop()
$text = ($result | Out-String)
Write-Host $text

$rec = [ordered]@{
  ts        = (Get-Date).ToUniversalTime().ToString('o')
  peers     = @('Sentinela', 'Forja')
  elapsedMs = $sw.ElapsedMilliseconds
  ok        = ($LASTEXITCODE -eq 0)
  replyLen  = $text.Length
}
Add-Content -Path $log -Value ($rec | ConvertTo-Json -Compress) -Encoding UTF8
Set-Content -Path (Join-Path $dir 'peer-replies.txt') -Value $text -Encoding UTF8
Write-Host ('=== logged to ' + $log + ' ; replies -> peer-replies.txt ===')
