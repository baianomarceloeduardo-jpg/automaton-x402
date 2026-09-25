'use strict';
// peer_consult.js — consult canvas peers via `maestri ask` using execFile (no shell quoting issues).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = process.env.MAESTRI_CLI;
const DIR = 'C:/root/value-api';
if (!CLI) { console.error('MAESTRI_CLI not set'); process.exit(2); }

const audit = [
  'SECURITY AUDIT REQUEST (peer: Sentinela/OpenCode).',
  'The code is on this same host: read C:\\root\\value-api\\server.js, merkle.js, verify.js, README.md directly.',
  'Do NOT send back any secrets. Audit the Automaton-Sovereign Value API v0.5.0 for REAL, exploitable flaws ONLY:',
  '(1) x402 payment verification: can a USDC-on-Base payment to payTo be forged or REPLAYED from just an X-PAYMENT tx hash?',
  '    Inspect receipt parsing, the USDC Transfer log check, amount >= 1000 base units, confirmation count, and the',
  '    spent_tx.json replay guard (check lock/atomicity under concurrency).',
  '(2) /v2/batch accepts up to 1000 items and writes each batch to disk: DoS / memory / disk amplification?',
  '    Is the request body size limit actually enforced before parsing?',
  '(3) Free-trial limiter (trial.json): bypassable via X-Forwarded-For or header spoofing?',
  '(4) Path traversal / arbitrary file read or write via any request parameter (stock batches/<index>.json handling).',
  '(5) merkle.js soundness: duplicate-leaf / second-preimage ambiguity, odd-node promotion, and whether verifyProof',
  '    can be fooled with a crafted proof array.',
  '(6) Leakage of key material or absolute filesystem paths in HTTP responses.',
  'Deliver a RANKED list: severity (critical/high/medium/low), exact file+line, minimal repro, concrete patch. Be adversarial and concise.'
].join('\n');

const code = [
  'IMPLEMENTATION REQUEST (peer: Forja/Codex).',
  'Write a small, dependency-light TypeScript SDK for the Automaton-Sovereign Value API.',
  'The API source is on this same host: read C:\\root\\value-api\\server.js and merkle.js for exact shapes.',
  'Deliver FULL file contents. Requirements:',
  '(1) Typed methods: health(), pricing(), attest(data), batch(items), proof(index,item), batchVerify(index,item),',
  '    readLedger(from,limit), pubkey(), verify(index,dataHash).',
  "(2) x402-aware fetch wrapper: on HTTP 402 parse accepts[] = {scheme:'exact', network:'base', chainId:8453, asset,",
  '    payTo, maxAmountRequired}; invoke an injected async signer(terms) to pay USDC on Base; retry once with header',
  '    X-PAYMENT: <txHash>; surface the terms + settlement header to the caller.',
  '(3) Bounded, jittered retry/backoff on 5xx and network errors.',
  '(4) Zero runtime deps; ship ESM with a CJS shim.',
  "(5) A standalone merkle inclusion verifier matching merkle.js EXACTLY: leaf = sha256('asm-attest-v1:' + item);",
  '    parent = sha256(hex(left) || hex(right)); odd node promoted/duplicated.',
  '(6) README with usage examples. Target Node 22.'
].join('\n');

function run(args, label) {
  return new Promise((resolve) => {
    execFile(CLI, args, { maxBuffer: 32 * 1024 * 1024, timeout: 900000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ label, ok: !err, err: err ? String(err.message) : null, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

(async () => {
  // sanity: who is connected
  const list = await run(['list'], 'list');
  console.log('=== maestri list ===\n' + list.stdout.slice(0, 1200));

  const payload = JSON.stringify({ Sentinela: audit, Forja: code });
  console.log('=== consulting Sentinela + Forja in parallel (this may take several minutes) ===');
  const t0 = Date.now();
  const res = await run(['ask', '--batch', payload], 'batch');
  const el = Date.now() - t0;

  const out = [];
  out.push('exit_ok=' + res.ok + ' elapsedMs=' + el);
  if (res.stderr) out.push('stderr: ' + res.stderr.slice(0, 500));
  out.push('--- stdout ---');
  out.push(res.stdout);

  const text = out.join('\n');
  fs.writeFileSync(path.join(DIR, 'peer-replies.txt'), text, 'utf8');
  fs.appendFileSync(path.join(DIR, 'peer-log.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), peers: ['Sentinela', 'Forja'], ok: res.ok, elapsedMs: el, replyChars: res.stdout.length }) + '\n');

  console.log('=== result summary ===');
  console.log('ok=' + res.ok + ' elapsedMs=' + el + ' replyChars=' + res.stdout.length);
  console.log('wrote peer-replies.txt');
  // show a readable tail
  console.log(res.stdout.slice(0, 6000));
})();
