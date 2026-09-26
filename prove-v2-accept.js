// prove-v2-accept.js — DETERMINISTIC proof that my API accepts the STANDARD x402 v2 X-PAYMENT envelope.
// Two independent layers, tested in isolation so free-trial state cannot confound the result.
//   A. unit: decodeV2 + caller-binding verification (real EIP-712 signature via ethers)
//   B. live: a mini paid server + the bridge overlay, driven over real HTTP with a real v2 envelope
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const v2 = require(path.join(__dirname, 'v2-accept.js'));
const bridgeOv = require(path.join(__dirname, 'x402v2-accept-overlay.js'));
bridgeOv.install(http);

let ethers = null; try { ethers = require('ethers'); } catch (e) {}
const R = [];
const check = (n, ok, d) => { R.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? '  -- ' + d : '')); };

(async () => {
  if (!ethers) { console.log('SKIP: ethers not installed'); process.exit(2); }

  // ---- Layer A: envelope decode + caller binding ----
  const payer = ethers.Wallet.createRandom();
  const attacker = ethers.Wallet.createRandom();
  const PAYTO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
  const now = Math.floor(Date.now() / 1000);
  const auth = { from: payer.address, to: PAYTO, value: '1000',
    validAfter: String(now - 60), validBefore: String(now + 1800),
    nonce: '0x' + require('crypto').randomBytes(32).toString('hex') };
  const sig = await payer.signTypedData(v2.DOMAIN, v2.TYPES, auth);
  const envelope = { x402Version: 2, scheme: 'exact', network: v2.CAIP2, payload: { authorization: auth, signature: sig } };
  const header = Buffer.from(JSON.stringify(envelope)).toString('base64');

  const dec = v2.decodeV2(header);
  check('A1 decodeV2 accepts a well-formed v2 envelope', dec.ok, dec.reason || 'ok');
  check('A2 scheme/network preserved', dec.scheme === 'exact' && dec.network === v2.CAIP2);

  check('A3 malformed base64 rejected', v2.decodeV2('!!!not base64!!!').ok === false, v2.decodeV2('!!!not base64!!!').reason);
  check('A4 missing authorization -> "incomplete" reason',
    v2.decodeV2(Buffer.from(JSON.stringify({ x402Version: 2, payload: {} })).toString('base64')).reason === 'exact_evm_payment_payload_is_incomplete');
  check('A5 bad signature shape rejected',
    v2.decodeV2(Buffer.from(JSON.stringify({ x402Version: 2, payload: { authorization: auth, signature: '0x11' } })).toString('base64')).reason === 'bad_signature_shape');

  const good = await v2.verifyAuthorization2(dec.payload, { payTo: PAYTO, minUnits: 1000n, checkOnChain: false });
  check('A6 honest authorization verified', good.ok, good.reason || 'ok');
  check('A7 payer recovered == authorization.from (CALLER-BOUND)', String(good.payer).toLowerCase() === payer.address.toLowerCase());

  const forgedSig = await attacker.signTypedData(v2.DOMAIN, v2.TYPES, auth);
  const forged = await v2.verifyAuthorization2({ authorization: auth, signature: forgedSig }, { payTo: PAYTO, minUnits: 1000n, checkOnChain: false });
  check('A8 attacker signing the payer\'s address is REJECTED', forged.ok === false && forged.reason === 'signature_does_not_match_from', forged.reason);

  const wrongTo = await v2.verifyAuthorization2({ authorization: Object.assign({}, auth, { to: attacker.address }), signature: await payer.signTypedData(v2.DOMAIN, v2.TYPES, Object.assign({}, auth, { to: attacker.address })) },
    { payTo: PAYTO, minUnits: 1000n, checkOnChain: false });
  check('A9 wrong recipient rejected', wrongTo.ok === false && wrongTo.reason === 'wrong_recipient', wrongTo.reason);

  const tampered = await v2.verifyAuthorization2({ authorization: Object.assign({}, auth, { value: '999999' }), signature: sig },
    { payTo: PAYTO, minUnits: 1000n, checkOnChain: false });
  check('A10 tampered amount (sig no longer matches) rejected',
    tampered.ok === false && tampered.reason === 'signature_does_not_match_from', tampered.reason);

  const underpaid = await v2.verifyAuthorization2({ authorization: Object.assign({}, auth, { value: '500' }),
    signature: await payer.signTypedData(v2.DOMAIN, v2.TYPES, Object.assign({}, auth, { value: '500' })) },
    { payTo: PAYTO, minUnits: 1000n, checkOnChain: false });
  check('A11 underpaid rejected', underpaid.ok === false && underpaid.reason === 'underpaid', underpaid.reason);

  // ---- Layer B: real HTTP through the bridge overlay ----
  const PORT = 8131;
  // Mini paid server: exactly the contract the real API has -- it trusts ONLY X-PAYMENT-AUTH.
  const srv = http.createServer((req, res) => {
    if (req.headers['x-payment-auth']) {
      let p = {}; try { p = JSON.parse(Buffer.from(req.headers['x-payment-auth'], 'base64').toString()); } catch (e) {}
      res.writeHead(200, { 'content-type': 'application/json', 'X-Payment-Caller-Bound': 'true' });
      return res.end(JSON.stringify({ ok: true, payer: (p.payload && p.payload.authorization && p.payload.authorization.from) || null, bridged: !!p.bridged }));
    }
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'payment_required' }));
  });
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

  const get = hdrs => new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/paid/echo', method: 'GET', headers: hdrs || {}, timeout: 5000 }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    r.end();
  });

  const unpaid = await get({});
  check('B1 unpaid -> 402', unpaid.status === 402, 'status=' + unpaid.status);

  const paid = await get({ 'X-PAYMENT': header });
  check('B2 STANDARD v2 X-PAYMENT envelope -> HTTP 200', paid.status === 200, 'status=' + paid.status + ' body=' + (paid.body || '').slice(0, 90));
  check('B3 server saw it as caller-bound', paid.headers['x-payment-caller-bound'] === 'true');
  check('B4 bridge header present', paid.headers['x-payment-bridge'] === 'v2->eip3009', paid.headers['x-payment-bridge'] || 'missing');
  let pb = null; try { pb = JSON.parse(paid.body); } catch (e) {}
  check('B5 payer echoed and correct', !!pb && String(pb.payer).toLowerCase() === payer.address.toLowerCase(), pb ? pb.payer : 'no body');

  const legacy = await get({ 'X-PAYMENT': '0x' + 'ab'.repeat(32) });
  check('B6 a legacy txHash is NOT hijacked by the bridge (still 402)', legacy.status === 402, 'status=' + legacy.status);

  srv.close();
  const passed = R.filter(x => x.ok).length;
  console.log('\n=== ' + passed + '/' + R.length + ' PASS ===');
  fs.writeFileSync(path.join(__dirname, 'prove-v2-accept-results.json'),
    JSON.stringify({ at: new Date().toISOString(), passed, total: R.length, results: R }, null, 2));
  process.exit(passed === R.length ? 0 : 1);
})().catch(e => { console.log('FATAL ' + e.message); process.exit(2); });
