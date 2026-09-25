'use strict';
// patch_v5.js — upgrade server.js to v0.5.0 (Merkle batch attestations) in place.
const fs = require('fs');
const P = 'C:/root/value-api/server.js';
let s = fs.readFileSync(P, 'utf8');
const report = [];
function must(cond, msg) { report.push((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) throw new Error('patch anchor failed: ' + msg); }

if (!s.includes("require('./merkle')")) {
  s = s.replace("const { URL } = require('url');", "const { URL } = require('url');\nconst merkle = require('./merkle');");
}
must(s.includes("require('./merkle')"), "require merkle");

s = s.replace("const VERSION = '0.4.0';", "const VERSION = '0.5.0';");
must(s.includes("const VERSION = '0.5.0';"), "version bump");

s = s.replace("const PAID = PAID_UTIL.concat(['/v2/attest']);", "const PAID = PAID_UTIL.concat(['/v2/attest', '/v2/batch']);");
must(s.includes("'/v2/batch']"), "PAID list");

// ---- helpers: insert before the x402 section ----
const HELPERS = `
// ---------- Merkle batch attestations (v0.5.0) ----------
const BATCH_DIR = path.join(__dirname, 'batches');
try { fs.mkdirSync(BATCH_DIR, { recursive: true }); } catch (e) {}
function batchFile(index) { return path.join(BATCH_DIR, index + '.json'); }
function saveBatch(index, items) { try { fs.writeFileSync(batchFile(index), JSON.stringify(items)); } catch (e) {} }
function loadBatch(index) { try { return JSON.parse(fs.readFileSync(batchFile(index), 'utf8')); } catch (e) { return null; } }
function appendBatch(items) {
  const root = merkle.commit(items).root;
  const prev = ledgerTail();
  const ts = new Date().toISOString();
  const hash = crypto.createHash('sha256').update(canonical(prev.hash, ts, root), 'utf8').digest('hex');
  const signature = crypto.sign('sha256', Buffer.from(hash, 'utf8'), signingKey).toString('base64');
  const entry = { index: prev.index + 1, prevHash: prev.hash, timestamp: ts, dataHash: root, hash, signature, keyId, type: 'merkle-batch', count: items.length };
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\\n');
  saveBatch(entry.index, items);
  stats.attestations = (stats.attestations || 0) + 1;
  stats.batches = (stats.batches || 0) + 1;
  saveStats();
  return entry;
}

// ---------- x402 on-chain verification ----------`;
must(s.includes('// ---------- x402 on-chain verification ----------'), "x402 anchor");
s = s.replace('// ---------- x402 on-chain verification ----------', HELPERS.trim());

// ---- routes: insert before the utility-paid block ----
const ROUTES = `  if (p === '/v2/batch') {
    if (!(await authorize(req, res, '/v2/batch'))) return;
    let items = null;
    if (M === 'POST' || M === 'PUT') {
      const raw = await readBody(req, 1024 * 1024);
      if (raw) { try { const j = JSON.parse(raw); if (j && Array.isArray(j.items)) items = j.items; } catch (e) {} }
    }
    if (!items && u.searchParams.get('items')) { try { items = JSON.parse(u.searchParams.get('items')); } catch (e) {} }
    if (!Array.isArray(items) || items.length === 0) return send(res, 400, { error: 'missing_items', hint: 'POST {"items":[...]}, up to 1000 items' }, res._settled);
    if (items.length > 1000) return send(res, 400, { error: 'too_many_items', max: 1000, got: items.length }, res._settled);
    items = items.map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
    const entry = appendBatch(items);
    return send(res, 200, {
      committed: true, entry, root: entry.dataHash, count: entry.count,
      proofUrl: base() + '/v2/proof?index=' + entry.index + '&item=<urlencoded-item>',
      verifyUrl: base() + '/v2/batch/verify?index=' + entry.index + '&item=<urlencoded-item>',
      note: 'The signed root commits to all items. Recompute it independently from your own copy of the items using merkle.js; prove any single item with the proof endpoint or your own tree.'
    }, res._settled);
  }
  if (p === '/v2/proof') {
    const idx = parseInt(u.searchParams.get('index') || '-1', 10);
    const item = u.searchParams.get('item');
    const e = readEntry(idx);
    if (!e || e.type !== 'merkle-batch') return send(res, 404, { error: 'batch_not_found' });
    const items = loadBatch(idx);
    if (!items) return send(res, 404, { error: 'batch_data_unavailable' });
    if (item === null) return send(res, 400, { error: 'missing_item' });
    const norm = String(item);
    const i = items.indexOf(norm);
    if (i < 0) return send(res, 404, { error: 'item_not_in_batch' });
    const c = merkle.commit(items);
    const proof = c.proofs[i];
    return send(res, 200, { index: idx, item: norm, root: e.dataHash, leaf: c.leaves[i], proof, verify: merkle.verifyProof(norm, proof, e.dataHash) });
  }
  if (p === '/v2/batch/verify') {
    const idx = parseInt(u.searchParams.get('index') || '-1', 10);
    const item = u.searchParams.get('item');
    const proofStr = u.searchParams.get('proof');
    const e = readEntry(idx);
    if (!e) return send(res, 404, { error: 'batch_not_found' });
    if (item === null) return send(res, 400, { error: 'missing_item' });
    let proof = null;
    if (proofStr) { try { proof = JSON.parse(proofStr); } catch (err) { return send(res, 400, { error: 'bad_proof_json' }); } }
    else { const items = loadBatch(idx); if (items) { const i = items.indexOf(String(item)); if (i >= 0) proof = merkle.commit(items).proofs[i]; } }
    if (!proof) return send(res, 404, { error: 'proof_unavailable', hint: 'pass ?proof=<json> or use /v2/proof' });
    const vr = merkle.verifyProof(String(item), proof, e.dataHash);
    let chain = false; try { chain = verifyEntry(e).chainIntact === true; } catch (err) {}
    return send(res, vr.valid ? 200 : 409, { included: vr.valid, computedRoot: vr.computedRoot, root: e.dataHash, chainIntact: chain, keyId: e.keyId, entryIndex: e.index });
  }
  if (PAID_UTIL.includes(p)) {`;
must(s.includes('  if (PAID_UTIL.includes(p)) {'), "paid util anchor");
s = s.replace('  if (PAID_UTIL.includes(p)) {', ROUTES);

// discoverability: pricing + free list
s = s.replace(
  "{ path: '/v2/attest', method: 'GET|POST', priceUsdc: PRICE_USDC, params: { data: 'string (or {\"data\":\"...\"})' }, returns: 'signed, hash-chained attestation entry' }",
  "{ path: '/v2/attest', method: 'GET|POST', priceUsdc: PRICE_USDC, params: { data: 'string (or {\"data\":\"...\"})' }, returns: 'signed, hash-chained attestation entry' },\n    { path: '/v2/batch', method: 'POST', priceUsdc: PRICE_USDC, params: { items: 'string[] (max 1000)' }, returns: 'ONE signed merkle root committing all items; free inclusion proofs via /v2/proof' }"
);
s = s.replace(
  "'/v2/pubkey', '/v2/verify', '/v2/ledger', '/'",
  "'/v2/pubkey', '/v2/verify', '/v2/ledger', '/v2/proof', '/v2/batch/verify', '/'"
);

fs.writeFileSync(P, s);
console.log(report.join('\n'));
console.log('patched: v0.5.0 merkle-batch endpoints installed (' + s.length + ' bytes)');
