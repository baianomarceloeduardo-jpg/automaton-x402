#!/usr/bin/env node
'use strict';
/**
 * Offline verifier for the Automaton-Sovereign attestation ledger.
 *
 * No network, no trust in the server required. Given the ledger file and the
 * published public key, this recomputes every hash, checks every signature, and
 * walks the chain. Any tampering (edited timestamp, swapped data, reordered or
 * removed entry) breaks verification.
 *
 * Usage:
 *   node verify.js ledger.jsonl
 *   node verify.js ledger.jsonl pubkey.pem
 *   node verify.js --self            # fetch pubkey + ledger from live server
 */
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

function canonical(prevHash, ts, dataHash) { return prevHash + '|' + ts + '|' + dataHash; }
function expectedHash(e) { return crypto.createHash('sha256').update(canonical(e.prevHash, e.timestamp, e.dataHash), 'utf8').digest('hex'); }

function verifyChain(entries, publicKeyPem) {
  const results = [];
  let prevHash = '0'.repeat(64);
  let allOk = true;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], problems = [];
    if (e.index !== i) problems.push('index_out_of_order');
    if (e.prevHash !== prevHash) problems.push('prevHash_mismatch');
    const eh = expectedHash(e);
    if (eh !== e.hash) problems.push('hash_mismatch');
    let sigOk = false;
    try { sigOk = crypto.verify('sha256', Buffer.from(e.hash, 'utf8'), publicKeyPem, Buffer.from(e.signature, 'base64')); } catch (err) {}
    if (!sigOk) problems.push('bad_signature');
    if (problems.length) allOk = false;
    results.push({ index: e.index, ok: problems.length === 0, problems, hash: e.hash, timestamp: e.timestamp });
    prevHash = e.hash;
  }
  return { allOk, length: entries.length, results };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const lib = u.protocol === 'http:' ? http : https;
    lib.get(u, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }).on('error', reject);
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    let entriesText, pubPem;
    if (args[0] === '--self') {
      const base = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
      pubPem = JSON.parse(await fetchText(base + '/v2/pubkey')).publicKeyPem;
      const led = JSON.parse(await fetchText(base + '/v2/ledger?limit=200'));
      entriesText = led.entries.map(e => JSON.stringify(e)).join('\n');
    } else {
      if (!args[0]) { console.log('usage: node verify.js <ledger.jsonl> [pubkey.pem] | --self'); process.exit(1); }
      entriesText = fs.readFileSync(args[0], 'utf8');
      pubPem = args[1] ? fs.readFileSync(args[1], 'utf8')
        : (fs.existsSync('pubkey.pem') ? fs.readFileSync('pubkey.pem', 'utf8') : null);
      if (!pubPem) { console.error('No public key. Pass a path or drop pubkey.pem in cwd.'); process.exit(1); }
    }
    const entries = entriesText.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const r = verifyChain(entries, pubPem);
    console.log('entries: ' + r.length);
    console.log('ALL VALID: ' + r.allOk);
    for (const e of r.results) console.log('  #' + e.index + ' ' + (e.ok ? 'OK' : 'FAIL[' + e.problems.join(',') + ']') + ' ' + e.timestamp);
    process.exit(r.allOk ? 0 : 1);
  })().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
}

module.exports = { verifyChain, expectedHash, canonical };
